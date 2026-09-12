import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
export interface RunnerCredentials {
  server: string;
  runnerId: string;
  workspaceId: string;
  runnerToken: string;
  name: string;
  daemonVersion: string;
}

export interface LocalRepository {
  repositoryId: string;
  path: string;
  name: string;
  remoteUrl: string | null;
  defaultRef: string;
  access: 'read' | 'write';
}

export interface RunnerFiles {
  root: string;
  credentials: string;
  repositories: string;
  worktrees: string;
  attempts: string;
  outbox: string;
}

export interface PersistedAttemptState {
  attemptId: string;
  baseCommitSha: string;
  branchName: string;
  worktreePath?: string;
  nextClientSeq: number;
  nextChunkSeq: number;
  nextTurnNumber: number;
}
export function runnerFiles(
  root = process.env.AGENT_WORKSPACE_HOME ??
    join(homedir(), '.agent-workspace'),
): RunnerFiles {
  return {
    root,
    credentials: join(root, 'credentials.json'),
    repositories: join(root, 'repositories.json'),
    worktrees: join(root, 'worktrees'),
    attempts: join(root, 'state', 'attempts'),
    outbox: join(root, 'outbox.jsonl'),
  };
}

export function attemptStatePath(
  files: RunnerFiles,
  attemptId: string,
): string {
  return join(files.attempts, `${attemptId}.json`);
}

export async function loadAttemptStates(
  files: RunnerFiles,
): Promise<PersistedAttemptState[]> {
  await mkdir(files.attempts, { recursive: true, mode: 0o700 });
  let names: string[];
  try {
    names = await readdir(files.attempts);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const states: PersistedAttemptState[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const state = await readJson<PersistedAttemptState | null>(
      join(files.attempts, name),
      null,
    );
    if (state) states.push(state);
  }
  return states;
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writePrivateJson(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function loadCredentials(
  files = runnerFiles(),
): Promise<RunnerCredentials> {
  const credentials = await readJson<RunnerCredentials | undefined>(
    files.credentials,
    undefined,
  );
  if (!credentials)
    throw new Error('Runner is not paired; run agent-runner connect first');
  return credentials;
}

export async function loadRepositories(
  files = runnerFiles(),
): Promise<LocalRepository[]> {
  return readJson<LocalRepository[]>(files.repositories, []);
}
