import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import type { Clock } from '@agent-workspace/contracts';

export type ProcessIdentity = {
  pid: number;
  ppid: number;
  group: number;
  started: string;
  state: string;
};

async function identity(pid: number): Promise<ProcessIdentity | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return {
      pid,
      ppid: Number(fields[1]),
      group: Number(fields[2]),
      started: fields[19]!,
      state: fields[0]!,
    };
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' ||
      (error as NodeJS.ErrnoException).code === 'ESRCH'
    )
      return undefined;
    throw new Error('Unable to inspect agent process identity');
  }
}

export async function processIsAlive(
  processIdentity: ProcessIdentity,
): Promise<boolean> {
  const current = await identity(processIdentity.pid);
  return (
    current !== undefined &&
    current.started === processIdentity.started &&
    current.state !== 'Z' &&
    current.state !== 'X'
  );
}

export class AgentProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  private readonly known = new Map<number, ProcessIdentity>();
  private timer?: ReturnType<typeof setTimeout>;
  private closing?: Promise<void>;
  private monitorFailure?: Error;
  private scan?: Promise<void>;

  constructor(
    command: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
    private readonly clock: Clock,
  ) {
    if (process.platform !== 'linux')
      throw new Error(
        'Claude ACP process-tree supervision currently requires Linux /proc',
      );
    this.child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exited = new Promise((resolve) => {
      this.child.once('exit', () => resolve());
      this.child.once('error', () => resolve());
    });
    // A spawn error also rejects RPC requests through the pipe close; never leave an unhandled error event.
    this.child.on('error', () => {});
    this.scheduleScan();
    void this.exited.then(() => this.close()).catch(() => {});
  }

  async snapshot(): Promise<ProcessIdentity[]> {
    await this.capture();
    return [...this.known.values()];
  }

  private scheduleScan(): void {
    this.timer = this.clock.setTimeout(() => {
      void this.capture()
        .catch(() => {
          this.monitorFailure = new Error('Agent descendant monitoring failed');
          void this.close().catch(() => {});
        })
        .finally(() => {
          if (!this.closing) this.scheduleScan();
        });
    }, 100);
  }

  private capture(): Promise<void> {
    if (this.scan) return this.scan;
    this.scan = this.captureNow().finally(() => {
      this.scan = undefined;
    });
    return this.scan;
  }

  private async captureNow(): Promise<void> {
    const pid = this.child.pid;
    if (!pid) return;
    const entries = await readdir('/proc');
    const processes = (
      await Promise.all(
        entries
          .filter((name) => /^\d+$/.test(name))
          .map((name) => identity(Number(name))),
      )
    ).filter((entry): entry is ProcessIdentity => entry !== undefined);
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of processes) {
        if (this.known.get(entry.pid)?.started === entry.started) continue;
        const parent = this.known.get(entry.ppid);
        const parentStillMatches =
          parent &&
          processes.some(
            (p) => p.pid === parent.pid && p.started === parent.started,
          );
        if (entry.pid === pid || entry.group === pid || parentStillMatches) {
          this.known.set(entry.pid, entry);
          changed = true;
        }
      }
    }
  }

  private async signal(signal: NodeJS.Signals): Promise<void> {
    await this.capture();
    // Signal the private group as well as tracked detached descendants. Verify identities before individual signals.
    const pid = this.child.pid;
    if (pid) {
      try {
        process.kill(-pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          throw new Error('Unable to signal agent process group');
      }
    }
    for (const entry of this.known.values()) {
      if (!(await processIsAlive(entry))) continue;
      try {
        process.kill(entry.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          throw new Error('Unable to signal agent descendant');
      }
    }
  }

  close(): Promise<void> {
    this.closing ??= this.stop();
    return this.closing;
  }

  private async stop(): Promise<void> {
    if (this.timer) this.clock.clearTimeout(this.timer);
    const start = this.clock.now().getTime();
    await this.signal('SIGTERM');
    while (true) {
      await this.capture();
      const alive = await Promise.all(
        [...this.known.values()].map(processIsAlive),
      );
      if (!alive.some(Boolean)) break;
      const elapsed = this.clock.now().getTime() - start;
      if (elapsed >= 2_000) await this.signal('SIGKILL');
      if (elapsed >= 12_000)
        throw new Error(
          'Agent process tree remained alive after cleanup deadline',
        );
      await new Promise<void>((resolve) => this.clock.setTimeout(resolve, 50));
    }
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    if (this.monitorFailure) throw this.monitorFailure;
  }
}
