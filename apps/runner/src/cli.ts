import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registerRepository, pair } from './http.js';
import {
  loadCredentials,
  loadRepositories,
  readJson,
  runnerFiles,
  writePrivateJson,
  type LocalRepository,
} from './config.js';
import { RunnerDaemon } from './daemon.js';

const exec = promisify(execFile);
const files = runnerFiles();
const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

async function connectCommand(): Promise<void> {
  const server = flag('--server');
  const pairingCode = flag('--pair');
  const name = flag('--name') ?? 'runner';
  if (!server || !pairingCode)
    throw new Error('connect requires --server and --pair');
  const result = await pair(server, {
    pairingCode,
    name,
    daemonVersion: '0.1.0',
    os: process.platform,
    arch: process.arch,
  });
  await writePrivateJson(files.credentials, {
    server,
    runnerId: result.runnerId,
    workspaceId: result.workspaceId,
    runnerToken: result.runnerToken,
    name,
    daemonVersion: '0.1.0',
  });
  console.log(
    JSON.stringify({
      runnerId: result.runnerId,
      workspaceId: result.workspaceId,
    }),
  );
}

async function repoCommand(): Promise<void> {
  const path = await realpath(args[2] ?? '');
  const credentials = await loadCredentials(files);
  const noRemote = args.includes('--no-remote');
  const name = flag('--name') ?? path.split('/').at(-1) ?? 'repository';
  const remote = noRemote
    ? null
    : (
        await exec('git', ['remote', 'get-url', 'origin'], { cwd: path }).catch(
          () => ({ stdout: '' }),
        )
      ).stdout.trim() || null;
  const defaultRef =
    (
      await exec('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: path,
      }).catch(() => ({ stdout: 'main' }))
    ).stdout.trim() || 'main';
  const result = await registerRepository(credentials, {
    name,
    remoteUrl: remote,
    defaultRef,
    access: 'write',
  });
  const repositories = await loadRepositories(files);
  const next: LocalRepository[] = repositories.filter(
    (repository) => repository.repositoryId !== result.repositoryId,
  );
  next.push({
    repositoryId: result.repositoryId,
    path,
    name,
    remoteUrl: remote,
    defaultRef,
    access: 'write',
  });
  await writePrivateJson(files.repositories, next);
  console.log(
    JSON.stringify({
      repositoryId: result.repositoryId,
      created: result.created,
    }),
  );
}

async function daemonCommand(): Promise<void> {
  const credentials = await loadCredentials(files);
  const daemon = new RunnerDaemon({ credentials, files });
  await daemon.start();
  const stop = () => void daemon.stop().finally(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await new Promise(() => undefined);
}

async function statusCommand(): Promise<void> {
  const credentials = await loadCredentials(files);
  const repositories = await loadRepositories(files);
  console.log(
    JSON.stringify(
      {
        runnerId: credentials.runnerId,
        server: credentials.server,
        repositories: repositories.map(({ repositoryId, path, name }) => ({
          repositoryId,
          path,
          name,
        })),
      },
      null,
      2,
    ),
  );
}

try {
  const command = args[0];
  if (command === 'connect') await connectCommand();
  else if (command === 'repo' && args[1] === 'add') await repoCommand();
  else if (command === 'daemon') await daemonCommand();
  else if (command === 'status') await statusCommand();
  else throw new Error('Usage: agent-runner connect|repo add|daemon|status');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
