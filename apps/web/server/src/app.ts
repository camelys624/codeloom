import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import argon2 from 'argon2';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { WebSocket } from 'ws';
import {
  AgentProfileSchema,
  AgentProtocolSchema,
  ApprovalRequestSchema,
  AttemptSchema,
  AttemptTranscriptMessageSchema,
  BrowserServerMessageSchema,
  BrowserEventSchema,
  BrowserTranscriptSchema,
  ClaimAttemptsInputSchema,
  CreateAgentProfileInputSchema,
  CreateRunInputSchema,
  CreateRunnerInputSchema,
  CreateTaskInputSchema,
  EventsQuerySchema,
  EventNackSchema,
  EventAckSchema,
  FrozenRunSpecSchema,
  MeOutputSchema,
  PairRunnerInputSchema,
  PermissionModeSchema,
  PromptInputSchema,
  RegisterRepositoryInputSchema,
  ResolveApprovalInputSchema,
  RetryRunInputSchema,
  RunEventSchema,
  RunSchema,
  RunSnapshotSchema,
  RunnerEventSchema,
  RunnerHelloSchema,
  RunnerMessageSchema,
  ServerHelloSchema,
  RepositoryRefFailedSchema,
  RepositoryRefResolvedSchema,
  RepositoryResolveRefSchema,
  TranscriptNackSchema,
  TranscriptOutputSchema,
  TranscriptQuerySchema,
  TranscriptFramesSchema,
  TurnSchema,
  UpdateAgentProfileInputSchema,
  UpdateTaskInputSchema,
  UploadArtifactInputSchema,
  WorkspaceMemberSchema,
  type AgentProfile,
  type AgentEngine,
  type AttemptStatus,
  type BrowserServerMessage,
  type FrozenRunSpec,
  type RunError,
  type RunStatus,
  type RunnerEvent,
  type ServerMessage,
  type StateEvent,
} from '@agent-workspace/contracts';
import {
  isTerminalAttempt,
  projectRunStatus,
} from '@agent-workspace/contracts';
import { migrate } from '../db/migrate.js';
import {
  createPool,
  iso,
  jsonObject,
  one,
  transaction,
  type DbExecutor,
} from './db.js';
import {
  mapAgentProfile,
  mapApproval,
  mapArtifact,
  mapAttempt,
  mapMembership,
  mapRepository,
  mapRun,
  mapRunEvent,
  mapRunner,
  mapTask,
  mapTurn,
  mapUser,
  mapWorkspace,
} from './mapping.js';

export interface ServerConfig {
  databaseUrl: string;
  sessionSecret: string;
  publicOrigin: string;
  dataDir: string;
  host: string;
  port: number;
  serveStatic: boolean;
  trustProxy: boolean;
  nodeEnv: string;
}

export interface BuildAppOptions {
  pool?: Pool;
  config?: Partial<ServerConfig>;
  migrations?: boolean;
}

type AuthContext = {
  user: ReturnType<typeof mapUser>;
  workspace: ReturnType<typeof mapWorkspace>;
  membership: ReturnType<typeof mapMembership>;
};

type RunnerContext = {
  id: string;
  workspaceId: string;
  status: string;
  maxConcurrency: number;
};

type RequestWithAuth = FastifyRequest & { auth?: AuthContext };
type RequestWithRunner = FastifyRequest & { runner?: RunnerContext };
type Row = Record<string, any>;

type WsLike = WebSocket & { isAlive?: boolean };

type PendingRepositoryRef = {
  runnerId: string;
  repositoryId: string;
  ref: string;
  socket: WsLike;
  timer: NodeJS.Timeout;
  resolve: (commitSha: string) => void;
  reject: (error: Error & { statusCode?: number }) => void;
};

const SESSION_COOKIE = 'aw_session';
const PROTOCOL_VERSION = 1;
const LEASE_SECONDS = 45;
const HEARTBEAT_TIMEOUT_MS = 45_000;
const REAPER_INTERVAL_MS = 15_000;
const TOKEN_ROTATION_GRACE_MS = 60_000;
const PAIRING_TTL_MS = 10 * 60_000;
const AUTH_SESSION_MS = 14 * 24 * 60 * 60_000;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function envBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

function resolveConfig(input: Partial<ServerConfig> = {}): ServerConfig {
  const databaseUrl = input.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  return {
    databaseUrl,
    sessionSecret:
      input.sessionSecret ??
      process.env.SESSION_SECRET ??
      'development-only-session-secret',
    publicOrigin:
      input.publicOrigin ??
      process.env.PUBLIC_ORIGIN ??
      'http://localhost:5173',
    dataDir: input.dataDir ?? process.env.DATA_DIR ?? resolve('.data'),
    host: input.host ?? process.env.HOST ?? '127.0.0.1',
    port: input.port ?? Number(process.env.PORT ?? 5181),
    serveStatic:
      input.serveStatic ?? envBoolean(process.env.SERVE_STATIC, false),
    trustProxy: input.trustProxy ?? envBoolean(process.env.TRUST_PROXY, false),
    nodeEnv: input.nodeEnv ?? process.env.NODE_ENV ?? 'development',
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function newToken(prefix: string, bytes: number): string {
  return `${prefix}${randomBytes(bytes).toString('base64url')}`;
}

function sameOrigin(request: FastifyRequest, origin: string): boolean {
  return request.headers.origin === origin;
}

function isMutation(request: FastifyRequest): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
}

function parseBody<T>(schema: { parse(value: unknown): T }, body: unknown): T {
  try {
    return schema.parse(body);
  } catch (error) {
    if (error instanceof Error && !('statusCode' in error))
      Object.assign(error, { statusCode: 400 });
    throw error;
  }
}

function errorBody(
  code: string,
  message: string,
): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function httpError(
  statusCode: number,
  message: string,
): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
function shortRunId(runId: string): string {
  return runId.replace(/^run_/, '').slice(0, 8);
}

function runError(
  code: RunError['code'],
  message: string,
  retryable: boolean,
): RunError {
  return { code, message, retryable };
}

function isRunnerRequest(request: FastifyRequest): boolean {
  return (
    typeof request.headers.authorization === 'string' &&
    request.headers.authorization.startsWith('Bearer ')
  );
}

function runStatusForAttempt(status: AttemptStatus): RunStatus {
  return projectRunStatus(status);
}

function asRunnerContext(row: Row): RunnerContext {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    status: String(row.status),
    maxConcurrency: Number(row.max_concurrency),
  };
}

async function closeQuietly(socket: WebSocket): Promise<void> {
  if (
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CONNECTING
  )
    socket.close();
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const config = resolveConfig(options.config);
  const pool = options.pool ?? createPool(config.databaseUrl);
  if (options.migrations) {
    const migrationClient = await pool.connect();
    try {
      await migrate({ connection: migrationClient });
    } finally {
      migrationClient.release();
    }
  }
  const app = Fastify({
    logger: config.nodeEnv !== 'test',
    trustProxy: config.trustProxy,
  });
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 8 },
  });
  await app.register(websocket);

  const runnerSockets = new Map<string, WsLike>();
  const browserSubscriptions = new Map<string, Set<WsLike>>();
  const socketRunners = new Map<WsLike, string>();
  const socketSubscriptions = new Map<WsLike, string>();
  const pendingRepositoryRefs = new Map<string, PendingRepositoryRef>();
  let reaperTimer: NodeJS.Timeout | undefined;
  let notificationClient: PoolClient | undefined;

  function broadcast(runId: string, message: BrowserServerMessage): void {
    const sockets = browserSubscriptions.get(runId);
    if (!sockets) return;
    const encoded = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(encoded);
    }
  }

  function sendRunner(runnerId: string, message: ServerMessage): boolean {
    const socket = runnerSockets.get(runnerId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  async function resolveRepositoryRef(
    runnerId: string,
    repositoryId: string,
    ref: string,
  ): Promise<string> {
    const socket = runnerSockets.get(runnerId);
    if (!socket || socket.readyState !== WebSocket.OPEN)
      throw httpError(
        409,
        'Runner must be online to resolve the latest repository commit',
      );
    const requestId = `ref_${randomUUID()}`;
    const gate = Promise.withResolvers<string>();
    const timer = setTimeout(() => {
      if (pendingRepositoryRefs.delete(requestId))
        gate.reject(
          httpError(504, 'Runner did not resolve the repository ref in time'),
        );
    }, 10_000);
    pendingRepositoryRefs.set(requestId, {
      runnerId,
      repositoryId,
      ref,
      socket,
      timer,
      resolve: gate.resolve,
      reject: gate.reject,
    });
    try {
      socket.send(
        JSON.stringify(
          RepositoryResolveRefSchema.parse({
            type: 'repository.resolve_ref',
            requestId,
            repositoryId,
            ref,
          }),
        ),
      );
    } catch {
      clearTimeout(timer);
      pendingRepositoryRefs.delete(requestId);
      gate.reject(
        httpError(503, 'Runner connection closed during ref resolution'),
      );
    }
    return gate.promise;
  }

  async function sessionContext(
    request: FastifyRequest,
  ): Promise<AuthContext | undefined> {
    const raw = request.cookies?.[SESSION_COOKIE];
    if (!raw) return undefined;
    const result = await pool.query<Row>(
      `SELECT u.*, w.id AS workspace_id, w.name AS workspace_name, w.slug AS workspace_slug,
              w.created_at AS workspace_created_at, wm.workspace_id AS member_workspace_id,
              wm.user_id AS member_user_id, wm.role AS member_role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN workspace_members wm ON wm.user_id = u.id
       JOIN workspaces w ON w.id = wm.workspace_id
       WHERE s.id = $1 AND s.expires_at > now()
       ORDER BY w.created_at, w.id
       LIMIT 1`,
      [raw],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      user: mapUser(row),
      workspace: mapWorkspace({
        id: row.workspace_id,
        name: row.workspace_name,
        slug: row.workspace_slug,
        created_at: row.workspace_created_at,
      }),
      membership: mapMembership({
        workspace_id: row.member_workspace_id,
        user_id: row.member_user_id,
        role: row.member_role,
      }),
    };
  }

  async function requireAuth(
    request: RequestWithAuth,
    reply: FastifyReply,
  ): Promise<AuthContext | undefined> {
    const auth = await sessionContext(request);
    if (!auth) {
      reply
        .code(401)
        .send(errorBody('unauthorized', 'Authentication required'));
      return undefined;
    }
    request.auth = auth;
    return auth;
  }

  async function runnerContext(
    request: RequestWithRunner,
    reply: FastifyReply,
  ): Promise<RunnerContext | undefined> {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      reply
        .code(401)
        .send(errorBody('unauthorized', 'Runner bearer token required'));
      return undefined;
    }
    const tokenHash = hashToken(authorization.slice(7));
    const result = await pool.query<Row>(
      `SELECT id, workspace_id, status, max_concurrency
       FROM runners
       WHERE status <> 'revoked'
         AND (token_hash = $1 OR (previous_token_hash = $1 AND previous_token_expires_at > now()))
       LIMIT 1`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) {
      reply.code(401).send(errorBody('unauthorized', 'Invalid runner token'));
      return undefined;
    }
    const runner = asRunnerContext(row);
    request.runner = runner;
    return runner;
  }

  async function ensureWorkspace(
    request: RequestWithAuth,
    reply: FastifyReply,
  ): Promise<AuthContext | undefined> {
    const auth = await requireAuth(request, reply);
    if (!auth) return undefined;
    if (isMutation(request) && !sameOrigin(request, config.publicOrigin)) {
      reply
        .code(403)
        .send(errorBody('csrf', 'Origin does not match PUBLIC_ORIGIN'));
      return undefined;
    }
    return auth;
  }

  async function getRunSnapshot(runId: string, workspaceId: string) {
    const runResult = await pool.query<Row>(
      'SELECT * FROM runs WHERE id = $1 AND workspace_id = $2',
      [runId, workspaceId],
    );
    const runRow = runResult.rows[0];
    if (!runRow) return undefined;
    const [attempts, turns, approvals] = await Promise.all([
      pool.query<Row>(
        'SELECT * FROM attempts WHERE run_id = $1 AND workspace_id = $2 ORDER BY number',
        [runId, workspaceId],
      ),
      pool.query<Row>(
        `SELECT t.* FROM turns t JOIN attempts a ON a.id = t.attempt_id
         WHERE a.run_id = $1 AND t.workspace_id = $2 ORDER BY t.attempt_id, t.number`,
        [runId, workspaceId],
      ),
      pool.query<Row>(
        `SELECT * FROM approval_requests WHERE run_id = $1 AND workspace_id = $2 AND status = 'pending' ORDER BY created_at`,
        [runId, workspaceId],
      ),
    ]);
    const snapshot = {
      run: mapRun(runRow),
      attempts: attempts.rows.map((row) => ({
        ...mapAttempt(row),
        lastSequence: Number(row.last_sequence),
        lastChunkSeq: Number(row.last_chunk_seq),
      })),
      turns: turns.rows.map(mapTurn),
      approvals: approvals.rows.map(mapApproval),
    };
    return RunSnapshotSchema.parse(snapshot);
  }

  async function appendEvent(
    client: DbExecutor,
    attempt: Row,
    event: StateEvent,
    actorClientSeq: number | null,
  ): Promise<Row> {
    const sequence = Number(attempt.last_sequence) + 1;
    const eventRow = one(
      await client.query<Row>(
        `INSERT INTO run_events
          (workspace_id, run_id, attempt_id, turn_id, sequence, client_seq, type, payload, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          attempt.workspace_id,
          attempt.run_id,
          attempt.id,
          event.turnId ?? null,
          sequence,
          actorClientSeq,
          event.type,
          event.payload,
          event.occurredAt,
        ],
      ),
      'Event insert did not return a row',
    );
    await client.query(
      `UPDATE attempts
       SET last_sequence = $2,
           last_client_seq = CASE WHEN $3::bigint IS NULL THEN last_client_seq ELSE $3 END
       WHERE id = $1`,
      [attempt.id, sequence, actorClientSeq],
    );
    attempt.last_sequence = sequence;
    if (actorClientSeq !== null) attempt.last_client_seq = actorClientSeq;
    return eventRow;
  }

  async function appendServerEvent(
    client: DbExecutor,
    attempt: Row,
    type: StateEvent['type'],
    payload: Record<string, unknown>,
    turnId?: string,
  ): Promise<Row> {
    const event = {
      type,
      occurredAt: new Date().toISOString(),
      ...(turnId ? { turnId } : {}),
      payload,
    } as StateEvent;
    return appendEvent(client, attempt, event, null);
  }

  async function projectRun(
    client: DbExecutor,
    runId: string,
    attemptStatus: AttemptStatus,
  ): Promise<void> {
    const status = runStatusForAttempt(attemptStatus);
    await client.query(
      `UPDATE runs
       SET status = $2,
           started_at = CASE WHEN $2 IN ('active', 'idle', 'waiting_approval') THEN COALESCE(started_at, now()) ELSE started_at END,
           finished_at = CASE WHEN $2 IN ('completed', 'failed', 'canceled', 'lost') THEN COALESCE(finished_at, now()) ELSE NULL END
       WHERE id = $1`,
      [runId, status],
    );
    if (status === 'completed') {
      await client.query(
        `UPDATE tasks SET status = 'needs_review' WHERE id = (SELECT task_id FROM runs WHERE id = $1) AND status = 'in_progress'`,
        [runId],
      );
    }
  }

  async function reloadAttempt(
    client: DbExecutor,
    attemptId: string,
  ): Promise<Row> {
    return one(
      await client.query<Row>(
        'SELECT * FROM attempts WHERE id = $1 FOR UPDATE',
        [attemptId],
      ),
      'Attempt not found',
    );
  }

  async function processRunnerEvent(
    runner: RunnerContext,
    message: { attemptId: string; clientSeq: number; event: RunnerEvent },
  ): Promise<
    | { kind: 'ack'; clientSeq: number; eventRow?: Row }
    | { kind: 'nack'; expectedClientSeq: number }
    | { kind: 'stale' }
  > {
    const result = await transaction(pool, async (client) => {
      const attempt = await reloadAttempt(client, message.attemptId);
      const current = await client.query<Row>(
        'SELECT current_attempt_id FROM runs WHERE id = $1 AND workspace_id = $2',
        [attempt.run_id, runner.workspaceId],
      );
      const currentAttemptId = current.rows[0]?.current_attempt_id;
      const valid =
        String(attempt.workspace_id) === runner.workspaceId &&
        String(attempt.runner_id) === runner.id &&
        String(currentAttemptId) === String(attempt.id) &&
        !isTerminalAttempt(attempt.status as AttemptStatus);
      if (!valid) return { kind: 'stale' as const };
      const lastClientSeq = Number(attempt.last_client_seq);
      if (message.clientSeq <= lastClientSeq) {
        return { kind: 'ack' as const, clientSeq: message.clientSeq };
      }
      if (message.clientSeq !== lastClientSeq + 1) {
        return { kind: 'nack' as const, expectedClientSeq: lastClientSeq + 1 };
      }

      const event = RunnerEventSchema.parse(message.event);
      const previousStatus = attempt.status as AttemptStatus;
      let nextStatus = previousStatus;
      switch (event.type) {
        case 'attempt.preparing':
          nextStatus = 'preparing';
          break;
        case 'attempt.started':
          nextStatus = 'running';
          await client.query(
            `UPDATE attempts SET enforcement = $2, started_at = COALESCE(started_at, now()) WHERE id = $1`,
            [attempt.id, event.payload.enforcement],
          );
          break;
        case 'turn.started': {
          nextStatus = 'running';
          await client.query(
            `INSERT INTO turns (id, workspace_id, attempt_id, number, prompt, status, started_at)
             VALUES ($1, $2, $3, $4, $5, 'running', $6)
             ON CONFLICT (id) DO UPDATE SET status = 'running', prompt = EXCLUDED.prompt`,
            [
              event.turnId,
              attempt.workspace_id,
              attempt.id,
              event.payload.number,
              event.payload.prompt,
              event.occurredAt,
            ],
          );
          break;
        }
        case 'turn.completed':
          nextStatus = 'idle';
          await client.query(
            `UPDATE turns SET status = 'completed', usage = $2, diff_stats = $3, commit_sha = $4,
                    patch_artifact_id = $5, finished_at = now()
             WHERE id = $1 AND attempt_id = $6`,
            [
              event.turnId,
              event.payload.usage ?? null,
              event.payload.diffStats,
              event.payload.commitSha,
              event.payload.patchArtifactId,
              attempt.id,
            ],
          );
          break;
        case 'turn.failed':
          nextStatus = event.payload.attemptContinues ? 'idle' : 'failed';
          await client.query(
            `UPDATE turns SET status = 'failed', finished_at = now() WHERE id = $1 AND attempt_id = $2`,
            [event.turnId, attempt.id],
          );
          break;
        case 'turn.canceled':
          nextStatus = 'idle';
          await client.query(
            `UPDATE turns SET status = 'canceled', finished_at = now() WHERE id = $1 AND attempt_id = $2`,
            [event.turnId, attempt.id],
          );
          break;
        case 'approval.requested':
          nextStatus = 'waiting_approval';
          await client.query(
            `INSERT INTO approval_requests
              (workspace_id, run_id, attempt_id, turn_id, request_id, kind, title, payload, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (attempt_id, request_id) DO NOTHING`,
            [
              attempt.workspace_id,
              attempt.run_id,
              attempt.id,
              event.turnId,
              event.payload.requestId,
              event.payload.kind,
              event.payload.title,
              event.payload.payload,
              event.payload.expiresAt,
            ],
          );
          await client.query(
            `UPDATE turns SET status = 'waiting_approval' WHERE id = $1 AND attempt_id = $2`,
            [event.turnId, attempt.id],
          );
          break;
        case 'attempt.completed':
          nextStatus = 'completed';
          await client.query(
            `UPDATE attempts SET head_commit_sha = $2, finished_at = now() WHERE id = $1`,
            [attempt.id, event.payload.headCommitSha],
          );
          await client.query(
            `UPDATE approval_requests SET status = 'expired', updated_at = now() WHERE attempt_id = $1 AND status = 'pending'`,
            [attempt.id],
          );
          break;
        case 'attempt.failed': {
          const error = event.payload.error;
          nextStatus = 'failed';
          await client.query(
            `UPDATE attempts SET error = $2, finished_at = now() WHERE id = $1`,
            [attempt.id, error],
          );
          await client.query(
            `UPDATE approval_requests SET status = 'expired', updated_at = now() WHERE attempt_id = $1 AND status = 'pending'`,
            [attempt.id],
          );
          break;
        }
        case 'attempt.canceled':
          nextStatus = 'canceled';
          await client.query(
            `UPDATE attempts SET head_commit_sha = $2, finished_at = now() WHERE id = $1`,
            [attempt.id, event.payload.headCommitSha ?? null],
          );
          await client.query(
            `UPDATE approval_requests SET status = 'expired', updated_at = now() WHERE attempt_id = $1 AND status = 'pending'`,
            [attempt.id],
          );
          break;
      }
      if (nextStatus !== attempt.status) {
        await client.query(`UPDATE attempts SET status = $2 WHERE id = $1`, [
          attempt.id,
          nextStatus,
        ]);
        await projectRun(client, attempt.run_id, nextStatus);
      }
      const eventRow = await appendEvent(
        client,
        attempt,
        event,
        message.clientSeq,
      );
      if (event.type === 'attempt.failed')
        await queueAutomaticRetry(
          client,
          { ...attempt, status: previousStatus },
          event.payload.error,
        );
      return { kind: 'ack' as const, clientSeq: message.clientSeq, eventRow };
    });
    if (result.kind === 'ack' && result.eventRow) {
      const event = mapRunEvent(result.eventRow);
      broadcast(String(result.eventRow.run_id), {
        type: 'event',
        attemptId: String(result.eventRow.attempt_id),
        sequence: Number(result.eventRow.sequence),
        event: RunEventSchema.parse(event),
      });
    }
    return result;
  }

  async function processTranscript(
    runner: RunnerContext,
    message: {
      attemptId: string;
      chunkSeq: number;
      turnId: string;
      frames: unknown;
    },
  ): Promise<
    | {
        kind: 'ack';
        chunkSeq: number;
        runId?: string;
        chunk?: {
          attemptId: string;
          chunkSeq: number;
          turnId: string;
          frames: unknown;
          frameCount: number;
          byteSize: number;
          createdAt: string;
        };
      }
    | { kind: 'nack'; expectedChunkSeq: number }
    | { kind: 'stale' }
  > {
    const result = await transaction(pool, async (client) => {
      const attempt = await reloadAttempt(client, message.attemptId);
      const current = await client.query<Row>(
        'SELECT current_attempt_id FROM runs WHERE id = $1 AND workspace_id = $2',
        [attempt.run_id, runner.workspaceId],
      );
      const valid =
        String(attempt.workspace_id) === runner.workspaceId &&
        String(attempt.runner_id) === runner.id &&
        String(current.rows[0]?.current_attempt_id) === String(attempt.id) &&
        !isTerminalAttempt(attempt.status as AttemptStatus);
      if (!valid) return { kind: 'stale' as const };
      const lastChunkSeq = Number(attempt.last_chunk_seq);
      if (message.chunkSeq <= lastChunkSeq)
        return { kind: 'ack' as const, chunkSeq: message.chunkSeq };
      if (message.chunkSeq !== lastChunkSeq + 1)
        return { kind: 'nack' as const, expectedChunkSeq: lastChunkSeq + 1 };
      const frames = TranscriptFramesSchema.parse(message.frames);
      const byteSize = Buffer.byteLength(JSON.stringify(frames), 'utf8');
      const chunk: Row = one<Row>(
        await client.query<Row>(
          `INSERT INTO transcript_chunks (workspace_id, attempt_id, chunk_seq, turn_id, frames, frame_count, byte_size)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [
            attempt.workspace_id,
            attempt.id,
            message.chunkSeq,
            message.turnId,
            JSON.stringify(frames),
            frames.length,
            byteSize,
          ],
        ),
        'Transcript insert did not return a row',
      );
      await client.query(
        `UPDATE attempts SET last_chunk_seq = $2 WHERE id = $1`,
        [attempt.id, message.chunkSeq],
      );
      return {
        kind: 'ack' as const,
        chunkSeq: message.chunkSeq,
        runId: String(attempt.run_id),
        chunk: {
          attemptId: String(chunk.attempt_id),
          chunkSeq: Number(chunk.chunk_seq),
          turnId: String(chunk.turn_id),
          frames: chunk.frames,
          frameCount: Number(chunk.frame_count),
          byteSize: Number(chunk.byte_size),
          createdAt: iso(chunk.created_at),
        },
      };
    });
    if (result.kind === 'ack' && result.chunk) {
      const parsed = TranscriptOutputSchema.shape.chunks.element.parse(
        result.chunk,
      );
      broadcast(result.runId ?? '', {
        type: 'transcript',
        attemptId: result.chunk.attemptId,
        chunkSeq: result.chunk.chunkSeq,
        turnId: result.chunk.turnId,
        frames: parsed.frames,
      });
    }
    return result;
  }

  async function queueAutomaticRetry(
    client: PoolClient,
    attempt: Row,
    error: RunError,
  ): Promise<boolean> {
    if (
      !error.retryable ||
      !['queued', 'claimed', 'preparing'].includes(String(attempt.status))
    )
      return false;
    const run = one(
      await client.query<Row>('SELECT * FROM runs WHERE id = $1 FOR UPDATE', [
        attempt.run_id,
      ]),
      'Run not found for automatic retry',
    );
    const retryCount = Number(run.auto_retry_count ?? 0);
    if (retryCount >= 3) return false;
    const nextRetryCount = retryCount + 1;
    const delaySeconds = Math.min(5 * 2 ** (nextRetryCount - 1), 60);
    await client.query(
      `UPDATE attempts SET status = 'failed', finished_at = now() WHERE id = $1`,
      [attempt.id],
    );
    await client.query('UPDATE runs SET auto_retry_count = $2 WHERE id = $1', [
      run.id,
      nextRetryCount,
    ]);
    await createQueuedAttempt(client, {
      workspaceId: String(run.workspace_id),
      runId: String(run.id),
      runnerId: String(run.runner_id),
      agentProfileId: String(run.agent_profile_id),
      number: Number(attempt.number) + 1,
      baseCommitSha: String(run.base_commit_sha),
      resumeFrom: { kind: 'base' },
      notBefore: new Date(Date.now() + delaySeconds * 1000),
    });
    return true;
  }

  async function createQueuedAttempt(
    client: PoolClient,
    input: {
      workspaceId: string;
      runId: string;
      runnerId: string;
      agentProfileId: string;
      number: number;
      baseCommitSha: string;
      resumeFrom: unknown;
      notBefore?: Date;
    },
  ): Promise<Row> {
    const branchName = `aw/${shortRunId(input.runId)}/a${input.number}`;
    const attempt = one(
      await client.query<Row>(
        `INSERT INTO attempts
          (workspace_id, run_id, number, runner_id, agent_profile_id, status, resume_from, branch_name, base_commit_sha, not_before)
         VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, $8, $9) RETURNING *`,
        [
          input.workspaceId,
          input.runId,
          input.number,
          input.runnerId,
          input.agentProfileId,
          input.resumeFrom,
          branchName,
          input.baseCommitSha,
          input.notBefore ?? null,
        ],
      ),
      'Attempt insert did not return a row',
    );
    const eventRow = await appendServerEvent(
      client,
      attempt,
      'attempt.queued',
      {},
    );
    await client.query(
      `UPDATE runs SET current_attempt_id = $2, status = 'pending', finished_at = NULL WHERE id = $1`,
      [input.runId, attempt.id],
    );
    await client.query(`SELECT pg_notify('aw_wake', $1)`, [
      JSON.stringify({ kind: 'work', runnerId: input.runnerId }),
    ]);
    return {
      ...attempt,
      last_sequence: Number(eventRow.sequence),
      last_client_seq: 0,
      last_chunk_seq: 0,
    };
  }

  async function findRunForAttempt(
    attemptId: string,
    workspaceId: string,
  ): Promise<Row | undefined> {
    const result = await pool.query<Row>(
      'SELECT * FROM attempts WHERE id = $1 AND workspace_id = $2',
      [attemptId, workspaceId],
    );
    return result.rows[0];
  }

  async function sendAttemptControl(
    attemptId: string,
    workspaceId: string,
    message: ServerMessage,
  ): Promise<boolean> {
    const row = await findRunForAttempt(attemptId, workspaceId);
    if (!row) return false;
    return sendRunner(String(row.runner_id), message);
  }

  app.setErrorHandler((error, request, reply) => {
    const status = Number(
      error instanceof Error && 'statusCode' in error
        ? ((error as Error & { statusCode?: number }).statusCode ?? 500)
        : 500,
    );
    const message =
      error instanceof Error ? error.message : 'Unknown server error';
    if (error instanceof Error && error.name === 'ZodError') {
      reply.code(400).send(errorBody('invalid_request', message));
      return;
    }
    if (status >= 500) request.log.error(error);
    reply
      .code(status)
      .send(
        errorBody(status >= 500 ? 'internal_error' : 'request_error', message),
      );
  });

  app.post('/api/v1/auth/register', async (request, reply) => {
    if (!sameOrigin(request, config.publicOrigin)) {
      reply
        .code(403)
        .send(errorBody('csrf', 'Origin does not match PUBLIC_ORIGIN'));
      return;
    }
    const body = parseBody(
      {
        parse(value: unknown) {
          const input = value as Record<string, unknown>;
          if (
            typeof input.email !== 'string' ||
            typeof input.password !== 'string' ||
            typeof input.displayName !== 'string'
          )
            throw new Error('email, password and displayName are required');
          if (input.password.length < 8)
            throw new Error('password must contain at least 8 characters');
          return {
            email: input.email.trim().toLowerCase(),
            password: input.password,
            displayName: input.displayName.trim(),
          };
        },
      },
      request.body,
    );
    const result = await transaction(pool, async (client) => {
      const count = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM users',
      );
      if (Number(count.rows[0]?.count ?? 0) > 0)
        throw Object.assign(
          new Error('Registration is closed; ask a workspace admin for access'),
          { statusCode: 403 },
        );
      const user = one(
        await client.query<Row>(
          `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING *`,
          [
            body.email,
            await argon2.hash(body.password, { type: argon2.argon2id }),
            body.displayName,
          ],
        ),
        'User insert failed',
      );
      const workspace = one(
        await client.query<Row>(
          'SELECT * FROM workspaces ORDER BY created_at, id LIMIT 1',
        ),
        'Workspace bootstrap missing',
      );
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`,
        [workspace.id, user.id],
      );
      return { user, workspace };
    });
    const sessionId = newToken('sess_', 32);
    await pool.query(
      `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '14 days')`,
      [sessionId, result.user.id],
    );
    reply.setCookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.nodeEnv === 'production',
      path: '/',
      maxAge: AUTH_SESSION_MS / 1000,
    });
    reply.code(201).send({
      user: mapUser(result.user),
      workspace: mapWorkspace(result.workspace),
    });
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    if (!sameOrigin(request, config.publicOrigin)) {
      reply
        .code(403)
        .send(errorBody('csrf', 'Origin does not match PUBLIC_ORIGIN'));
      return;
    }
    const body = parseBody(
      {
        parse(value: unknown) {
          const input = value as Record<string, unknown>;
          if (
            typeof input.email !== 'string' ||
            typeof input.password !== 'string'
          )
            throw new Error('email and password are required');
          return {
            email: input.email.trim().toLowerCase(),
            password: input.password,
          };
        },
      },
      request.body,
    );
    const result = await pool.query<Row>(
      'SELECT * FROM users WHERE email = $1 LIMIT 1',
      [body.email],
    );
    const user = result.rows[0];
    if (
      !user ||
      !(await argon2.verify(String(user.password_hash), body.password))
    ) {
      reply
        .code(401)
        .send(errorBody('invalid_credentials', 'Invalid email or password'));
      return;
    }
    const sessionId = newToken('sess_', 32);
    await pool.query(
      `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '14 days')`,
      [sessionId, user.id],
    );
    reply.setCookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.nodeEnv === 'production',
      path: '/',
      maxAge: AUTH_SESSION_MS / 1000,
    });
    reply.send({ user: mapUser(user) });
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    if (!sameOrigin(request, config.publicOrigin)) {
      reply
        .code(403)
        .send(errorBody('csrf', 'Origin does not match PUBLIC_ORIGIN'));
      return;
    }
    const raw = request.cookies?.[SESSION_COOKIE];
    if (raw) await pool.query('DELETE FROM sessions WHERE id = $1', [raw]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    reply.code(204).send();
  });

  app.get('/api/v1/me', async (request, reply) => {
    const auth = await requireAuth(request as RequestWithAuth, reply);
    if (!auth) return;
    const output = MeOutputSchema.parse(auth);
    reply.send(output);
  });

  app.get('/api/v1/tasks', async (request, reply) => {
    const auth = await requireAuth(request as RequestWithAuth, reply);
    if (!auth) return;
    const result = await pool.query<Row>(
      'SELECT * FROM tasks WHERE workspace_id = $1 ORDER BY updated_at DESC, id',
      [auth.workspace.id],
    );
    reply.send(result.rows.map(mapTask));
  });
  app.get('/api/v1/tasks/:id', async (request, reply) => {
    const auth = await requireAuth(request as RequestWithAuth, reply);
    if (!auth) return;
    const id = String((request.params as { id: string }).id);
    const result = await pool.query<Row>(
      'SELECT * FROM tasks WHERE id = $1 AND workspace_id = $2',
      [id, auth.workspace.id],
    );
    if (!result.rows[0]) {
      reply.code(404).send(errorBody('not_found', 'Task not found'));
      return;
    }
    reply.send(mapTask(result.rows[0]));
  });
  app.get('/api/v1/tasks/:taskId/runs', async (request, reply) => {
    const auth = await requireAuth(request as RequestWithAuth, reply);
    if (!auth) return;
    const taskId = String((request.params as { taskId: string }).taskId);
    const task = await pool.query(
      'SELECT 1 FROM tasks WHERE id = $1 AND workspace_id = $2',
      [taskId, auth.workspace.id],
    );
    if (!task.rowCount) {
      reply.code(404).send(errorBody('not_found', 'Task not found'));
      return;
    }
    const result = await pool.query<Row>(
      'SELECT * FROM runs WHERE task_id = $1 AND workspace_id = $2 ORDER BY created_at DESC, id',
      [taskId, auth.workspace.id],
    );
    reply.send(result.rows.map(mapRun));
  });

  app.post('/api/v1/tasks', async (request, reply) => {
    const auth = await ensureWorkspace(request as RequestWithAuth, reply);
    if (!auth) return;
    const body = parseBody(CreateTaskInputSchema, request.body);
    const row = one(
      await pool.query<Row>(
        `INSERT INTO tasks (workspace_id, title, description, status, priority, repository_id, created_by)
         VALUES ($1, $2, $3, COALESCE($4, 'backlog'), $5, $6, $7) RETURNING *`,
        [
          auth.workspace.id,
          body.title,
          body.description,
          body.status ?? null,
          body.priority ?? null,
          body.repositoryId,
          auth.user.id,
        ],
      ),
      'Task insert failed',
    );
    reply.code(201).send(mapTask(row));
  });

  app.patch('/api/v1/tasks/:id', async (request, reply) => {
    const auth = await ensureWorkspace(request as RequestWithAuth, reply);
    if (!auth) return;
    const body = parseBody(UpdateTaskInputSchema, request.body);
    const id = String((request.params as { id: string }).id);
    const fields: string[] = [];
    const values: unknown[] = [id, auth.workspace.id, body.revision];
    const add = (column: string, value: unknown) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };
    if (body.title !== undefined) add('title', body.title);
    if (body.description !== undefined) add('description', body.description);
    if (body.status !== undefined) add('status', body.status);
    if (body.priority !== undefined) add('priority', body.priority);
    if (body.repositoryId !== undefined)
      add('repository_id', body.repositoryId);
    if (fields.length === 0) {
      const current = await pool.query<Row>(
        'SELECT * FROM tasks WHERE id = $1 AND workspace_id = $2',
        [id, auth.workspace.id],
      );
      if (!current.rows[0])
        reply.code(404).send(errorBody('not_found', 'Task not found'));
      else reply.send(mapTask(current.rows[0]));
      return;
    }
    fields.push('revision = revision + 1');
    const row = await pool.query<Row>(
      `UPDATE tasks SET ${fields.join(', ')} WHERE id = $1 AND workspace_id = $2 AND revision = $3 RETURNING *`,
      values,
    );
    if (!row.rows[0]) {
      const exists = await pool.query(
        'SELECT 1 FROM tasks WHERE id = $1 AND workspace_id = $2',
        [id, auth.workspace.id],
      );
      reply
        .code(exists.rowCount ? 409 : 404)
        .send(
          errorBody(
            exists.rowCount ? 'revision_conflict' : 'not_found',
            exists.rowCount ? 'Task revision is stale' : 'Task not found',
          ),
        );
      return;
    }
    reply.send(mapTask(row.rows[0]));
  });

  app.get('/api/v1/repositories', async (request, reply) => {
    const auth = await requireAuth(request as RequestWithAuth, reply);
    if (!auth) return;
    const result = await pool.query<Row>(
      'SELECT * FROM repositories WHERE workspace_id = $1 ORDER BY name, id',
      [auth.workspace.id],
    );
    reply.send(result.rows.map(mapRepository));
  });

  app.post('/api/v1/repositories', async (request, reply) => {
    const auth = await ensureWorkspace(request as RequestWithAuth, reply);
    if (!auth) return;
    const body = parseBody(RegisterRepositoryInputSchema, request.body);
    const row = one(
      await pool.query<Row>(
        `INSERT INTO repositories (workspace_id, name, remote_url, default_ref)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (workspace_id, remote_url) WHERE remote_url IS NOT NULL
         DO UPDATE SET name = EXCLUDED.name, default_ref = EXCLUDED.default_ref, updated_at = now()
         RETURNING *`,
        [auth.workspace.id, body.name, body.remoteUrl, body.defaultRef],
      ),
      'Repository insert failed',
    );
    reply.code(201).send({
      repositoryId: String(row.id),
      created: row.created_at === row.updated_at,
    });
  });

  app.get('/api/v1/runners', async (request, reply) => {
    const auth = await requireAuth(request as RequestWithAuth, reply);
    if (!auth) return;
    const result = await pool.query<Row>(
      'SELECT * FROM runners WHERE workspace_id = $1 ORDER BY created_at, id',
      [auth.workspace.id],
    );
    reply.send(result.rows.map(mapRunner));
  });

  app.post('/api/v1/runners', async (request, reply) => {
    const auth = await ensureWorkspace(request as RequestWithAuth, reply);
    if (!auth) return;
    const body = parseBody(CreateRunnerInputSchema, request.body);
    const pairingCode = newToken('pair_', 16);
    const codeHash = hashToken(pairingCode);
    const row = one(
      await pool.query<Row>(
        `INSERT INTO runners (workspace_id, name, kind, max_concurrency, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [
          auth.workspace.id,
          body.name,
          body.kind,
          body.maxConcurrency ?? 2,
          auth.user.id,
        ],
      ),
      'Runner insert failed',
    );
    await pool.query(
      `INSERT INTO runner_pairing_codes (workspace_id, runner_id, code_hash, expires_at, created_by)
       VALUES ($1, $2, $3, now() + interval '10 minutes', $4)`,
      [auth.workspace.id, row.id, codeHash, auth.user.id],
    );
    reply.code(201).send({
      runner: mapRunner(row),
      pairingCode,
      expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
    });
  });

  app.post('/api/v1/runners/pair', async (request, reply) => {
    const body = parseBody(PairRunnerInputSchema, request.body);
    const result = await transaction(pool, async (client) => {
      const pairing = one(
        await client.query<Row>(
          `SELECT * FROM runner_pairing_codes WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
          [hashToken(body.pairingCode)],
        ),
        'Pairing code is invalid or expired',
      );
      const runnerToken = newToken('awr_', 32);
      const runner = one(
        await client.query<Row>(
          `UPDATE runners SET name = $2, daemon_version = $3, os = $4, arch = $5, token_hash = $6,
                  token_rotated_at = now(), status = 'offline', updated_at = now()
           WHERE id = $1 AND workspace_id = $7 AND status <> 'revoked' RETURNING *`,
          [
            pairing.runner_id,
            body.name,
            body.daemonVersion,
            body.os,
            body.arch,
            hashToken(runnerToken),
            pairing.workspace_id,
          ],
        ),
        'Runner pairing failed',
      );
      await client.query(
        `UPDATE runner_pairing_codes SET used_at = now() WHERE id = $1`,
        [pairing.id],
      );
      return { runner, runnerToken };
    });
    reply.send({
      runnerId: result.runner.id,
      workspaceId: result.runner.workspace_id,
      runnerToken: result.runnerToken,
    });
  });

  app.post('/api/v1/runners/me/rotate-token', async (request, reply) => {
    const runner = await runnerContext(request as RequestWithRunner, reply);
    if (!runner) return;
    const token = newToken('awr_', 32);
    await pool.query(
      `UPDATE runners SET previous_token_hash = token_hash, previous_token_expires_at = now() + interval '60 seconds',
              token_hash = $2, token_rotated_at = now() WHERE id = $1`,
      [runner.id, hashToken(token)],
    );
    reply.send({ runnerToken: token });
  });

  app.get('/api/v1/runners/me/agent-profiles', async (request, reply) => {
    const runner = await runnerContext(request as RequestWithRunner, reply);
    if (!runner) return;
    const result = await pool.query<Row>(
      'SELECT * FROM agent_profiles WHERE workspace_id = $1 AND runner_id = $2 ORDER BY display_name, id',
      [runner.workspaceId, runner.id],
    );
    reply.send(result.rows.map(mapAgentProfile));
  });

  app.post('/api/v1/runners/:id/revoke', async (request, reply) => {
    const auth = await ensureWorkspace(request as RequestWithAuth, reply);
    if (!auth) return;
    const runnerId = String((request.params as { id: string }).id);
    const result = await pool.query(
      `UPDATE runners SET status = 'revoked', revoked_at = now(), token_hash = NULL,
              previous_token_hash = NULL, previous_token_expires_at = NULL
       WHERE id = $1 AND workspace_id = $2`,
      [runnerId, auth.workspace.id],
    );
    const socket = runnerSockets.get(runnerId);
    if (socket) await closeQuietly(socket);
    if (!result.rowCount)
      reply.code(404).send(errorBody('not_found', 'Runner not found'));
    else reply.code(204).send();
  });

  app.get('/api/v1/agent-profiles', async (request, reply) => {
    const auth = await requireAuth(request as RequestWithAuth, reply);
    if (!auth) return;
    const result = await pool.query<Row>(
      'SELECT * FROM agent_profiles WHERE workspace_id = $1 ORDER BY display_name, id',
      [auth.workspace.id],
    );
    reply.send(result.rows.map(mapAgentProfile));
  });

  app.post('/api/v1/agent-profiles', async (request, reply) => {
    const auth = await ensureWorkspace(request as RequestWithAuth, reply);
    if (!auth) return;
    const body = parseBody(CreateAgentProfileInputSchema, request.body);
    const runner = await pool.query(
      "SELECT 1 FROM runners WHERE id = $1 AND workspace_id = $2 AND status <> 'revoked'",
      [body.runnerId, auth.workspace.id],
    );
    if (!runner.rowCount) {
      reply
        .code(400)
        .send(
          errorBody(
            'invalid_runner',
            'Runner is not available in this workspace',
          ),
        );
      return;
    }
    const row = one(
      await pool.query<Row>(
        `INSERT INTO agent_profiles (workspace_id, runner_id, engine, display_name, launch, default_model)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [
          auth.workspace.id,
          body.runnerId,
          body.engine,
          body.displayName,
          body.launch,
          body.defaultModel ?? null,
        ],
      ),
      'Agent profile insert failed',
    );
    reply.code(201).send(mapAgentProfile(row));
  });

  app.patch('/api/v1/agent-profiles/:id', async (request, reply) => {
    const auth = await ensureWorkspace(request as RequestWithAuth, reply);
    if (!auth) return;
    const body = parseBody(UpdateAgentProfileInputSchema, request.body);
    const profileId = String((request.params as { id: string }).id);
    const fields: string[] = [];
    const values: unknown[] = [profileId, auth.workspace.id];
    const add = (column: string, value: unknown) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };
    if (body.engine !== undefined) add('engine', body.engine);
    if (body.displayName !== undefined) add('display_name', body.displayName);
    if (body.launch !== undefined) add('launch', body.launch);
    if (body.defaultModel !== undefined)
      add('default_model', body.defaultModel);
    if (!fields.length) {
      const current = await pool.query<Row>(
        'SELECT * FROM agent_profiles WHERE id = $1 AND workspace_id = $2',
        [profileId, auth.workspace.id],
      );
      if (!current.rows[0])
        reply.code(404).send(errorBody('not_found', 'Agent profile not found'));
      else reply.send(mapAgentProfile(current.rows[0]));
      return;
    }
    const result = await pool.query<Row>(
      `UPDATE agent_profiles SET ${fields.join(', ')} WHERE id = $1 AND workspace_id = $2 RETURNING *`,
      values,
    );
    if (!result.rows[0])
      reply.code(404).send(errorBody('not_found', 'Agent profile not found'));
    else reply.send(mapAgentProfile(result.rows[0]));
  });

  app.post('/api/v1/tasks/:taskId/runs', async (request, reply) => {
    const auth = await ensureWorkspace(request as RequestWithAuth, reply);
    if (!auth) return;
    const body = parseBody(CreateRunInputSchema, request.body);
    const params = request.params;
    if (
      !params ||
      typeof params !== 'object' ||
      !('taskId' in params) ||
      typeof params.taskId !== 'string'
    )
      throw httpError(400, 'Task id is required');
    const taskId = params.taskId;
    const task = one(
      await pool.query<Row>(
        'SELECT * FROM tasks WHERE id = $1 AND workspace_id = $2',
        [taskId, auth.workspace.id],
      ),
      'Task not found',
    );
    if (!task.repository_id)
      throw httpError(400, 'Task must select a repository');
    const profile = one(
      await pool.query<Row>(
        'SELECT * FROM agent_profiles WHERE id = $1 AND workspace_id = $2',
        [body.agentProfileId, auth.workspace.id],
      ),
      'Agent profile not found',
    );
    if (String(profile.runner_id) !== body.runnerId)
      throw httpError(
        400,
        'Agent profile does not belong to the selected runner',
      );
    const repository = one(
      await pool.query<Row>(
        "SELECT * FROM repositories WHERE id = $1 AND workspace_id = $2 AND status = 'active'",
        [task.repository_id, auth.workspace.id],
      ),
      'Task repository not found',
    );
    const baseCommitSha = await resolveRepositoryRef(
      body.runnerId,
      String(repository.id),
      body.baseRef,
    );
    const result = await transaction(pool, async (client) => {
      const lockedTask = one(
        await client.query<Row>(
          'SELECT * FROM tasks WHERE id = $1 AND workspace_id = $2 FOR UPDATE',
          [taskId, auth.workspace.id],
        ),
        'Task not found',
      );
      if (String(lockedTask.repository_id) !== String(repository.id))
        throw httpError(
          409,
          'Task repository changed while resolving the latest commit; retry the Run',
        );
      const lockedProfile = one(
        await client.query<Row>(
          'SELECT * FROM agent_profiles WHERE id = $1 AND workspace_id = $2',
          [body.agentProfileId, auth.workspace.id],
        ),
        'Agent profile not found',
      );
      if (String(lockedProfile.runner_id) !== body.runnerId)
        throw httpError(
          400,
          'Agent profile does not belong to the selected runner',
        );
      const lockedRepository = one(
        await client.query<Row>(
          "SELECT * FROM repositories WHERE id = $1 AND workspace_id = $2 AND status = 'active'",
          [lockedTask.repository_id, auth.workspace.id],
        ),
        'Task repository not found',
      );
      const profileEngine = String(lockedProfile.engine) as AgentEngine;
      const frozenSpec: FrozenRunSpec = FrozenRunSpecSchema.parse({
        taskId,
        taskRevision: Number(lockedTask.revision),
        repositoryId: lockedRepository.id,
        baseRef: body.baseRef,
        baseCommitSha,
        runnerId: body.runnerId,
        agentProfileId: body.agentProfileId,
        engine: profileEngine,
        runConfig: body.runConfig,
        initialPrompt: body.initialPrompt,
      });
      const run = one(
        await client.query<Row>(
          `INSERT INTO runs (workspace_id, task_id, requested_by, runner_id, agent_profile_id, repository_id, base_commit_sha, frozen_spec)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [
            auth.workspace.id,
            taskId,
            auth.user.id,
            body.runnerId,
            body.agentProfileId,
            lockedRepository.id,
            baseCommitSha,
            frozenSpec,
          ],
        ),
        'Run insert failed',
      );
      const attempt = await createQueuedAttempt(client, {
        workspaceId: auth.workspace.id,
        runId: String(run.id),
        runnerId: body.runnerId,
        agentProfileId: body.agentProfileId,
        number: 1,
        baseCommitSha,
        resumeFrom: { kind: 'base' },
      });
      await client.query(
        `UPDATE tasks SET status = 'in_progress', last_run_config = $2 WHERE id = $1`,
        [taskId, body.runConfig],
      );
      return { run: { ...run, current_attempt_id: attempt.id }, attempt };
    });
    reply.code(201).send(mapRun(result.run));
  });

  app.get('/api/v1/runs/:id', async (request, reply) => {
    const auth = await requireAuth(request as RequestWithAuth, reply);
    if (!auth) return;
    const snapshot = await getRunSnapshot(
      String((request.params as { id: string }).id),
      auth.workspace.id,
    );
    if (!snapshot)
      reply.code(404).send(errorBody('not_found', 'Run not found'));
    else reply.send(snapshot);
  });

  app.post('/api/v1/runs/:id/retry', async (request, reply) => {
    const auth = await ensureWorkspace(request as RequestWithAuth, reply);
    if (!auth) return;
    const body = parseBody(RetryRunInputSchema, request.body);
    const runId = String((request.params as { id: string }).id);
    const result = await transaction(pool, async (client) => {
      const run = one(
        await client.query<Row>(
          'SELECT * FROM runs WHERE id = $1 AND workspace_id = $2 FOR UPDATE',
          [runId, auth.workspace.id],
        ),
        'Run not found',
      );
      if (!['failed', 'canceled', 'lost'].includes(String(run.status)))
        throw Object.assign(
          new Error('Only failed, canceled or lost runs can be retried'),
          { statusCode: 409 },
        );
      const previous = one(
        await client.query<Row>(
          'SELECT * FROM attempts WHERE run_id = $1 ORDER BY number DESC LIMIT 1',
          [runId],
        ),
        'Previous attempt not found',
      );
      const number = Number(previous.number) + 1;
      const baseCommitSha =
        body.resumeFrom === 'last_commit' && previous.head_commit_sha
          ? String(previous.head_commit_sha)
          : String(run.base_commit_sha);
      const attempt = await createQueuedAttempt(client, {
        workspaceId: auth.workspace.id,
        runId,
        runnerId: String(run.runner_id),
        agentProfileId: String(run.agent_profile_id),
        number,
        baseCommitSha,
        resumeFrom:
          body.resumeFrom === 'last_commit' && previous.head_commit_sha
            ? { kind: 'commit', sha: baseCommitSha, fromAttemptId: previous.id }
            : { kind: 'base' },
      });
      await client.query(
        `UPDATE tasks SET status = 'in_progress' WHERE id = $1`,
        [run.task_id],
      );
      return attempt;
    });
    reply.code(201).send({ attempt: mapAttempt(result) });
  });

  app.get('/api/v1/attempts/:id/events', async (request, reply) => {
    const auth = await requireAuth(request as RequestWithAuth, reply);
    if (!auth) return;
    const query = parseBody(EventsQuerySchema, request.query);
    const attemptId = String((request.params as { id: string }).id);
    const attempt = await pool.query<Row>(
      'SELECT run_id FROM attempts WHERE id = $1 AND workspace_id = $2',
      [attemptId, auth.workspace.id],
    );
    if (!attempt.rows[0]) {
      reply.code(404).send(errorBody('not_found', 'Attempt not found'));
      return;
    }
    const events = await pool.query<Row>(
      'SELECT * FROM run_events WHERE attempt_id = $1 AND sequence > $2 ORDER BY sequence LIMIT 10000',
      [attemptId, query.after],
    );
    reply.send({
      events: events.rows.map((row) => RunEventSchema.parse(mapRunEvent(row))),
    });
  });

  app.get('/api/v1/attempts/:id/transcript', async (request, reply) => {
    const auth = await requireAuth(request as RequestWithAuth, reply);
    if (!auth) return;
    const query = parseBody(TranscriptQuerySchema, request.query);
    const attemptId = String((request.params as { id: string }).id);
    const attempt = await pool.query<Row>(
      'SELECT 1 FROM attempts WHERE id = $1 AND workspace_id = $2',
      [attemptId, auth.workspace.id],
    );
    if (!attempt.rows[0]) {
      reply.code(404).send(errorBody('not_found', 'Attempt not found'));
      return;
    }
    const result =
      query.afterChunk !== undefined
        ? await pool.query<Row>(
            'SELECT * FROM transcript_chunks WHERE attempt_id = $1 AND chunk_seq > $2 ORDER BY chunk_seq LIMIT $3',
            [attemptId, query.afterChunk, query.limit],
          )
        : await pool.query<Row>(
            'SELECT * FROM transcript_chunks WHERE attempt_id = $1 AND chunk_seq < $2 ORDER BY chunk_seq DESC LIMIT $3',
            [attemptId, query.beforeChunk, query.limit],
          );
    const chunks = result.rows.map((row) => ({
      attemptId,
      chunkSeq: Number(row.chunk_seq),
      turnId: String(row.turn_id),
      frames: row.frames,
      frameCount: Number(row.frame_count),
      byteSize: Number(row.byte_size),
      createdAt: iso(row.created_at),
    }));
    if (query.beforeChunk !== undefined) chunks.reverse();
    reply.send(TranscriptOutputSchema.parse({ chunks }));
  });

  app.post('/api/v1/attempts/:id/prompt', async (request, reply) => {
    const auth = await ensureWorkspace(request as RequestWithAuth, reply);
    if (!auth) return;
    const input = parseBody(PromptInputSchema, request.body);
    const attemptId = String((request.params as { id: string }).id);
    const attempt = await one(
      await pool.query<Row>(
        'SELECT * FROM attempts WHERE id = $1 AND workspace_id = $2',
        [attemptId, auth.workspace.id],
      ),
      'Attempt not found',
    );
    if (attempt.status !== 'idle') {
      reply.code(409).send(errorBody('invalid_state', 'Attempt is not idle'));
      return;
    }
    const number =
      Number(
        (
          await pool.query<{ max: number | null }>(
            'SELECT max(number) AS max FROM turns WHERE attempt_id = $1',
            [attemptId],
          )
        ).rows[0]?.max ?? 0,
      ) + 1;
    const turn = one(
      await pool.query<Row>(
        `INSERT INTO turns (workspace_id, attempt_id, number, prompt, status) VALUES ($1, $2, $3, $4, 'running') RETURNING *`,
        [auth.workspace.id, attemptId, number, input.text],
      ),
      'Turn insert failed',
    );
    await pool.query(`UPDATE attempts SET status = 'running' WHERE id = $1`, [
      attemptId,
    ]);
    await pool.query(`UPDATE runs SET status = 'active' WHERE id = $1`, [
      attempt.run_id,
    ]);
    await sendAttemptControl(attemptId, auth.workspace.id, {
      type: 'attempt.prompt',
      attemptId,
      turnId: String(turn.id),
      text: input.text,
    });
    reply.code(201).send(mapTurn(turn));
  });

  app.post('/api/v1/attempts/:id/cancel', async (request, reply) => {
    const auth = await ensureWorkspace(request as RequestWithAuth, reply);
    if (!auth) return;
    const attemptId = String((request.params as { id: string }).id);
    const result = await transaction(pool, async (client) => {
      const attempt = await reloadAttempt(client, attemptId);
      if (
        String(attempt.workspace_id) !== auth.workspace.id ||
        isTerminalAttempt(attempt.status as AttemptStatus)
      )
        return attempt;
      await client.query(
        `UPDATE attempts SET cancel_requested_at = COALESCE(cancel_requested_at, now()) WHERE id = $1`,
        [attemptId],
      );
      await appendServerEvent(client, attempt, 'attempt.cancel_requested', {
        scope: 'attempt',
      });
      if (attempt.status === 'queued') {
        await client.query(
          `UPDATE attempts SET status = 'canceled', finished_at = now() WHERE id = $1`,
          [attemptId],
        );
        await projectRun(client, attempt.run_id, 'canceled');
      }
      return attempt;
    });
    if (result.status !== 'queued')
      await sendAttemptControl(attemptId, auth.workspace.id, {
        type: 'attempt.cancel',
        attemptId,
      });
    reply.code(202).send({ accepted: true });
  });

  app.post('/api/v1/attempts/:id/close', async (request, reply) => {
    const auth = await ensureWorkspace(request as RequestWithAuth, reply);
    if (!auth) return;
    const attemptId = String((request.params as { id: string }).id);
    const attempt = await findRunForAttempt(attemptId, auth.workspace.id);
    if (!attempt) {
      reply.code(404).send(errorBody('not_found', 'Attempt not found'));
      return;
    }
    await sendAttemptControl(attemptId, auth.workspace.id, {
      type: 'attempt.close',
      attemptId,
      reason: 'user',
    });
    reply.code(202).send({ accepted: true });
  });

  app.post('/api/v1/turns/:id/cancel', async (request, reply) => {
    const auth = await ensureWorkspace(request as RequestWithAuth, reply);
    if (!auth) return;
    const turnId = String((request.params as { id: string }).id);
    const result = await pool.query<Row>(
      `SELECT t.*, a.workspace_id, a.runner_id FROM turns t JOIN attempts a ON a.id = t.attempt_id WHERE t.id = $1 AND a.workspace_id = $2`,
      [turnId, auth.workspace.id],
    );
    const turn = result.rows[0];
    if (!turn) {
      reply.code(404).send(errorBody('not_found', 'Turn not found'));
      return;
    }
    await sendAttemptControl(String(turn.attempt_id), auth.workspace.id, {
      type: 'turn.cancel',
      attemptId: String(turn.attempt_id),
      turnId,
    });
    reply.code(202).send({ accepted: true });
  });

  app.post('/api/v1/approvals/:id/resolve', async (request, reply) => {
    const auth = await ensureWorkspace(request as RequestWithAuth, reply);
    if (!auth) return;
    const body = parseBody(ResolveApprovalInputSchema, request.body);
    const approvalId = String((request.params as { id: string }).id);
    const result = await transaction(pool, async (client) => {
      const approval = one(
        await client.query<Row>(
          'SELECT * FROM approval_requests WHERE id = $1 AND workspace_id = $2 FOR UPDATE',
          [approvalId, auth.workspace.id],
        ),
        'Approval request not found',
      );
      if (approval.status !== 'pending')
        throw Object.assign(new Error('Approval request is already resolved'), {
          statusCode: 409,
        });
      const updated = one(
        await client.query<Row>(
          `UPDATE approval_requests SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1 RETURNING *`,
          [
            approvalId,
            body.decision === 'deny' ? 'denied' : 'approved',
            auth.user.id,
          ],
        ),
        'Approval update failed',
      );
      const attempt = await reloadAttempt(client, String(approval.attempt_id));
      await appendServerEvent(
        client,
        attempt,
        'approval.resolved',
        {
          requestId: approval.request_id,
          decision: body.decision,
          decidedBy: auth.user.id,
        },
        String(approval.turn_id),
      );
      await client.query(
        `UPDATE attempts SET status = 'running' WHERE id = $1 AND status = 'waiting_approval'`,
        [approval.attempt_id],
      );
      await client.query(
        `UPDATE turns SET status = 'running' WHERE id = $1 AND status = 'waiting_approval'`,
        [approval.turn_id],
      );
      await projectRun(client, attempt.run_id, 'running');
      return updated;
    });
    const approval = mapApproval(result);
    await sendAttemptControl(String(result.attempt_id), auth.workspace.id, {
      type: 'approval.resolved',
      attemptId: String(result.attempt_id),
      requestId: String(result.request_id),
      decision: body.decision,
    });
    reply.send(approval);
  });

  app.post('/api/v1/runners/me/repositories', async (request, reply) => {
    const runner = await runnerContext(request as RequestWithRunner, reply);
    if (!runner) return;
    const body = parseBody(RegisterRepositoryInputSchema, request.body);
    const result = await transaction(pool, async (client) => {
      let repository: Row | undefined;
      if (body.remoteUrl) {
        const existing = await client.query<Row>(
          'SELECT * FROM repositories WHERE workspace_id = $1 AND remote_url = $2',
          [runner.workspaceId, body.remoteUrl],
        );
        repository = existing.rows[0];
      }
      let created = false;
      if (!repository) {
        repository = one(
          await client.query<Row>(
            `INSERT INTO repositories (workspace_id, name, remote_url, default_ref) VALUES ($1, $2, $3, $4) RETURNING *`,
            [runner.workspaceId, body.name, body.remoteUrl, body.defaultRef],
          ),
          'Repository insert failed',
        );
        created = true;
      }
      await client.query(
        `INSERT INTO runner_repositories (workspace_id, runner_id, repository_id, access, reported_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (runner_id, repository_id) DO UPDATE SET access = EXCLUDED.access, reported_at = now(), updated_at = now()`,
        [runner.workspaceId, runner.id, repository.id, body.access],
      );
      return { repository, created };
    });
    reply.send({ repositoryId: result.repository.id, created: result.created });
  });

  app.post('/api/v1/runners/me/claim', async (request, reply) => {
    const runner = await runnerContext(request as RequestWithRunner, reply);
    if (!runner) return;
    const body = parseBody(ClaimAttemptsInputSchema, request.body);
    const claimed = await transaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        runner.id,
      ]);
      const active = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM attempts WHERE runner_id = $1 AND status IN ('claimed','preparing','running','idle','waiting_approval')`,
        [runner.id],
      );
      const free = Math.max(
        0,
        runner.maxConcurrency - Number(active.rows[0]?.count ?? 0),
      );
      if (runner.status !== 'online' || free <= 0) return [];
      const selected = await client.query<Row>(
        `SELECT a.* FROM attempts a
         WHERE a.runner_id = $1 AND a.status = 'queued' AND (a.not_before IS NULL OR a.not_before <= now())
           AND NOT EXISTS (SELECT 1 FROM attempts b WHERE b.runner_id = a.runner_id AND b.agent_profile_id = a.agent_profile_id AND b.status IN ('claimed','preparing','running','idle','waiting_approval'))
           AND a.id = (SELECT c.id FROM attempts c WHERE c.runner_id = a.runner_id AND c.agent_profile_id = a.agent_profile_id AND c.status = 'queued' AND (c.not_before IS NULL OR c.not_before <= now()) ORDER BY c.created_at, c.id LIMIT 1)
         ORDER BY a.created_at, a.id LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [runner.id, Math.min(free, body.capacity)],
      );
      const values: Array<{ attempt: Row; frozenSpec: unknown }> = [];
      for (const row of selected.rows) {
        const attempt = await reloadAttempt(client, String(row.id));
        await client.query(
          `UPDATE attempts SET status = 'claimed', claimed_at = now(), last_heartbeat_at = now(), lease_expires_at = now() + interval '45 seconds' WHERE id = $1`,
          [row.id],
        );
        await appendServerEvent(client, attempt, 'attempt.claimed', {});
        await projectRun(client, String(row.run_id), 'claimed');
        const run = one(
          await client.query<Row>(
            'SELECT frozen_spec FROM runs WHERE id = $1',
            [row.run_id],
          ),
          'Run missing',
        );
        values.push({
          attempt: {
            ...attempt,
            status: 'claimed',
            claimed_at: new Date().toISOString(),
            last_heartbeat_at: new Date().toISOString(),
            lease_expires_at: new Date(
              Date.now() + LEASE_SECONDS * 1000,
            ).toISOString(),
          },
          frozenSpec: FrozenRunSpecSchema.parse(run.frozen_spec),
        });
      }
      return values;
    });
    reply.send({
      attempts: claimed.map((item) => ({
        attempt: AttemptSchema.parse(mapAttempt(item.attempt)),
        frozenSpec: item.frozenSpec,
      })),
    });
  });

  app.post('/api/v1/attempts/:id/artifacts', async (request, reply) => {
    const runner = await runnerContext(request as RequestWithRunner, reply);
    if (!runner) return;
    const attemptId = String((request.params as { id: string }).id);
    const attempt = await findRunForAttempt(attemptId, runner.workspaceId);
    if (
      !attempt ||
      String(attempt.runner_id) !== runner.id ||
      isTerminalAttempt(attempt.status as AttemptStatus)
    ) {
      reply
        .code(409)
        .send(errorBody('stale', 'Attempt is not owned by this runner'));
      return;
    }
    const parts = request.parts();
    let fields: Record<string, string> = {};
    let tempPath: string | undefined;
    let mimeType = 'application/octet-stream';
    let sizeBytes = 0;
    let sha256 = createHash('sha256');
    try {
      for await (const part of parts) {
        if (part.type === 'field') fields[part.fieldname] = String(part.value);
        else {
          mimeType = part.mimetype;
          tempPath = join(
            config.dataDir,
            'tmp',
            `${randomUUID()}${extname(part.filename)}`,
          );
          await mkdir(dirname(tempPath), { recursive: true });
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            sizeBytes += data.byteLength;
            if (sizeBytes > MAX_UPLOAD_BYTES)
              throw Object.assign(new Error('Artifact exceeds upload limit'), {
                statusCode: 413,
              });
            sha256.update(data);
            chunks.push(data);
          }
          await writeFile(tempPath, Buffer.concat(chunks), { mode: 0o600 });
        }
      }
      const input = parseBody(UploadArtifactInputSchema, {
        kind: fields.kind,
        turnId: fields.turnId,
        sha256: fields.sha256,
      });
      const digest = sha256.digest('hex');
      if (digest !== input.sha256.toLowerCase())
        throw Object.assign(new Error('Artifact sha256 mismatch'), {
          statusCode: 400,
        });
      const max =
        input.kind === 'patch'
          ? 20 * 1024 * 1024
          : input.kind === 'log'
            ? 50 * 1024 * 1024
            : MAX_UPLOAD_BYTES;
      if (sizeBytes > max)
        throw Object.assign(new Error('Artifact exceeds kind limit'), {
          statusCode: 413,
        });
      const existing = await pool.query<Row>(
        `SELECT id FROM artifacts
         WHERE workspace_id = $1 AND attempt_id = $2
           AND turn_id IS NOT DISTINCT FROM $3
           AND kind = $4 AND sha256 = $5
         ORDER BY created_at, id LIMIT 1`,
        [
          runner.workspaceId,
          attempt.id,
          input.turnId ?? null,
          input.kind,
          input.sha256.toLowerCase(),
        ],
      );
      if (existing.rows[0]) {
        reply.code(200).send({ artifactId: String(existing.rows[0].id) });
        return;
      }
      const blobRef = join('blobs', `${digest}-${randomUUID()}`);
      const blobPath = join(config.dataDir, blobRef);
      await mkdir(dirname(blobPath), { recursive: true });
      if (tempPath) await rename(tempPath, blobPath);
      const row = one(
        await pool.query<Row>(
          `INSERT INTO artifacts (workspace_id, run_id, attempt_id, turn_id, kind, blob_ref, size_bytes, sha256, mime_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [
            runner.workspaceId,
            attempt.run_id,
            attempt.id,
            input.turnId ?? null,
            input.kind,
            blobRef,
            sizeBytes,
            input.sha256.toLowerCase(),
            mimeType,
          ],
        ),
        'Artifact insert failed',
      );
      reply.code(201).send({ artifactId: row.id });
    } finally {
      if (tempPath) await rm(tempPath, { force: true });
    }
  });

  app.get('/api/v1/artifacts/:id', async (request, reply) => {
    const auth = await requireAuth(request as RequestWithAuth, reply);
    if (!auth) return;
    const artifactId = String((request.params as { id: string }).id);
    const result = await pool.query<Row>(
      'SELECT * FROM artifacts WHERE id = $1 AND workspace_id = $2',
      [artifactId, auth.workspace.id],
    );
    const artifact = result.rows[0];
    if (!artifact) {
      reply.code(404).send(errorBody('not_found', 'Artifact not found'));
      return;
    }
    const path = join(config.dataDir, String(artifact.blob_ref));
    reply.type(String(artifact.mime_type)).send(createReadStream(path));
  });

  app.get('/api/v1/artifacts/:id/download', async (request, reply) => {
    const auth = await requireAuth(request as RequestWithAuth, reply);
    if (!auth) return;
    const artifactId = String((request.params as { id: string }).id);
    const result = await pool.query<Row>(
      'SELECT id FROM artifacts WHERE id = $1 AND workspace_id = $2',
      [artifactId, auth.workspace.id],
    );
    if (!result.rows[0]) {
      reply.code(404).send(errorBody('not_found', 'Artifact not found'));
      return;
    }
    reply.send({
      url: `/api/v1/artifacts/${artifactId}`,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
  });

  app.get('/ws/runner', { websocket: true }, async (socket, request) => {
    const runnerRequest = request as RequestWithRunner;
    const runner = await runnerContext(runnerRequest, {
      code: (status: number) => ({ send: () => undefined }),
    } as unknown as FastifyReply);
    if (!runner) {
      socket.close(1008, 'Unauthorized');
      return;
    }
    const ws = socket as unknown as WsLike;
    socketRunners.set(ws, runner.id);
    let helloReceived = false;
    ws.on('message', async (data) => {
      try {
        const message = RunnerMessageSchema.parse(JSON.parse(data.toString()));
        if (!helloReceived) {
          if (message.type !== 'runner.hello')
            throw new Error('runner.hello must be first');
          const hello = RunnerHelloSchema.parse(message);
          if (hello.protocolVersion !== PROTOCOL_VERSION)
            throw new Error('Unsupported protocol version');
          await pool.query(
            `UPDATE runners SET status = 'online', daemon_version = $2, os = $3, arch = $4, max_concurrency = $5, last_seen_at = now() WHERE id = $1 AND status <> 'revoked'`,
            [
              runner.id,
              hello.daemonVersion,
              hello.os,
              hello.arch,
              hello.maxConcurrency,
            ],
          );
          for (const agent of hello.agents)
            await pool.query(
              `UPDATE agent_profiles SET capability_snapshot = $2, capability_reported_at = now() WHERE id = $1 AND runner_id = $3 AND workspace_id = $4`,
              [
                agent.agentProfileId,
                agent.capabilities,
                runner.id,
                runner.workspaceId,
              ],
            );
          const active = await pool.query<Row>(
            `SELECT id, status, cancel_requested_at FROM attempts WHERE runner_id = $1 AND status IN ('claimed','preparing','running','idle','waiting_approval')`,
            [runner.id],
          );
          const dispositions = hello.activeAttemptIds.map((attemptId) => {
            const row = active.rows.find(
              (item) => String(item.id) === attemptId,
            );
            return {
              attemptId,
              disposition: row ? ('continue' as const) : ('stale' as const),
              controls:
                row && row.cancel_requested_at
                  ? [{ type: 'attempt.cancel' as const, attemptId }]
                  : [],
            };
          });
          const serverHello = ServerHelloSchema.parse({
            type: 'server.hello',
            protocolVersion: PROTOCOL_VERSION,
            runnerId: runner.id,
            serverTime: new Date().toISOString(),
            attempts: dispositions,
          });
          runnerSockets.set(runner.id, ws);
          helloReceived = true;
          ws.send(JSON.stringify(serverHello));
          if (hello.activeAttemptIds.length === 0)
            sendRunner(runner.id, { type: 'work.available' });
          return;
        }
        switch (message.type) {
          case 'runner.status':
            await pool.query(
              `UPDATE runners SET last_seen_at = now() WHERE id = $1`,
              [runner.id],
            );
            break;
          case 'repository.ref_resolved':
          case 'repository.ref_failed': {
            const pending = pendingRepositoryRefs.get(message.requestId);
            if (!pending) break;
            if (
              pending.socket !== ws ||
              pending.runnerId !== runner.id ||
              pending.repositoryId !== message.repositoryId ||
              pending.ref !== message.ref
            )
              throw new Error(
                'Repository ref response does not match its request',
              );
            clearTimeout(pending.timer);
            pendingRepositoryRefs.delete(message.requestId);
            if (message.type === 'repository.ref_resolved')
              pending.resolve(message.commitSha);
            else pending.reject(httpError(422, message.error));
            break;
          }
          case 'attempt.heartbeat':
            await pool.query(
              `UPDATE attempts SET last_heartbeat_at = now(), lease_expires_at = now() + interval '45 seconds' WHERE id = $1 AND runner_id = $2 AND status IN ('claimed','preparing','running','idle','waiting_approval')`,
              [message.attemptId, runner.id],
            );
            break;
          case 'attempt.event': {
            const result = await processRunnerEvent(runner, message);
            if (result.kind === 'stale')
              sendRunner(runner.id, {
                type: 'attempt.stale',
                attemptId: message.attemptId,
                reason: 'Attempt is stale or not owned by this runner',
              });
            else if (result.kind === 'nack')
              ws.send(
                JSON.stringify({
                  type: 'nack',
                  kind: 'event',
                  attemptId: message.attemptId,
                  expectedClientSeq: result.expectedClientSeq,
                }),
              );
            else
              ws.send(
                JSON.stringify(
                  EventAckSchema.parse({
                    type: 'ack',
                    kind: 'event',
                    attemptId: message.attemptId,
                    clientSeq: result.clientSeq,
                  }),
                ),
              );
            break;
          }
          case 'attempt.transcript': {
            const result = await processTranscript(runner, message);
            if (result.kind === 'stale')
              sendRunner(runner.id, {
                type: 'attempt.stale',
                attemptId: message.attemptId,
                reason: 'Attempt is stale or not owned by this runner',
              });
            else if (result.kind === 'nack')
              ws.send(
                JSON.stringify({
                  type: 'nack',
                  kind: 'transcript',
                  attemptId: message.attemptId,
                  expectedChunkSeq: result.expectedChunkSeq,
                }),
              );
            else
              ws.send(
                JSON.stringify({
                  type: 'ack',
                  kind: 'transcript',
                  attemptId: message.attemptId,
                  chunkSeq: result.chunkSeq,
                }),
              );
            break;
          }
        }
      } catch (error) {
        request.log.warn({ error }, 'Invalid runner websocket message');
        ws.close(1008, 'Invalid protocol message');
      }
    });
    ws.on('close', async () => {
      for (const [requestId, pending] of pendingRepositoryRefs) {
        if (pending.socket !== ws) continue;
        clearTimeout(pending.timer);
        pendingRepositoryRefs.delete(requestId);
        pending.reject(
          httpError(503, 'Runner connection closed during ref resolution'),
        );
      }
      socketRunners.delete(ws);
      if (runnerSockets.get(runner.id) === ws) {
        runnerSockets.delete(runner.id);
        await pool.query(
          `UPDATE runners SET status = CASE WHEN status = 'revoked' THEN status ELSE 'offline' END WHERE id = $1`,
          [runner.id],
        );
      }
    });
  });

  app.get('/ws/client', { websocket: true }, async (socket, request) => {
    const auth = await sessionContext(request);
    if (!auth) {
      socket.close(1008, 'Unauthorized');
      return;
    }
    const ws = socket as unknown as WsLike;
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString()) as {
          type?: string;
          runId?: string;
        };
        if (message.type !== 'subscribe' || typeof message.runId !== 'string')
          throw new Error('subscribe required');
        const snapshot = await getRunSnapshot(message.runId, auth.workspace.id);
        if (!snapshot) throw new Error('Run not found');
        const previous = socketSubscriptions.get(ws);
        if (previous) browserSubscriptions.get(previous)?.delete(ws);
        socketSubscriptions.set(ws, message.runId);
        const subscribers =
          browserSubscriptions.get(message.runId) ?? new Set<WsLike>();
        subscribers.add(ws);
        browserSubscriptions.set(message.runId, subscribers);
        ws.send(JSON.stringify({ type: 'run', run: snapshot.run }));
      } catch (error) {
        request.log.warn({ error }, 'Invalid browser websocket message');
        ws.close(1008, 'Invalid protocol message');
      }
    });
    ws.on('close', () => {
      const runId = socketSubscriptions.get(ws);
      if (runId) browserSubscriptions.get(runId)?.delete(ws);
      socketSubscriptions.delete(ws);
    });
  });

  if (config.serveStatic) {
    const staticRoot = resolve('apps/web/dist/client');
    await app.register(fastifyStatic, {
      root: staticRoot,
      prefix: '/',
      setHeaders(response, filePath) {
        if (
          filePath.endsWith(`${join('assets', extname(filePath))}`) ||
          filePath.includes(`${resolve(staticRoot, 'assets')}`)
        )
          response.setHeader(
            'Cache-Control',
            'public, max-age=31536000, immutable',
          );
        if (filePath.endsWith('index.html'))
          response.setHeader('Cache-Control', 'no-cache');
      },
    });
    app.addHook('onSend', async (request, reply, payload) => {
      if (
        request.method === 'GET' &&
        !request.url.startsWith('/api/') &&
        !request.url.startsWith('/ws/')
      ) {
        if (request.url === '/' || request.url.endsWith('/index.html'))
          reply.header('Cache-Control', 'no-cache');
        else if (request.url.startsWith('/assets/'))
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      }
      return payload;
    });
    app.setNotFoundHandler((request, reply) => {
      if (
        request.method === 'GET' &&
        !request.url.startsWith('/api/') &&
        !request.url.startsWith('/ws/') &&
        String(request.headers.accept ?? '').includes('text/html')
      ) {
        reply
          .type('text/html')
          .header('Cache-Control', 'no-cache')
          .sendFile('index.html');
        return;
      }
      reply.code(404).send(errorBody('not_found', 'Not found'));
    });
  }

  async function reapExpiredAttempts(): Promise<void> {
    const result = await transaction(pool, async (client) => {
      const expired = await client.query<Row>(
        `SELECT * FROM attempts WHERE status IN ('claimed','preparing','running','idle','waiting_approval') AND lease_expires_at < now() FOR UPDATE SKIP LOCKED`,
      );
      const changed: Row[] = [];
      for (const row of expired.rows) {
        const attempt = await reloadAttempt(client, String(row.id));
        const error = runError(
          'lost',
          'Runner heartbeat timeout',
          ['claimed', 'preparing'].includes(String(row.status)),
        );
        await client.query(
          `UPDATE attempts SET status = 'lost', finished_at = now(), error = $2 WHERE id = $1`,
          [row.id, error],
        );
        await client.query(
          `UPDATE approval_requests SET status = 'expired', updated_at = now() WHERE attempt_id = $1 AND status = 'pending'`,
          [row.id],
        );
        await appendServerEvent(client, attempt, 'attempt.lost', {});
        await projectRun(client, String(row.run_id), 'lost');
        if (error.retryable)
          await queueAutomaticRetry(
            client,
            { ...attempt, status: String(row.status) },
            error,
          );
        changed.push({ ...row, status: 'lost', error });
      }
      return changed;
    });
    for (const row of result) {
      const event = await pool.query<Row>(
        'SELECT * FROM run_events WHERE attempt_id = $1 ORDER BY sequence DESC LIMIT 1',
        [row.id],
      );
      const eventRow = event.rows[0];
      if (eventRow)
        broadcast(String(row.run_id), {
          type: 'event',
          attemptId: String(row.id),
          sequence: Number(eventRow.sequence),
          event: RunEventSchema.parse(mapRunEvent(eventRow)),
        });
    }
  }

  app.addHook('onReady', async () => {
    notificationClient = await pool.connect();
    await notificationClient.query('LISTEN aw_wake');
    notificationClient.on('notification', (notification) => {
      if (notification.channel !== 'aw_wake') return;
      try {
        const payload = JSON.parse(notification.payload ?? '{}') as {
          kind?: string;
          runnerId?: string;
        };
        if (payload.kind === 'work' && payload.runnerId)
          sendRunner(payload.runnerId, { type: 'work.available' });
      } catch {
        app.log.warn('Ignoring malformed aw_wake notification');
      }
    });
    reaperTimer = setInterval(() => {
      void reapExpiredAttempts().catch((error) =>
        app.log.error(error, 'Attempt reaper failed'),
      );
    }, REAPER_INTERVAL_MS);
  });

  app.addHook('onClose', async () => {
    if (reaperTimer) clearInterval(reaperTimer);
    if (notificationClient) notificationClient.release();
    for (const socket of runnerSockets.values()) await closeQuietly(socket);
    if (!options.pool) await pool.end();
  });

  return app;
}

export { resolveConfig };
