import { z } from 'zod';
import {
  CommitShaSchema,
  CountSchema,
  IdSchema,
  JsonObjectSchema,
  JsonValueSchema,
  NameSchema,
  SequenceSchema,
  Sha256Schema,
  TextSchema,
  TimestampSchema,
} from './validation.js';

export const WorkspaceSchema = z.strictObject({
  id: IdSchema,
  name: NameSchema,
  slug: NameSchema,
  createdAt: TimestampSchema,
});
export type Workspace = z.infer<typeof WorkspaceSchema>;
export const UserSchema = z.strictObject({
  id: IdSchema,
  email: z.email().max(320),
  displayName: NameSchema,
  createdAt: TimestampSchema,
});
export type User = z.infer<typeof UserSchema>;
export const WorkspaceRoleSchema = z.enum(['admin', 'member']);
export type WorkspaceRole = z.infer<typeof WorkspaceRoleSchema>;
export const WorkspaceMemberSchema = z.strictObject({
  workspaceId: IdSchema,
  userId: IdSchema,
  role: WorkspaceRoleSchema,
});
export type WorkspaceMember = z.infer<typeof WorkspaceMemberSchema>;
export const RepositoryStatusSchema = z.enum(['active', 'archived']);
export type RepositoryStatus = z.infer<typeof RepositoryStatusSchema>;
export const RepositoryAccessSchema = z.enum(['read', 'write']);
export type RepositoryAccess = z.infer<typeof RepositoryAccessSchema>;
export const RepositorySchema = z.strictObject({
  id: IdSchema,
  workspaceId: IdSchema,
  name: NameSchema,
  remoteUrl: TextSchema.nullable(),
  defaultRef: NameSchema,
  status: RepositoryStatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Repository = z.infer<typeof RepositorySchema>;
export const RunnerRepositorySchema = z.strictObject({
  runnerId: IdSchema,
  repositoryId: IdSchema,
  access: RepositoryAccessSchema,
  reportedAt: TimestampSchema,
});
export type RunnerRepository = z.infer<typeof RunnerRepositorySchema>;
export const RunnerKindSchema = z.enum(['local', 'vps']);
export type RunnerKind = z.infer<typeof RunnerKindSchema>;
export const RunnerStatusSchema = z.enum([
  'offline',
  'online',
  'draining',
  'revoked',
]);
export type RunnerStatus = z.infer<typeof RunnerStatusSchema>;
export const RunnerSchema = z.strictObject({
  id: IdSchema,
  workspaceId: IdSchema,
  name: NameSchema,
  kind: RunnerKindSchema,
  status: RunnerStatusSchema,
  daemonVersion: NameSchema.optional(),
  os: NameSchema.optional(),
  arch: NameSchema.optional(),
  maxConcurrency: SequenceSchema,
  lastSeenAt: TimestampSchema.optional(),
  createdBy: IdSchema,
  createdAt: TimestampSchema,
});
export type Runner = z.infer<typeof RunnerSchema>;
export const AgentEngineSchema = z.enum([
  'claude-code',
  'codex',
  'pi',
  'custom',
]);
export type AgentEngine = z.infer<typeof AgentEngineSchema>;
export const AgentLaunchSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('managed') }),
  z.strictObject({
    kind: z.literal('custom'),
    command: NameSchema,
    args: z.array(TextSchema).max(256),
  }),
]);
export type AgentLaunch = z.infer<typeof AgentLaunchSchema>;
export const ToolPolicySchema = z.strictObject({
  filesystem: z.enum(['worktree_only', 'host_full']),
  network: z.enum(['none', 'unrestricted']),
  shell: z.enum(['deny', 'ask', 'allow']),
  gitPush: z.boolean(),
});
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;
export const EnforcementSchema = z.enum(['runner', 'engine', 'none']);
export type Enforcement = z.infer<typeof EnforcementSchema>;
export const EnforcementReportSchema = z.strictObject({
  filesystem: EnforcementSchema,
  network: EnforcementSchema,
  shell: EnforcementSchema,
  gitPush: EnforcementSchema,
});
export type EnforcementReport = z.infer<typeof EnforcementReportSchema>;
/** `acp`: Agent Client Protocol peer; `sdk`: in-process engine SDK; `rpc`: engine-native stdio protocol (pi RPC mode, Codex app-server). */
export const AgentProtocolSchema = z.enum(['acp', 'sdk', 'rpc']);
export type AgentProtocol = z.infer<typeof AgentProtocolSchema>;
export const AgentCapabilitiesSchema = z.strictObject({
  protocol: AgentProtocolSchema,
  engineVersion: NameSchema,
  models: z.array(NameSchema).max(1024),
  supports: z.strictObject({
    cancel: z.boolean(),
    steer: z.boolean(),
    permissionRequests: z.boolean(),
    fileEvents: z.boolean(),
    planUpdates: z.boolean(),
  }),
  enforcement: EnforcementReportSchema,
});
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;
export const AgentProfileSchema = z.strictObject({
  id: IdSchema,
  workspaceId: IdSchema,
  runnerId: IdSchema,
  engine: AgentEngineSchema,
  displayName: NameSchema,
  launch: AgentLaunchSchema,
  defaultModel: NameSchema.optional(),
  capabilitySnapshot: AgentCapabilitiesSchema.optional(),
  capabilityReportedAt: TimestampSchema.optional(),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;
export const PermissionModeSchema = z.enum(['ask', 'auto_edit', 'bypass']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;
export const ReasoningEffortSchema = z.enum(['low', 'medium', 'high']);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
export const RunConfigSchema = z.strictObject({
  agentProfileId: IdSchema,
  model: NameSchema.optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
  permissionMode: PermissionModeSchema,
  toolPolicy: ToolPolicySchema,
  systemPromptPrefix: TextSchema.optional(),
  idleTimeoutMinutes: z.number().positive().finite(),
  maxTurnMinutes: z.number().positive().finite(),
});
export type RunConfig = z.infer<typeof RunConfigSchema>;
export const TaskStatusSchema = z.enum([
  'backlog',
  'todo',
  'in_progress',
  'needs_review',
  'done',
  'canceled',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export const TaskPrioritySchema = z.enum(['urgent', 'high', 'medium', 'low']);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;
export const TaskSchema = z.strictObject({
  id: IdSchema,
  workspaceId: IdSchema,
  title: NameSchema,
  description: TextSchema,
  status: TaskStatusSchema,
  priority: TaskPrioritySchema.optional(),
  repositoryId: IdSchema.nullable(),
  lastRunConfig: RunConfigSchema.optional(),
  revision: CountSchema,
  createdBy: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Task = z.infer<typeof TaskSchema>;
export const FrozenRunSpecSchema = z
  .strictObject({
    taskId: IdSchema,
    taskRevision: CountSchema,
    repositoryId: IdSchema,
    baseRef: NameSchema,
    baseCommitSha: CommitShaSchema,
    runnerId: IdSchema,
    agentProfileId: IdSchema,
    engine: AgentEngineSchema,
    runConfig: RunConfigSchema,
    initialPrompt: TextSchema,
  })
  .refine(
    (spec) => spec.agentProfileId === spec.runConfig.agentProfileId,
    'RunConfig must use the frozen agent profile',
  );
export type FrozenRunSpec = z.infer<typeof FrozenRunSpecSchema>;
export const RunStatusSchema = z.enum([
  'pending',
  'active',
  'idle',
  'waiting_approval',
  'completed',
  'failed',
  'canceled',
  'lost',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;
export const RunSchema = z.strictObject({
  id: IdSchema,
  taskId: IdSchema,
  workspaceId: IdSchema,
  requestedBy: IdSchema,
  status: RunStatusSchema,
  frozenSpec: FrozenRunSpecSchema,
  currentAttemptId: IdSchema.optional(),
  createdAt: TimestampSchema,
  startedAt: TimestampSchema.optional(),
  finishedAt: TimestampSchema.optional(),
});
export type Run = z.infer<typeof RunSchema>;
export const AttemptStatusSchema = z.enum([
  'queued',
  'claimed',
  'preparing',
  'running',
  'idle',
  'waiting_approval',
  'completed',
  'failed',
  'canceled',
  'lost',
]);
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;
export const ResumeFromSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('base') }),
  z.strictObject({
    kind: z.literal('commit'),
    sha: CommitShaSchema,
    fromAttemptId: IdSchema,
  }),
]);
export type ResumeFrom = z.infer<typeof ResumeFromSchema>;
export const RunErrorCodeSchema = z.enum([
  'runner_offline',
  'repository_not_registered',
  'worktree_failed',
  'agent_start_failed',
  'agent_crashed',
  'turn_timeout',
  'provider_rate_limit',
  'provider_auth',
  'invalid_config',
  'canceled',
  'lost',
  'unknown',
]);
export type RunErrorCode = z.infer<typeof RunErrorCodeSchema>;
export const RunErrorSchema = z.strictObject({
  code: RunErrorCodeSchema,
  message: TextSchema,
  retryable: z.boolean(),
  detail: JsonValueSchema.optional(),
});
export type RunError = z.infer<typeof RunErrorSchema>;
export const AttemptSchema = z.strictObject({
  id: IdSchema,
  runId: IdSchema,
  number: SequenceSchema,
  runnerId: IdSchema,
  agentProfileId: IdSchema,
  status: AttemptStatusSchema,
  resumeFrom: ResumeFromSchema,
  branchName: NameSchema,
  baseCommitSha: CommitShaSchema,
  headCommitSha: CommitShaSchema.optional(),
  notBefore: TimestampSchema.optional(),
  leaseExpiresAt: TimestampSchema.optional(),
  lastHeartbeatAt: TimestampSchema.optional(),
  enforcement: EnforcementReportSchema.optional(),
  cancelRequestedAt: TimestampSchema.optional(),
  error: RunErrorSchema.optional(),
  createdAt: TimestampSchema,
  claimedAt: TimestampSchema.optional(),
  startedAt: TimestampSchema.optional(),
  finishedAt: TimestampSchema.optional(),
});
export type Attempt = z.infer<typeof AttemptSchema>;
export const TurnStatusSchema = z.enum([
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'canceled',
]);
export type TurnStatus = z.infer<typeof TurnStatusSchema>;
export const UsageSnapshotSchema = z.strictObject({
  inputTokens: CountSchema,
  cachedInputTokens: CountSchema,
  outputTokens: CountSchema,
  reasoningTokens: CountSchema.optional(),
  costUsd: z.number().nonnegative().finite().optional(),
  model: NameSchema.optional(),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;
export const DiffStatsSchema = z.strictObject({
  files: CountSchema,
  additions: CountSchema,
  deletions: CountSchema,
});
export type DiffStats = z.infer<typeof DiffStatsSchema>;
export const TurnSchema = z.strictObject({
  id: IdSchema,
  attemptId: IdSchema,
  number: SequenceSchema,
  prompt: TextSchema,
  status: TurnStatusSchema,
  usage: UsageSnapshotSchema.optional(),
  diffStats: DiffStatsSchema.optional(),
  commitSha: CommitShaSchema.optional(),
  patchArtifactId: IdSchema.optional(),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.optional(),
});
export type Turn = z.infer<typeof TurnSchema>;
export const ApprovalKindSchema = z.enum([
  'tool',
  'file_write',
  'shell',
  'network',
  'other',
]);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;
export const ApprovalStatusSchema = z.enum([
  'pending',
  'approved',
  'denied',
  'expired',
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;
export const ApprovalDecisionSchema = z.enum(['allow', 'deny', 'allow_always']);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
export const ApprovalRequestSchema = z.strictObject({
  id: IdSchema,
  workspaceId: IdSchema,
  runId: IdSchema,
  attemptId: IdSchema,
  turnId: IdSchema,
  requestId: IdSchema,
  kind: ApprovalKindSchema,
  title: NameSchema,
  payload: JsonValueSchema,
  status: ApprovalStatusSchema,
  decidedBy: IdSchema.optional(),
  decidedAt: TimestampSchema.optional(),
  expiresAt: TimestampSchema,
  createdAt: TimestampSchema,
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export const ArtifactKindSchema = z.enum(['patch', 'file', 'log']);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
export const ArtifactSchema = z.strictObject({
  id: IdSchema,
  workspaceId: IdSchema,
  runId: IdSchema,
  attemptId: IdSchema,
  turnId: IdSchema.optional(),
  kind: ArtifactKindSchema,
  blobRef: TextSchema,
  sizeBytes: CountSchema,
  sha256: Sha256Schema,
  mimeType: NameSchema,
  createdAt: TimestampSchema,
});
export type Artifact = z.infer<typeof ArtifactSchema>;
export const AuditEventSchema = z.strictObject({
  id: IdSchema,
  workspaceId: IdSchema,
  actorType: z.enum(['human', 'runner', 'system']),
  actorId: IdSchema,
  entityType: z.enum([
    'task',
    'run',
    'attempt',
    'runner',
    'repository',
    'agent_profile',
    'approval',
  ]),
  entityId: IdSchema,
  kind: NameSchema,
  data: JsonObjectSchema,
  createdAt: TimestampSchema,
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;
