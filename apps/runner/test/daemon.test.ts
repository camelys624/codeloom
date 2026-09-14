import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PermissionDecision } from '@agent-workspace/contracts';
import { createWorktree, git } from '@agent-workspace/git-worktree';
import { RunnerDaemon } from '../src/daemon.js';
import { runnerFiles, type RunnerFiles } from '../src/config.js';

type TestAttempt = {
  attemptId: string;
  baseCommitSha: string;
  branchName: string;
  nextClientSeq: number;
  nextChunkSeq: number;
  nextTurnNumber: number;
  worktreePath: string;
  stop: boolean;
  terminalSent: boolean;
  restarted: boolean;
  approvalResolvers: Map<string, (decision: PermissionDecision) => void>;
  session: { close: () => Promise<void> };
};

type TestDaemon = {
  active: Map<string, TestAttempt>;
  profiles: Map<string, unknown>;
  receive(raw: string): Promise<void>;
  refreshProfiles(): Promise<void>;
};

describe('RunnerDaemon control messages', () => {
  let root: string | undefined;
  let repository: string | undefined;

  afterEach(async () => {
    if (repository) {
      await git(repository, ['worktree', 'prune']).catch(() => undefined);
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('completes an Attempt when the server sends attempt.close', async () => {
    root = await mkdtemp(join(tmpdir(), 'aw-runner-close-'));
    repository = join(root, 'checkout');
    await mkdir(repository, { recursive: true });
    await git(repository, ['init', '--initial-branch=main']);
    await git(repository, ['config', 'user.email', 'runner@test.invalid']);
    await git(repository, ['config', 'user.name', 'Runner Test']);
    await writeFile(join(repository, 'README.txt'), 'base\n');
    await git(repository, ['add', '--all']);
    await git(repository, ['commit', '-m', 'base']);
    const baseCommitSha = (
      await git(repository, ['rev-parse', 'HEAD'])
    ).stdout.trim();
    const files: RunnerFiles = runnerFiles(join(root, 'runner'));
    const worktree = await createWorktree({
      checkoutPath: repository,
      worktreeRoot: files.worktrees,
      attemptId: 'att_close',
      branchName: 'aw/run-close/a1',
      baseCommitSha,
    });
    const daemon = new RunnerDaemon({
      credentials: {
        server: 'http://127.0.0.1:1',
        runnerId: 'rnr_test',
        workspaceId: 'ws_test',
        runnerToken: 'token_test',
        name: 'test runner',
        daemonVersion: 'test',
      },
      files,
    });
    const internal = daemon as unknown as TestDaemon;
    let sessionClosed = false;
    internal.active.set('att_close', {
      attemptId: 'att_close',
      baseCommitSha,
      branchName: 'aw/run-close/a1',
      nextClientSeq: 1,
      nextChunkSeq: 1,
      nextTurnNumber: 1,
      worktreePath: worktree.path,
      stop: false,
      terminalSent: false,
      restarted: false,
      stale: false,
      approvalResolvers: new Map(),
      session: {
        close: async () => {
          sessionClosed = true;
        },
      },
    });

    await internal.receive(
      JSON.stringify({
        type: 'attempt.close',
        attemptId: 'att_close',
        reason: 'user',
      }),
    );

    const messages = (await readFile(files.outbox, 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as { type: string; event?: { type: string } },
      );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'attempt.event',
      event: { type: 'attempt.completed' },
    });
    expect(sessionClosed).toBe(true);
    expect(internal.active.get('att_close')?.terminalSent).toBe(true);
  });
});
