import { access, mkdir, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { isAbsolute, join, relative, sep } from 'node:path';

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface WorktreeHandle {
  path: string;
  branchName: string;
  baseCommitSha: string;
}

export interface CreateWorktreeInput {
  checkoutPath: string;
  worktreeRoot: string;
  attemptId: string;
  branchName: string;
  baseCommitSha: string;
}

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function runGit(args: readonly string[], cwd: string): Promise<GitResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn('git', args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputSize = 0;
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputSize += chunk.byteLength;
      if (outputSize <= MAX_OUTPUT_BYTES) target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', reject);
    child.once('close', (code) =>
      resolveResult({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code: code ?? 1,
      }),
    );
  });
}

function assertInside(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`))
    throw new Error('Worktree path is outside the allowed root');
}

export async function git(
  checkoutPath: string,
  args: readonly string[],
): Promise<GitResult> {
  return runGit(args, checkoutPath);
}

export async function createWorktree(
  input: CreateWorktreeInput,
): Promise<WorktreeHandle> {
  const checkoutPath = await realpath(input.checkoutPath);
  await mkdir(input.worktreeRoot, { recursive: true, mode: 0o700 });
  const worktreeRoot = await realpath(input.worktreeRoot).catch(async () => {
    await mkdir(input.worktreeRoot, { recursive: true, mode: 0o700 });
    return realpath(input.worktreeRoot);
  });
  const path = join(worktreeRoot, input.attemptId);
  assertInside(worktreeRoot, path);
  const result = await runGit(
    ['worktree', 'add', '--detach', path, input.baseCommitSha],
    checkoutPath,
  );
  if (result.code !== 0)
    throw new Error(
      `git worktree add failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  const branch = await runGit(['switch', '-c', input.branchName], path);
  if (branch.code !== 0)
    throw new Error(
      `git switch failed: ${branch.stderr.trim() || branch.stdout.trim()}`,
    );
  return {
    path,
    branchName: input.branchName,
    baseCommitSha: input.baseCommitSha,
  };
}

export async function ensureWorktree(
  input: CreateWorktreeInput,
): Promise<WorktreeHandle> {
  const root = await realpath(input.worktreeRoot).catch(() => undefined);
  const path = root
    ? join(root, input.attemptId)
    : join(input.worktreeRoot, input.attemptId);
  if (root) {
    try {
      await access(path);
      return {
        path,
        branchName: input.branchName,
        baseCommitSha: input.baseCommitSha,
      };
    } catch {
      // Create it below.
    }
  }
  return createWorktree(input);
}

export async function resolveCommit(
  checkoutPath: string,
  ref: string,
): Promise<string> {
  const result = await runGit(
    ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    checkoutPath,
  );
  if (result.code !== 0)
    throw new Error(
      `git rev-parse ${ref} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  const commitSha = result.stdout.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commitSha))
    throw new Error(`git rev-parse ${ref} returned an invalid commit SHA`);
  return commitSha;
}

export async function commitAll(
  worktreePath: string,
  message: string,
): Promise<string> {
  const add = await runGit(['add', '--all'], worktreePath);
  if (add.code !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`);
  const commit = await runGit(
    ['commit', '--no-verify', '-m', message],
    worktreePath,
  );
  if (
    commit.code !== 0 &&
    !/nothing to commit/i.test(commit.stdout + commit.stderr)
  )
    throw new Error(`git commit failed: ${commit.stderr.trim()}`);
  const head = await runGit(['rev-parse', 'HEAD'], worktreePath);
  if (head.code !== 0)
    throw new Error(`git rev-parse failed: ${head.stderr.trim()}`);
  return head.stdout.trim();
}

export async function removeWorktree(
  checkoutPath: string,
  worktreePath: string,
): Promise<boolean> {
  try {
    await access(worktreePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const result = await runGit(
    ['worktree', 'remove', '--', worktreePath],
    checkoutPath,
  );
  if (result.code !== 0)
    throw new Error(
      `git worktree remove failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  return true;
}

export async function unifiedDiff(
  worktreePath: string,
  baseCommitSha: string,
): Promise<string> {
  const result = await runGit(
    ['diff', '--binary', `${baseCommitSha}..HEAD`],
    worktreePath,
  );
  if (result.code !== 0)
    throw new Error(`git diff failed: ${result.stderr.trim()}`);
  return result.stdout;
}

export async function diffStats(
  worktreePath: string,
  baseCommitSha: string,
): Promise<{ files: number; additions: number; deletions: number }> {
  const result = await runGit(
    ['diff', '--numstat', `${baseCommitSha}..HEAD`],
    worktreePath,
  );
  if (result.code !== 0)
    throw new Error(`git diff failed: ${result.stderr.trim()}`);
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [add, del] = line.split('\t');
    files += 1;
    additions += add === '-' ? 0 : Number(add ?? 0);
    deletions += del === '-' ? 0 : Number(del ?? 0);
  }
  return { files, additions, deletions };
}
