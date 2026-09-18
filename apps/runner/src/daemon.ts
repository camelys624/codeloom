import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { WebSocket } from 'ws';
import {
  AgentCapabilitiesSchema,
  AttemptEventMessageSchema,
  AttemptTranscriptMessageSchema,
  RepositoryRefFailedSchema,
  RepositoryRefResolvedSchema,
  RunnerHelloSchema,
  ServerMessageSchema,
  type AgentCapabilities,
  type AgentProfile,
  type AttemptPrompt,
  type FrozenRunSpec,
  type OutboxMessage,
  type PermissionDecision,
  type RepositoryResolveRef,
  type ServerMessage,
  type StartSessionInput,
  type TranscriptFrame,
  type AgentSessionHandle,
} from '@agent-workspace/contracts';
import {
  AdapterError,
  ClaudeCodeAdapter,
  PiAdapter,
  engineEnvironment,
  type Redactor,
} from '@agent-workspace/agent-adapters';
import type { AgentAdapter } from '@agent-workspace/contracts';
import {
  commitAll,
  createWorktree,
  diffStats,
  git,
  removeWorktree,
  resolveCommit,
  unifiedDiff,
} from '@agent-workspace/git-worktree';
import {
  cleanupCandidates,
  claim,
  profiles,
  reportCleanup,
  uploadArtifact,
} from './http.js';
import { Outbox } from './outbox.js';
import {
  attemptStatePath,
  loadAttemptStates,
  loadRepositories,
  runnerFiles,
  writePrivateJson,
  type LocalRepository,
  type PersistedAttemptState,
  type RunnerCredentials,
  type RunnerFiles,
} from './config.js';

interface ActiveAttempt {
  attemptId: string;
  baseCommitSha: string;
  branchName: string;
  turnId?: string;
  nextClientSeq: number;
  nextChunkSeq: number;
  nextTurnNumber: number;
  session?: AgentSessionHandle;
  worktreePath?: string;
  stop: boolean;
  terminalSent: boolean;
  terminalAction?: 'cancel' | 'close';
  restarted: boolean;
  approvalResolvers: Map<string, (decision: PermissionDecision) => void>;
  stale: boolean;
}

function placeholderCapabilities(profile: AgentProfile): AgentCapabilities {
  return AgentCapabilitiesSchema.parse(
    profile.capabilitySnapshot ?? {
      protocol: profile.engine === 'pi' ? 'rpc' : 'acp',
      engineVersion: 'unknown',
      models: profile.defaultModel ? [profile.defaultModel] : [],
      supports: {
        cancel: true,
        steer: false,
        permissionRequests: true,
        fileEvents: true,
        planUpdates: true,
      },
      enforcement: {
        filesystem: 'none',
        network: 'none',
        shell: 'engine',
        gitPush: 'none',
      },
    },
  );
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function isRunnerWorktree(root: string, candidate: string): boolean {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  return (
    candidatePath !== rootPath && candidatePath.startsWith(`${rootPath}${sep}`)
  );
}
export interface RunnerDaemonOptions {
  credentials: RunnerCredentials;
  files?: RunnerFiles;
  maxConcurrency?: number;
  adapterFactory?: (
    engine: FrozenRunSpec['engine'],
    profile: AgentProfile,
  ) => AgentAdapter | undefined;
}

export class RunnerDaemon {
  private readonly files: RunnerFiles;
  private readonly outbox: Outbox;
  private readonly active = new Map<string, ActiveAttempt>();
  private readonly profiles = new Map<string, AgentProfile>();
  private repositories: LocalRepository[] = [];
  private socket?: WebSocket;
  private closed = false;
  private reconnectDelay = 1_000;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private claimTimer?: NodeJS.Timeout;
  private readonly stateWrites = new Map<string, Promise<void>>();

  constructor(private readonly options: RunnerDaemonOptions) {
    this.files = options.files ?? runnerFiles();
    this.outbox = new Outbox(this.files);
  }

  async start(): Promise<void> {
    await mkdir(this.files.worktrees, { recursive: true, mode: 0o700 });
    this.repositories = await loadRepositories(this.files);
    await this.outbox.init();
    await this.refreshProfiles();
    await this.cleanupCompletedWorktrees();
    await this.connect();
    this.claimTimer = setInterval(() => void this.claimAvailable(), 30_000);
  }

  private async refreshProfiles(): Promise<void> {
    const current = await profiles(this.options.credentials);
    this.profiles.clear();
    for (const profile of current) this.profiles.set(profile.id, profile);
  }

  private async cleanupCompletedWorktrees(): Promise<void> {
    let candidates;
    try {
      candidates = await cleanupCandidates(this.options.credentials);
    } catch {
      return;
    }
    for (const candidate of candidates.candidates) {
      const worktreePath = join(this.files.worktrees, candidate.attemptId);
      let status: 'cleaned' | 'missing' | 'skipped_dirty' | 'failed';
      let detail: string | undefined;
      try {
        if (!isRunnerWorktree(this.files.worktrees, worktreePath))
          throw new Error('Cleanup candidate is outside Runner worktree root');
        try {
          await access(worktreePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            status = 'missing';
            await reportCleanup(this.options.credentials, {
              attemptId: candidate.attemptId,
              status,
            }).catch(() => undefined);
            continue;
          }
          throw error;
        }
        const clean = await git(worktreePath, ['status', '--porcelain']);
        if (clean.code !== 0) throw new Error(clean.stderr.trim());
        if (clean.stdout.trim()) {
          status = 'skipped_dirty';
          detail = 'Worktree contains uncommitted changes';
        } else {
          let repository: LocalRepository | undefined;
          const expectedPath = resolve(worktreePath);
          for (const candidateRepository of this.repositories) {
            const listed = await git(candidateRepository.path, [
              'worktree',
              'list',
              '--porcelain',
            ]);
            if (listed.code !== 0) continue;
            const paths = listed.stdout
              .split('\n')
              .filter((line) => line.startsWith('worktree '))
              .map((line) => resolve(line.slice('worktree '.length)));
            if (paths.includes(expectedPath)) {
              repository = candidateRepository;
              break;
            }
          }
          if (!repository) throw new Error('Repository for worktree not found');
          await removeWorktree(repository.path, worktreePath);
          status = 'cleaned';
        }
      } catch (error) {
        status = 'failed';
        detail = error instanceof Error ? error.message : 'Cleanup failed';
      }
      await reportCleanup(this.options.credentials, {
        attemptId: candidate.attemptId,
        status,
        ...(detail ? { detail } : {}),
      }).catch(() => undefined);
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => this.sendStatus(), 15_000);
  }

  async stop(): Promise<void> {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    clearInterval(this.claimTimer);
    for (const attempt of this.active.values()) {
      attempt.stop = true;
      await attempt.session?.close();
    }
    this.socket?.close();
  }

  private async loadRestartedAttempts(): Promise<void> {
    for (const state of await loadAttemptStates(this.files)) {
      this.active.set(state.attemptId, {
        attemptId: state.attemptId,
        baseCommitSha: state.baseCommitSha,
        branchName: state.branchName,
        worktreePath: state.worktreePath,
        nextClientSeq: state.nextClientSeq,
        nextChunkSeq: state.nextChunkSeq,
        nextTurnNumber: state.nextTurnNumber,
        stop: true,
        terminalSent: false,
        restarted: true,
        stale: false,
        approvalResolvers: new Map(),
      });
    }
  }

  private async persistAttempt(attempt: ActiveAttempt): Promise<void> {
    const state: PersistedAttemptState = {
      attemptId: attempt.attemptId,
      baseCommitSha: attempt.baseCommitSha,
      branchName: attempt.branchName,
      worktreePath: attempt.worktreePath,
      nextClientSeq: attempt.nextClientSeq,
      nextChunkSeq: attempt.nextChunkSeq,
      nextTurnNumber: attempt.nextTurnNumber,
    };
    const previous = this.stateWrites.get(attempt.attemptId);
    const write = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() =>
        writePrivateJson(
          attemptStatePath(this.files, attempt.attemptId),
          state,
        ),
      );
    this.stateWrites.set(attempt.attemptId, write);
    try {
      await write;
    } finally {
      if (this.stateWrites.get(attempt.attemptId) === write)
        this.stateWrites.delete(attempt.attemptId);
    }
  }

  private async removeAttemptState(attemptId: string): Promise<void> {
    await this.stateWrites.get(attemptId)?.catch(() => undefined);
    await rm(attemptStatePath(this.files, attemptId), { force: true });
  }

  private async reconcileRestarted(attempt: ActiveAttempt): Promise<void> {
    let detail = 'runner restarted';
    if (attempt.worktreePath) {
      try {
        if (!isRunnerWorktree(this.files.worktrees, attempt.worktreePath))
          throw new Error(
            'Persisted worktree is outside the Runner worktree root',
          );
        await access(attempt.worktreePath);
        await commitAll(attempt.worktreePath, 'runner restarted');
        detail = 'runner restarted after committing the worktree';
      } catch (error) {
        detail = `runner restarted; worktree commit failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`;
      }
    }
    await this.sendEvent(attempt, {
      type: 'attempt.failed',
      occurredAt: new Date().toISOString(),
      payload: {
        error: {
          code: 'agent_crashed',
          message: detail,
          retryable: false,
        },
      },
    });
    attempt.terminalSent = true;
    await this.removeAttemptState(attempt.attemptId);
    this.active.delete(attempt.attemptId);
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const url = new URL('/ws/runner', this.options.credentials.server);
    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.options.credentials.runnerToken}`,
      },
    });
    this.socket = socket;
    socket.on('open', () => {
      this.reconnectDelay = 1_000;
      void this.refreshProfiles()
        .then(() => {
          socket.send(JSON.stringify(this.hello()));
          this.startHeartbeat();
        })
        .catch(() => socket.close());
    });
    socket.on('message', (data) => void this.receive(data.toString()));
    socket.on('close', () => {
      clearInterval(this.heartbeatTimer);
      if (!this.closed) {
        this.reconnectTimer = setTimeout(
          () => void this.connect(),
          this.reconnectDelay + Math.round(Math.random() * 250),
        );
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      }
    });
    socket.on('error', () => undefined);
  }

  private hello() {
    const agents = [...this.profiles.values()].map((profile) => ({
      agentProfileId: profile.id,
      engine: profile.engine,
      capabilities: placeholderCapabilities(profile),
    }));
    return RunnerHelloSchema.parse({
      type: 'runner.hello',
      protocolVersion: 1,
      daemonVersion: this.options.credentials.daemonVersion,
      os: process.platform,
      arch: process.arch,
      maxConcurrency: this.options.maxConcurrency ?? 2,
      agents,
      repositories: this.repositories.map((repository) => ({
        repositoryId: repository.repositoryId,
        access: repository.access,
      })),
      activeAttemptIds: [...this.active.keys()],
    });
  }

  private sendStatus(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      JSON.stringify({
        type: 'runner.status',
        load: {
          active: this.active.size,
          capacity: this.options.maxConcurrency ?? 2,
        },
      }),
    );
    for (const attempt of this.active.values())
      this.socket.send(
        JSON.stringify({
          type: 'attempt.heartbeat',
          attemptId: attempt.attemptId,
        }),
      );
  }

  private async resolveRepositoryRef(
    request: RepositoryResolveRef,
  ): Promise<void> {
    const repository = this.repositories.find(
      (item) => item.repositoryId === request.repositoryId,
    );
    if (!repository) {
      this.socket?.send(
        JSON.stringify(
          RepositoryRefFailedSchema.parse({
            type: 'repository.ref_failed',
            requestId: request.requestId,
            repositoryId: request.repositoryId,
            ref: request.ref,
            error: 'Repository is not registered on this Runner',
          }),
        ),
      );
      return;
    }
    try {
      const commitSha = await resolveCommit(repository.path, request.ref);
      this.socket?.send(
        JSON.stringify(
          RepositoryRefResolvedSchema.parse({
            type: 'repository.ref_resolved',
            requestId: request.requestId,
            repositoryId: request.repositoryId,
            ref: request.ref,
            commitSha,
          }),
        ),
      );
    } catch (error) {
      this.socket?.send(
        JSON.stringify(
          RepositoryRefFailedSchema.parse({
            type: 'repository.ref_failed',
            requestId: request.requestId,
            repositoryId: request.repositoryId,
            ref: request.ref,
            error: (error instanceof Error
              ? error.message
              : 'Unable to resolve repository ref'
            ).slice(0, 64 * 1024),
          }),
        ),
      );
    }
  }

  private async receive(raw: string): Promise<void> {
    let message: ServerMessage;
    try {
      message = ServerMessageSchema.parse(JSON.parse(raw));
    } catch {
      return;
    }
    switch (message.type) {
      case 'server.hello':
        for (const item of message.attempts) {
          if (item.disposition === 'stale') {
            await this.markStale(item.attemptId);
            continue;
          }
          for (const control of item.controls) {
            if (control.type === 'attempt.cancel')
              await this.handleAttemptCancel(control.attemptId);
          }
        }
        await this.replayOutbox();
        for (const item of message.attempts) {
          const attempt = this.active.get(item.attemptId);
          if (item.disposition === 'continue' && attempt?.restarted)
            await this.reconcileRestarted(attempt);
        }
        await this.claimAvailable();
        break;
      case 'work.available':
        await this.claimAvailable();
        break;
      case 'repository.resolve_ref':
        await this.resolveRepositoryRef(message);
        break;
      case 'ack':
        await this.outbox.acknowledge(
          message.kind,
          message.attemptId,
          message.kind === 'event' ? message.clientSeq : message.chunkSeq,
        );
        break;
      case 'nack':
        await this.replayFrom(
          message.attemptId,
          message.kind,
          message.kind === 'event'
            ? message.expectedClientSeq
            : message.expectedChunkSeq,
        );
        break;
      case 'attempt.prompt':
        await this.handlePrompt(message);
        break;
      case 'turn.cancel':
        await this.handleTurnCancel(message.attemptId, message.turnId);
        break;
      case 'attempt.cancel':
        await this.handleAttemptCancel(message.attemptId);
        break;
      case 'attempt.close':
        await this.handleAttemptClose(message.attemptId);
        break;
      case 'approval.resolved':
        this.active
          .get(message.attemptId)
          ?.approvalResolvers.get(message.requestId)?.({
          decision: message.decision,
        });
        break;
      case 'attempt.stale':
        await this.markStale(message.attemptId);
        break;
    }
  }

  private async claimAvailable(): Promise<void> {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const capacity = Math.max(
      0,
      (this.options.maxConcurrency ?? 2) - this.active.size,
    );
    if (!capacity) return;
    try {
      const result = await claim(this.options.credentials, capacity);
      for (const claimed of result.attempts)
        void this.runAttempt(claimed.attempt, claimed.frozenSpec);
    } catch {
      // The next wake or 30-second poll retries. The server remains authoritative.
    }
  }

  private async sendEvent(
    attempt: ActiveAttempt,
    event: unknown,
  ): Promise<void> {
    if (attempt.stale) return;
    const message = AttemptEventMessageSchema.parse({
      type: 'attempt.event',
      attemptId: attempt.attemptId,
      clientSeq: attempt.nextClientSeq++,
      event,
    });
    await this.outbox.enqueue(message);
    await this.persistAttempt(attempt);
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(message));
  }

  private async sendTranscript(
    attempt: ActiveAttempt,
    turnId: string,
    frames: TranscriptFrame[],
  ): Promise<void> {
    if (attempt.stale) return;
    const message = AttemptTranscriptMessageSchema.parse({
      type: 'attempt.transcript',
      attemptId: attempt.attemptId,
      chunkSeq: attempt.nextChunkSeq++,
      turnId,
      frames,
    });
    await this.outbox.enqueue(message);
    await this.persistAttempt(attempt);
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(message));
  }

  private async runAttempt(
    attemptRow: { id: string; baseCommitSha: string; branchName: string },
    spec: FrozenRunSpec,
  ): Promise<void> {
    const attempt: ActiveAttempt = {
      attemptId: attemptRow.id,
      baseCommitSha: attemptRow.baseCommitSha,
      branchName: attemptRow.branchName,
      nextClientSeq: 1,
      nextChunkSeq: 1,
      nextTurnNumber: 1,
      stop: false,
      terminalSent: false,
      restarted: false,
      stale: false,
      approvalResolvers: new Map(),
    };
    this.active.set(attempt.attemptId, attempt);
    await this.persistAttempt(attempt);
    const repository = this.repositories.find(
      (item) => item.repositoryId === spec.repositoryId,
    );
    if (!repository) {
      await this.sendEvent(attempt, {
        type: 'attempt.failed',
        occurredAt: new Date().toISOString(),
        payload: {
          error: {
            code: 'repository_not_registered',
            message: 'Repository is not registered on this Runner',
            retryable: false,
          },
        },
      });
      attempt.terminalSent = true;
      await this.removeAttemptState(attempt.attemptId);
      this.active.delete(attempt.attemptId);
      return;
    }
    try {
      await this.sendEvent(attempt, {
        type: 'attempt.preparing',
        occurredAt: new Date().toISOString(),
        payload: { detail: 'Creating isolated worktree' },
      });
      const worktree = await createWorktree({
        checkoutPath: repository.path,
        worktreeRoot: this.files.worktrees,
        attemptId: attempt.attemptId,
        branchName: attemptRow.branchName,
        baseCommitSha: attemptRow.baseCommitSha,
      });
      attempt.worktreePath = worktree.path;
      await this.persistAttempt(attempt);
      if (attempt.terminalAction) {
        await this.finalizeTerminal(attempt, attempt.terminalAction);
        return;
      }
      if (attempt.stop) return;
      const profile = this.profiles.get(spec.agentProfileId);
      if (!profile)
        throw new Error(
          `Agent profile ${spec.agentProfileId} is not available on this Runner`,
        );
      if (attempt.stop) return;
      const adapter =
        this.options.adapterFactory?.(spec.engine, profile) ??
        (spec.engine === 'claude-code'
          ? new ClaudeCodeAdapter({ allowedRoots: [this.files.worktrees] })
          : spec.engine === 'pi'
            ? new PiAdapter()
            : undefined);
      if (!adapter)
        throw new Error(`No adapter is installed for engine ${spec.engine}`);
      const capabilities = placeholderCapabilities(profile);
      await this.sendEvent(attempt, {
        type: 'attempt.started',
        occurredAt: new Date().toISOString(),
        payload: {
          enforcement: capabilities.enforcement,
          engineVersion: capabilities.engineVersion,
        },
      });
      const session = await adapter.startSession({
        attemptId: attempt.attemptId,
        cwd: worktree.path,
        launch: profile.launch,
        env: engineEnvironment(spec.engine, process.env),
        runConfig: spec.runConfig,
        onFrame: (frame) => {
          if (attempt.turnId)
            void this.sendTranscript(attempt, attempt.turnId, [frame]);
        },
        onPermissionRequest: (request) =>
          this.waitForApproval(attempt, request),
        clock: {
          now: () => new Date(),
          setTimeout: (callback, ms) => setTimeout(callback, ms),
          clearTimeout: (handle) => clearTimeout(handle),
        },
      });
      attempt.session = session;
      if (attempt.terminalAction) {
        await this.finalizeTerminal(attempt, attempt.terminalAction);
        return;
      }
      if (attempt.stop) return;
      await this.promptAttempt(
        attempt,
        spec.initialPrompt,
        attempt.nextTurnNumber++,
      );
      while (!attempt.stop)
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
    } catch (error) {
      if (!attempt.terminalSent && attempt.terminalAction && !attempt.stale) {
        if (attempt.terminalAction === 'cancel') {
          await this.sendEvent(attempt, {
            type: 'attempt.canceled',
            occurredAt: new Date().toISOString(),
            payload: {},
          });
        } else {
          await this.sendEvent(attempt, {
            type: 'attempt.failed',
            occurredAt: new Date().toISOString(),
            payload: {
              error: {
                code: 'worktree_failed',
                message:
                  error instanceof Error
                    ? error.message
                    : 'Unable to prepare worktree',
                retryable: false,
              },
            },
          });
        }
        attempt.terminalSent = true;
      } else if (!attempt.terminalSent && !attempt.stop) {
        const detail =
          error instanceof AdapterError
            ? error.runError
            : {
                code: 'agent_start_failed' as const,
                message:
                  error instanceof Error ? error.message : 'Agent start failed',
                retryable: true,
              };
        await this.sendEvent(attempt, {
          type: 'attempt.failed',
          occurredAt: new Date().toISOString(),
          payload: { error: detail },
        });
        attempt.terminalSent = true;
      }
    } finally {
      await attempt.session?.close().catch(() => undefined);
      if (attempt.terminalSent)
        await this.removeAttemptState(attempt.attemptId);
      this.active.delete(attempt.attemptId);
    }
  }

  private async promptAttempt(
    attempt: ActiveAttempt,
    text: string,
    number: number,
    suppliedTurnId?: string,
  ): Promise<void> {
    if (!attempt.session) throw new Error('Agent session is not available');
    const turnId = suppliedTurnId ?? `trn_${randomUUID()}`;
    attempt.turnId = turnId;
    await this.sendEvent(attempt, {
      type: 'turn.started',
      turnId,
      occurredAt: new Date().toISOString(),
      payload: { number, prompt: text },
    });
    const result = await attempt.session.prompt({
      turnId,
      text,
      signal: AbortSignal.timeout(60 * 60_000),
    });
    if (result.stopReason === 'canceled') {
      await this.sendEvent(attempt, {
        type: 'turn.canceled',
        turnId,
        occurredAt: new Date().toISOString(),
        payload: { usage: result.usage },
      });
    } else if (result.stopReason === 'error') {
      await this.sendEvent(attempt, {
        type: 'turn.failed',
        turnId,
        occurredAt: new Date().toISOString(),
        payload: {
          error: result.error ?? {
            code: 'unknown',
            message: 'Agent turn failed',
            retryable: false,
          },
          attemptContinues: true,
        },
      });
    } else {
      const headCommitSha = await commitAll(
        attempt.worktreePath ?? '',
        `agent turn ${number}`,
      );
      const stats = await diffStats(
        attempt.worktreePath ?? '',
        attempt.baseCommitSha,
      );
      const patch = Buffer.from(
        await unifiedDiff(attempt.worktreePath ?? '', attempt.baseCommitSha),
      );
      const artifactId = await uploadArtifact(
        this.options.credentials,
        attempt.attemptId,
        { kind: 'patch', turnId, sha256: sha256(patch) },
        patch,
      );
      await this.sendEvent(attempt, {
        type: 'turn.completed',
        turnId,
        occurredAt: new Date().toISOString(),
        payload: {
          usage: result.usage,
          diffStats: stats,
          commitSha: headCommitSha,
          patchArtifactId: artifactId,
        },
      });
    }
    attempt.turnId = undefined;
  }

  private async waitForApproval(
    attempt: ActiveAttempt,
    request: {
      requestId: string;
      kind: 'tool' | 'file_write' | 'shell' | 'network' | 'other';
      title: string;
      payload: unknown;
    },
  ): Promise<PermissionDecision> {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    await this.sendEvent(attempt, {
      type: 'approval.requested',
      turnId: attempt.turnId ?? `trn_${randomUUID()}`,
      occurredAt: new Date().toISOString(),
      payload: { ...request, expiresAt },
    });
    const { promise, resolve } = Promise.withResolvers<PermissionDecision>();
    attempt.approvalResolvers.set(request.requestId, resolve);
    const decision = await promise;
    attempt.approvalResolvers.delete(request.requestId);
    return decision;
  }

  private async handlePrompt(message: AttemptPrompt): Promise<void> {
    const attempt = this.active.get(message.attemptId);
    if (!attempt || !attempt.session) return;
    await this.promptAttempt(
      attempt,
      message.text,
      attempt.nextTurnNumber++,
      message.turnId,
    );
  }

  private async handleTurnCancel(
    attemptId: string,
    turnId: string,
  ): Promise<void> {
    const attempt = this.active.get(attemptId);
    if (attempt?.turnId === turnId) await attempt.session?.cancelTurn();
  }
  private async finalizeTerminal(
    attempt: ActiveAttempt,
    action: 'cancel' | 'close',
  ): Promise<void> {
    if (attempt.terminalSent || attempt.stale) return;
    attempt.stop = true;
    attempt.terminalSent = true;
    let failure: unknown;
    try {
      if (attempt.turnId) await attempt.session?.cancelTurn();
      await attempt.session?.close();
    } catch (error) {
      failure = error;
    }
    let headCommitSha: string | undefined;
    if (attempt.worktreePath) {
      try {
        headCommitSha = await commitAll(
          attempt.worktreePath,
          action === 'cancel'
            ? 'cancel agent attempt'
            : 'complete agent attempt',
        );
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) {
      await this.sendEvent(attempt, {
        type: 'attempt.failed',
        occurredAt: new Date().toISOString(),
        payload: {
          error: {
            code: 'worktree_failed',
            message:
              failure instanceof Error
                ? failure.message
                : 'Unable to finalize attempt',
            retryable: false,
          },
        },
      });
      return;
    }
    if (action === 'cancel') {
      await this.sendEvent(attempt, {
        type: 'attempt.canceled',
        occurredAt: new Date().toISOString(),
        payload: headCommitSha ? { headCommitSha } : {},
      });
      return;
    }
    if (!headCommitSha) {
      await this.sendEvent(attempt, {
        type: 'attempt.failed',
        occurredAt: new Date().toISOString(),
        payload: {
          error: {
            code: 'worktree_failed',
            message: 'Attempt has no worktree to complete',
            retryable: false,
          },
        },
      });
      return;
    }
    await this.sendEvent(attempt, {
      type: 'attempt.completed',
      occurredAt: new Date().toISOString(),
      payload: { headCommitSha, reason: 'user' },
    });
  }
  private async handleAttemptCancel(attemptId: string): Promise<void> {
    const attempt = this.active.get(attemptId);
    if (!attempt || attempt.terminalSent || attempt.terminalAction) return;
    attempt.stop = true;
    attempt.terminalAction = 'cancel';
    if (attempt.worktreePath)
      await this.finalizeTerminal(attempt, attempt.terminalAction);
  }

  private async handleAttemptClose(attemptId: string): Promise<void> {
    const attempt = this.active.get(attemptId);
    if (!attempt || attempt.terminalSent || attempt.terminalAction) return;
    attempt.stop = true;
    attempt.terminalAction = 'close';
    if (attempt.worktreePath)
      await this.finalizeTerminal(attempt, attempt.terminalAction);
  }

  private async markStale(attemptId: string): Promise<void> {
    const attempt = this.active.get(attemptId);
    if (attempt) {
      attempt.stale = true;
      attempt.stop = true;
      for (const resolve of attempt.approvalResolvers.values())
        resolve({ decision: 'deny' });
      await attempt.session?.close();
      this.active.delete(attemptId);
    }
    await this.removeAttemptState(attemptId);
    await this.outbox.removeAttempt(attemptId);
  }

  private async replayOutbox(): Promise<void> {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    for (const message of this.outbox.pending())
      this.socket.send(JSON.stringify(message));
  }

  private async replayFrom(
    attemptId: string,
    kind: 'event' | 'transcript',
    expected: number,
  ): Promise<void> {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    for (const message of this.outbox.pending()) {
      if (message.attemptId !== attemptId) continue;
      if (
        kind === 'event' &&
        message.type === 'attempt.event' &&
        message.clientSeq >= expected
      )
        this.socket.send(JSON.stringify(message));
      if (
        kind === 'transcript' &&
        message.type === 'attempt.transcript' &&
        message.chunkSeq >= expected
      )
        this.socket.send(JSON.stringify(message));
    }
  }
}
