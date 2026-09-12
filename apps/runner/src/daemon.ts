import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { WebSocket } from 'ws';
import {
  AgentCapabilitiesSchema,
  AttemptEventMessageSchema,
  AttemptTranscriptMessageSchema,
  RunnerHelloSchema,
  RunnerMessageSchema,
  ServerHelloSchema,
  type AgentCapabilities,
  type AgentProfile,
  type AttemptPrompt,
  type FrozenRunSpec,
  type OutboxMessage,
  type PermissionDecision,
  type RunnerMessage,
  type ServerMessage,
  type StartSessionInput,
  type TranscriptFrame,
} from '@agent-workspace/contracts';
import {
  ClaudeCodeAdapter,
  engineEnvironment,
  type Redactor,
} from '@agent-workspace/agent-adapters';
import {
  commitAll,
  createWorktree,
  diffStats,
  unifiedDiff,
} from '@agent-workspace/git-worktree';
import { claim, profiles, uploadArtifact } from './http.js';
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
  session?: Awaited<ReturnType<ClaudeCodeAdapter['startSession']>>;
  worktreePath?: string;
  stop: boolean;
  terminalSent: boolean;
  restarted: boolean;
  approvalResolvers: Map<string, (decision: PermissionDecision) => void>;
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
    await this.loadRestartedAttempts();
    for (const profile of await profiles(this.options.credentials))
      this.profiles.set(profile.id, profile);
    await this.connect();
    this.claimTimer = setInterval(() => void this.claimAvailable(), 30_000);
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
      socket.send(JSON.stringify(this.hello()));
      this.heartbeatTimer = setInterval(() => this.sendStatus(), 30_000);
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

  private async receive(raw: string): Promise<void> {
    let message: ServerMessage;
    try {
      message = RunnerMessageSchema.or(ServerHelloSchema).parse(
        JSON.parse(raw),
      ) as ServerMessage;
    } catch {
      return;
    }
    switch (message.type) {
      case 'server.hello':
        for (const item of message.attempts)
          if (item.disposition === 'stale')
            await this.markStale(item.attemptId);
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
      const profile = this.profiles.get(spec.agentProfileId);
      if (!profile)
        throw new Error(
          `Agent profile ${spec.agentProfileId} is not available on this Runner`,
        );
      const adapter =
        spec.engine === 'claude-code'
          ? new ClaudeCodeAdapter({ allowedRoots: [this.files.worktrees] })
          : undefined;
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
      await this.promptAttempt(
        attempt,
        spec.initialPrompt,
        attempt.nextTurnNumber++,
      );
      while (!attempt.stop)
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
    } catch (error) {
      if (!attempt.terminalSent && !attempt.stop) {
        const detail =
          error instanceof Error ? error.message : 'Agent start failed';
        await this.sendEvent(attempt, {
          type: 'attempt.failed',
          occurredAt: new Date().toISOString(),
          payload: {
            error: {
              code: 'agent_start_failed',
              message: detail,
              retryable: true,
            },
          },
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

  private async handleAttemptCancel(attemptId: string): Promise<void> {
    const attempt = this.active.get(attemptId);
    if (!attempt || attempt.terminalSent) return;
    attempt.stop = true;
    await attempt.session?.cancelTurn();
    const headCommitSha = await commitAll(
      attempt.worktreePath ?? '',
      'cancel agent attempt',
    );
    await this.sendEvent(attempt, {
      type: 'attempt.canceled',
      occurredAt: new Date().toISOString(),
      payload: { headCommitSha },
    });
    attempt.terminalSent = true;
  }

  private async handleAttemptClose(attemptId: string): Promise<void> {
    const attempt = this.active.get(attemptId);
    if (!attempt || attempt.terminalSent) return;
    attempt.stop = true;
    await attempt.session?.close();
    const headCommitSha = await commitAll(
      attempt.worktreePath ?? '',
      'complete agent attempt',
    );
    await this.sendEvent(attempt, {
      type: 'attempt.completed',
      occurredAt: new Date().toISOString(),
      payload: { headCommitSha, reason: 'user' },
    });
    attempt.terminalSent = true;
  }

  private async markStale(attemptId: string): Promise<void> {
    const attempt = this.active.get(attemptId);
    if (attempt) {
      attempt.stop = true;
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
