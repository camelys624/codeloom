import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiAdapter } from '../src/pi.js';
import type { AgentSessionHandle } from '@agent-workspace/contracts';

const input = (cwd: string) => ({
  attemptId: 'att_pi_test',
  cwd,
  launch: { kind: 'managed' as const },
  env: { PATH: process.env.PATH ?? '/usr/bin', HOME: cwd },
  runConfig: {
    agentProfileId: 'agp_pi_test',
    permissionMode: 'ask' as const,
    toolPolicy: {
      filesystem: 'worktree_only' as const,
      network: 'none' as const,
      shell: 'ask' as const,
      gitPush: false,
    },
    idleTimeoutMinutes: 5,
    maxTurnMinutes: 1,
  },
  onFrame: () => undefined,
  onPermissionRequest: async () => ({ decision: 'deny' as const }),
  clock: {
    now: () => new Date(),
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) =>
      clearTimeout(handle),
  },
});

describe('Pi RPC interoperability', () => {
  let cwd: string | undefined;
  let session: AgentSessionHandle | undefined;

  afterEach(async () => {
    await session?.close();
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  it('starts the installed Pi RPC process and accepts a prompt when provider auth is available', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'aw-pi-rpc-'));
    const adapter = new PiAdapter({ command: 'pi' });
    session = await adapter.startSession(input(cwd));
    expect(session).toBeDefined();
    expect(
      (session as { capabilities?: { protocol: string } }).capabilities,
    ).toMatchObject({
      protocol: 'rpc',
    });
  }, 15_000);
});
