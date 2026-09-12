import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  RunConfigSchema,
  systemClock,
  type PermissionRequest,
  type StartSessionInput,
  type TranscriptFrame,
} from '@agent-workspace/contracts';
import type { TurnResult } from '@agent-workspace/contracts';
import { ClaudeCodeAdapter, type ClaudeCodeSession } from './claude-code.js';
import { engineEnvironment, Redactor } from './redaction.js';
import { processIsAlive, type ProcessIdentity } from './process.js';

const exec = promisify(execFile);
const MarkerSchema = z.object({
  pid: z.number().int().positive(),
  childPid: z.number().int().positive(),
});
const PermissionPayloadSchema = z.object({
  toolCall: z.object({ rawInput: z.object({ command: z.string() }) }),
});

async function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function waitForMarker(
  path: string,
  turn: Promise<unknown>,
): Promise<z.infer<typeof MarkerSchema>> {
  let settled = false;
  void turn
    .finally(() => {
      settled = true;
    })
    .catch(() => {});
  const deadline = Date.now() + 120_000;
  while (!(await exists(path))) {
    assert(
      !settled,
      'Real Turn ended before starting the requested long-running process',
    );
    assert(Date.now() < deadline, 'Timed out waiting for real tool execution');
    await delay(50);
  }
  return MarkerSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

async function assertClean(identities: ProcessIdentity[]): Promise<void> {
  assert(
    identities.length > 1,
    'Cleanup check must include actual engine/tool descendants',
  );
  const remaining = await Promise.all(identities.map(processIsAlive));
  assert(
    !remaining.some(Boolean),
    'An agent or tool descendant survived cleanup',
  );
}

async function main(): Promise<void> {
  assert.equal(
    Number(process.versions.node.split('.')[0]),
    22,
    'Spike must run with Node.js 22',
  );
  assert.equal(
    process.platform,
    'linux',
    'Spike currently requires Linux /proc process supervision',
  );
  const env = engineEnvironment('claude-code', process.env);
  assert(env.HOME, 'HOME is required for existing Claude authentication');
  assert(env.PATH, 'PATH is required for the Claude engine');
  const checkout = await realpath(process.cwd());
  const root = await mkdtemp(join(tmpdir(), 'agent-workspace-acp-gate-'));
  const fromCheckout = relative(checkout, await realpath(root));
  assert(
    isAbsolute(fromCheckout) ||
      fromCheckout === '..' ||
      fromCheckout.startsWith(`..${sep}`),
    'Spike repository must be outside the user checkout',
  );
  const adapter = new ClaudeCodeAdapter({ allowedRoots: [root] });
  const redactor = new Redactor(env);
  let session: ClaudeCodeSession | undefined;
  let expectedCommand: string | undefined;
  let expectedMarker: string | undefined;
  let permissions = 0;
  let output = '';
  const nonce = randomBytes(12).toString('hex');
  const started = Date.now();
  const onFrame = (frame: TranscriptFrame) => {
    if (frame.t === 'text_delta') {
      output += frame.text;
      process.stdout.write(frame.text);
    } else if (frame.t === 'warning')
      process.stderr.write(`[${frame.code}] ${frame.message}\n`);
  };
  const onPermissionRequest = async (request: PermissionRequest) => {
    const payload = PermissionPayloadSchema.safeParse(request.payload);
    assert(
      payload.success &&
        expectedCommand &&
        payload.data.toolCall.rawInput.command === expectedCommand,
      'Spike only approves its exact, locally-created deterministic command; unexpected permission request',
    );
    assert(
      expectedMarker && !(await exists(expectedMarker)),
      'Tool side effect occurred before its real permission decision',
    );
    permissions++;
    process.stdout.write(
      'ACP permission received; approving this exact spike command once.\n',
    );
    return { decision: 'allow' as const };
  };
  try {
    await exec('git', ['init', '--quiet', root], {
      cwd: root,
      env,
      timeout: 10_000,
    });
    await exec(
      'git',
      [
        '-c',
        'user.name=ACP Spike',
        '-c',
        'user.email=acp-spike@localhost',
        'commit',
        '--quiet',
        '--allow-empty',
        '-m',
        'Temporary ACP gate repository',
      ],
      { cwd: root, env, timeout: 10_000 },
    );
    const capabilities = await adapter.probe({
      launch: { kind: 'managed' },
      env,
    });
    assert(
      capabilities.supports.permissionRequests && capabilities.supports.cancel,
      'Bridge lacks mandatory capabilities',
    );
    const model = process.env.SPIKE_MODEL ?? capabilities.models[0];
    assert(
      model && capabilities.models.includes(model),
      'SPIKE_MODEL must be advertised by the real bridge',
    );
    const runConfig = RunConfigSchema.parse({
      agentProfileId: randomUUID(),
      model,
      permissionMode: 'ask',
      toolPolicy: {
        filesystem: 'worktree_only',
        network: 'unrestricted',
        shell: 'ask',
        gitPush: false,
      },
      reasoningEffort: 'low',
      idleTimeoutMinutes: 5,
      maxTurnMinutes: 3,
    });
    const input: StartSessionInput = {
      attemptId: randomUUID(),
      cwd: root,
      launch: { kind: 'managed' },
      env,
      runConfig,
      clock: systemClock,
      onFrame,
      onPermissionRequest,
    };
    session = await adapter.startSession(input);
    process.stdout.write(
      `ACP bridge ${capabilities.engineVersion}; model ${redactor.text(model)}; starting real ten-Turn gate.\n`,
    );
    for (let turn = 1; turn <= 10; turn++) {
      output = '';
      const prompt =
        turn === 1
          ? `Remember the conversation verification code ${nonce}. Do not use any tools. Reply with exactly ${nonce}:1 and nothing else.`
          : `Do not use any tools. Recall the conversation verification code I gave you in the first message. Reply with exactly that code followed by :${turn}, and nothing else. Do not guess or invent a new code.`;
      const result: TurnResult = await session.prompt({
        turnId: randomUUID(),
        text: prompt,
        signal: new AbortController().signal,
      });
      assert.equal(
        result.stopReason,
        'end_turn',
        `Real Turn ${turn} failed: ${result.error?.message ?? result.stopReason}`,
      );
      assert.equal(
        output.trim(),
        `${nonce}:${turn}`,
        `Conversation state was not preserved on Turn ${turn}`,
      );
      assert.equal(
        permissions,
        0,
        'Conversation-only Turns must not request tools',
      );
      process.stdout.write(`\nTurn ${turn}/10 verified.\n`);
    }

    const approvedMarker = join(root, 'approved.txt');
    const permissionScript = join(root, 'permission.cjs');
    await writeFile(
      permissionScript,
      `require('node:fs').writeFileSync(${JSON.stringify(approvedMarker)}, 'approved-after-roundtrip');\n`,
      { mode: 0o600 },
    );
    expectedCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(permissionScript)}`;
    expectedMarker = approvedMarker;
    const permissionResult = await session.prompt({
      turnId: randomUUID(),
      text: `Use the Bash tool to run this exact command once, without edits, wrappers, or other tools: ${expectedCommand}\nDo not write the marker by any other means. Wait for approval. Then briefly report completion.`,
      signal: new AbortController().signal,
    });
    assert.equal(
      permissionResult.stopReason,
      'end_turn',
      'Permission Turn failed',
    );
    assert.equal(
      permissions,
      1,
      'Real permission roundtrip did not occur exactly once',
    );
    assert.equal(
      await readFile(approvedMarker, 'utf8'),
      'approved-after-roundtrip',
      'Approved command did not execute',
    );
    process.stdout.write(
      'Real permission roundtrip and post-approval side effect verified.\n',
    );

    const longScript = join(root, 'long-running.cjs');
    await writeFile(
      longScript,
      "const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); child.unref(); fs.writeFileSync(process.argv[2], JSON.stringify({pid:process.pid,childPid:child.pid})); setInterval(()=>{},1000);\n",
      { mode: 0o600 },
    );
    const cancelMarker = join(root, 'cancel-pids.json');
    expectedMarker = cancelMarker;
    expectedCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(longScript)} ${JSON.stringify(cancelMarker)}`;
    const controller = new AbortController();
    const cancelTurn = session.prompt({
      turnId: randomUUID(),
      text: `Use Bash to execute this exact command in the foreground (do not set run_in_background), without wrapping or changing it: ${expectedCommand}\nThis is a cancellation test; wait for it to finish, do not stop it yourself.`,
      signal: controller.signal,
    });
    void cancelTurn.catch(() => {});
    const cancelPids = await waitForMarker(cancelMarker, cancelTurn);
    await delay(250);
    const cancelProcesses = await session.snapshotProcesses();
    assert(
      cancelProcesses.some((p) => p.pid === cancelPids.pid) &&
        cancelProcesses.some((p) => p.pid === cancelPids.childPid),
      'Supervisor did not track real tool and detached descendant',
    );
    const cancelStarted = Date.now();
    controller.abort();
    const canceled = await cancelTurn;
    await session.close();
    assert.equal(
      canceled.stopReason,
      'canceled',
      'Canceled real Turn did not report cancellation',
    );
    assert(
      session.cancellationAcknowledged,
      'Bridge never acknowledged ACP cancellation; forced kill alone is not a gate pass',
    );
    assert(
      Date.now() - cancelStarted <= 20_000,
      'Cancellation exceeded 20 seconds',
    );
    await assertClean(cancelProcesses);
    assert.equal(
      permissions,
      2,
      'Cancellation tool was not independently approved',
    );
    process.stdout.write(
      'Real ACP cancellation acknowledged; process group and detached tool descendant cleaned within 20 seconds.\n',
    );

    session = await adapter.startSession({ ...input, attemptId: randomUUID() });
    const exitMarker = join(root, 'exit-pids.json');
    expectedMarker = exitMarker;
    expectedCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(longScript)} ${JSON.stringify(exitMarker)}`;
    const interrupted = session.prompt({
      turnId: randomUUID(),
      text: `Use Bash to execute this exact command in the foreground (do not set run_in_background), without changing it: ${expectedCommand}\nWait for it to finish; do not stop it yourself.`,
      signal: new AbortController().signal,
    });
    void interrupted.catch(() => {});
    const exitPids = await waitForMarker(exitMarker, interrupted);
    await delay(250);
    const exitProcesses = await session.snapshotProcesses();
    assert(
      exitProcesses.some((p) => p.pid === exitPids.childPid),
      'Post-exit check lacks real detached descendant',
    );
    const exitStarted = Date.now();
    assert(
      session.process.child.kill('SIGTERM'),
      'Could not terminate the known bridge process',
    );
    const exitedTurn = await interrupted;
    assert.equal(
      exitedTurn.stopReason,
      'error',
      'Unexpected bridge exit must be reported as an error',
    );
    await session.close();
    assert(
      Date.now() - exitStarted <= 20_000,
      'Post-exit cleanup exceeded 20 seconds',
    );
    await assertClean(exitProcesses);
    assert.equal(
      permissions,
      3,
      'Post-exit tool was not independently approved',
    );
    process.stdout.write(
      JSON.stringify({
        gate: 'passed',
        protocol: 'acp',
        bridgeVersion: capabilities.engineVersion,
        consecutiveTurns: 10,
        realPermissions: permissions,
        cancellationAcknowledged: true,
        detachedDescendantsCleaned: true,
        unexpectedExitCleanup: true,
        elapsedMs: Date.now() - started,
      }) + '\n',
    );
  } finally {
    try {
      await session?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

void main().catch((error) => {
  // Do not print raw provider error objects, environment, protocol messages, or stack traces.
  const redactor = new Redactor(process.env);
  process.stderr.write(
    `ACP GATE FAILED: ${redactor.text(error instanceof Error ? error.message : 'Unknown failure')}\n`,
  );
  process.exitCode = 1;
});
