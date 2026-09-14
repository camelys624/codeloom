import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  RunConfigSchema,
  type PermissionDecision,
  type PermissionRequest,
  type StartSessionInput,
  type TranscriptFrame,
} from '@agent-workspace/contracts';
import { PiAdapter } from './pi.js';
import { engineEnvironment } from './redaction.js';
import { processIsAlive, type ProcessIdentity } from './process.js';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!predicate(value)) {
    assert(Date.now() < deadline, 'Pi gate timed out');
    await sleep(100);
    value = await read();
  }
  return value;
}

function textFrames(frames: readonly TranscriptFrame[]): string {
  return frames
    .filter(
      (frame): frame is Extract<TranscriptFrame, { t: 'text_delta' }> =>
        frame.t === 'text_delta',
    )
    .map((frame) => frame.text)
    .join('');
}

async function main(): Promise<void> {
  assert.equal(
    process.platform,
    'linux',
    'Pi gate currently requires Linux /proc supervision',
  );

  const cwd = await mkdtemp(join(tmpdir(), 'aw-pi-gate-'));
  const approved = join(cwd, 'approved.txt');
  const permissionScript = join(cwd, 'write-approved.cjs');
  const longScript = join(cwd, 'long-running.cjs');
  const cancelMarker = join(cwd, 'cancel-pids.json');
  await writeFile(
    permissionScript,
    `require('node:fs').writeFileSync(${JSON.stringify(approved)}, 'approved');\n`,
    { mode: 0o600 },
  );
  await writeFile(
    longScript,
    "const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); child.unref(); fs.writeFileSync(process.argv[2], JSON.stringify({pid:process.pid,childPid:child.pid})); setInterval(()=>{},1000);\n",
    { mode: 0o600 },
  );

  const frames: TranscriptFrame[] = [];
  const permissions: PermissionRequest[] = [];
  const pendingPermission = Promise.withResolvers<PermissionDecision>();
  const input: StartSessionInput = {
    attemptId: `att_${randomUUID()}`,
    cwd,
    launch: { kind: 'managed' },
    env: engineEnvironment('pi', process.env),
    runConfig: RunConfigSchema.parse({
      agentProfileId: 'agp_pi_gate',
      permissionMode: 'ask',
      toolPolicy: {
        filesystem: 'worktree_only',
        network: 'none',
        shell: 'ask',
        gitPush: false,
      },
      idleTimeoutMinutes: 5,
      maxTurnMinutes: 2,
    }),
    onFrame: (frame) => frames.push(frame),
    onPermissionRequest: async (request) => {
      permissions.push(request);
      if (permissions.length === 1) return pendingPermission.promise;
      return { decision: 'allow' };
    },
    clock: {
      now: () => new Date(),
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle),
    },
  };

  const session = await new PiAdapter({ command: 'pi' }).startSession(input);
  try {
    for (let turn = 1; turn <= 10; turn++) {
      frames.length = 0;
      const result = await session.prompt({
        turnId: `trn_gate_${turn}`,
        text:
          turn === 1
            ? 'Remember the verification word: codeloom-gate. Reply with exactly codeloom-gate:1 and nothing else. Do not use tools.'
            : `Recall the verification word from the first turn. Reply with exactly codeloom-gate:${turn} and nothing else. Do not use tools.`,
        signal: new AbortController().signal,
      });
      assert.equal(result.stopReason, 'end_turn', `Pi Turn ${turn} failed`);
      assert.match(
        textFrames(frames),
        new RegExp(`codeloom-gate:${turn}`),
        `Pi context failed on Turn ${turn}`,
      );
      process.stdout.write(`Pi Turn ${turn}/10 passed\n`);
    }

    frames.length = 0;
    const permissionCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(permissionScript)}`;
    const permissionTurn = session.prompt({
      turnId: 'trn_gate_permission',
      text: `Use bash to execute exactly: ${permissionCommand}. Wait for permission and then report done.`,
      signal: new AbortController().signal,
    });
    await waitFor(
      () => permissions.length,
      (count) => count === 1,
      30_000,
    );
    assert.equal(
      await readFile(approved, 'utf8').catch(() => ''),
      '',
      'Permission side effect happened before approval',
    );
    pendingPermission.resolve({ decision: 'allow' });
    const permissionResult = await permissionTurn;
    assert.equal(permissionResult.stopReason, 'end_turn');
    assert.equal(await readFile(approved, 'utf8'), 'approved');
    process.stdout.write('Pi permission roundtrip passed\n');

    const cancelCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(longScript)} ${JSON.stringify(cancelMarker)}`;
    const controller = new AbortController();
    const cancelTurn = session.prompt({
      turnId: 'trn_gate_cancel',
      text: `Use bash to execute this exact foreground command and wait: ${cancelCommand}. Do not stop it yourself.`,
      signal: controller.signal,
    });
    const marker = await waitFor(
      () =>
        readFile(cancelMarker, 'utf8')
          .then(JSON.parse)
          .catch(() => undefined),
      (value): value is { pid: number; childPid: number } =>
        Boolean(
          value &&
          Number.isInteger(value.pid) &&
          Number.isInteger(value.childPid),
        ),
      30_000,
    );
    const identities = await waitFor(
      () => session.process.snapshot(),
      (value) =>
        value.some((item) => item.pid === marker.pid) &&
        value.some((item) => item.pid === marker.childPid),
      10_000,
    );
    const started = Date.now();
    controller.abort();
    const canceled = await cancelTurn;
    assert.equal(canceled.stopReason, 'canceled');
    assert(
      Date.now() - started <= 20_000,
      'Pi cancellation exceeded 20 seconds',
    );
    await session.close();
    const alive = await Promise.all(identities.map(processIsAlive));
    assert(!alive.some(Boolean), 'A Pi or tool descendant survived cleanup');
    process.stdout.write('Pi cancellation and process cleanup passed\n');
  } finally {
    await session.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

await main();
