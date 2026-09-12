import { z } from 'zod';
import {
  AgentProfileSchema,
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  ArtifactKindSchema,
  AttemptSchema,
  FrozenRunSpecSchema,
  RepositoryAccessSchema,
  RunConfigSchema,
  RunSchema,
  RunnerKindSchema,
  RunnerSchema,
  TaskPrioritySchema,
  TaskSchema,
  TaskStatusSchema,
  TurnSchema,
  UserSchema,
  WorkspaceMemberSchema,
  WorkspaceSchema,
} from './domain.js';
import { RunEventSchema } from './events.js';
import { TranscriptChunkSchema } from './transcript.js';
import {
  CommitShaSchema,
  CountSchema,
  CursorSchema,
  IdSchema,
  NameSchema,
  SequenceSchema,
  Sha256Schema,
  TextSchema,
  TimestampSchema,
} from './validation.js';

export const PairRunnerInputSchema = z.strictObject({
  pairingCode: NameSchema,
  name: NameSchema,
  daemonVersion: NameSchema,
  os: NameSchema,
  arch: NameSchema,
});
export type PairRunnerInput = z.infer<typeof PairRunnerInputSchema>;
export const PairRunnerOutputSchema = z.strictObject({
  runnerId: IdSchema,
  workspaceId: IdSchema,
  runnerToken: NameSchema,
});
export type PairRunnerOutput = z.infer<typeof PairRunnerOutputSchema>;
export const RotateRunnerTokenInputSchema = z.strictObject({});
export type RotateRunnerTokenInput = z.infer<
  typeof RotateRunnerTokenInputSchema
>;
export const RotateRunnerTokenOutputSchema = z.strictObject({
  runnerToken: NameSchema,
});
export type RotateRunnerTokenOutput = z.infer<
  typeof RotateRunnerTokenOutputSchema
>;
export const RegisterRepositoryInputSchema = z.strictObject({
  remoteUrl: TextSchema.nullable(),
  name: NameSchema,
  defaultRef: NameSchema,
  access: RepositoryAccessSchema,
});
export type RegisterRepositoryInput = z.infer<
  typeof RegisterRepositoryInputSchema
>;
export const RegisterRepositoryOutputSchema = z.strictObject({
  repositoryId: IdSchema,
  created: z.boolean(),
});
export type RegisterRepositoryOutput = z.infer<
  typeof RegisterRepositoryOutputSchema
>;
export const ClaimAttemptsInputSchema = z.strictObject({
  capacity: CountSchema,
});
export type ClaimAttemptsInput = z.infer<typeof ClaimAttemptsInputSchema>;
export const ClaimedAttemptSchema = z.strictObject({
  attempt: AttemptSchema,
  frozenSpec: FrozenRunSpecSchema,
});
export type ClaimedAttempt = z.infer<typeof ClaimedAttemptSchema>;
export const ClaimAttemptsOutputSchema = z.strictObject({
  attempts: z.array(ClaimedAttemptSchema).max(1024),
});
export type ClaimAttemptsOutput = z.infer<typeof ClaimAttemptsOutputSchema>;
/** Multipart form fields; the streaming file body is validated by the upload handler. */
export const UploadArtifactInputSchema = z.strictObject({
  kind: ArtifactKindSchema,
  turnId: IdSchema.optional(),
  sha256: Sha256Schema,
});
export type UploadArtifactInput = z.infer<typeof UploadArtifactInputSchema>;
export const UploadArtifactOutputSchema = z.strictObject({
  artifactId: IdSchema,
});
export type UploadArtifactOutput = z.infer<typeof UploadArtifactOutputSchema>;
export const ArtifactDownloadOutputSchema = z.strictObject({
  url: z.url(),
  expiresAt: TimestampSchema,
});
export type ArtifactDownloadOutput = z.infer<
  typeof ArtifactDownloadOutputSchema
>;
export const RetryRunInputSchema = z.strictObject({
  resumeFrom: z.enum(['last_commit', 'base']),
  initialPrompt: TextSchema.optional(),
});
export type RetryRunInput = z.infer<typeof RetryRunInputSchema>;
export const AttemptSnapshotSchema = AttemptSchema.extend({
  lastSequence: CursorSchema,
  lastChunkSeq: CursorSchema,
});
export type AttemptSnapshot = z.infer<typeof AttemptSnapshotSchema>;
export const RunSnapshotSchema = z.strictObject({
  run: RunSchema,
  attempts: z.array(AttemptSnapshotSchema).max(10000),
  turns: z.array(TurnSchema).max(100000),
  approvals: z
    .array(ApprovalRequestSchema.extend({ status: z.literal('pending') }))
    .max(10000),
});
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;
export const EventsOutputSchema = z.strictObject({
  events: z.array(RunEventSchema).max(10000),
});
export type EventsOutput = z.infer<typeof EventsOutputSchema>;
export const TranscriptOutputSchema = z.strictObject({
  chunks: z.array(TranscriptChunkSchema).max(200),
});
export type TranscriptOutput = z.infer<typeof TranscriptOutputSchema>;
const queryCursor = z.union([
  CursorSchema,
  z
    .string()
    .regex(/^(0|[1-9]\d*)$/)
    .max(16)
    .transform(Number)
    .pipe(CursorSchema),
]);
export const EventsQuerySchema = z.strictObject({
  after: queryCursor.default(0),
});
export type EventsQuery = z.infer<typeof EventsQuerySchema>;
export const TranscriptQuerySchema = z
  .strictObject({
    afterChunk: queryCursor.optional(),
    beforeChunk: queryCursor.pipe(SequenceSchema).optional(),
    limit: queryCursor.pipe(SequenceSchema.max(200)).default(200),
  })
  .refine(
    (query) =>
      (query.afterChunk === undefined) !== (query.beforeChunk === undefined),
    'Specify exactly one transcript cursor',
  );
export type TranscriptQuery = z.infer<typeof TranscriptQuerySchema>;
export const MeOutputSchema = z.strictObject({
  user: UserSchema,
  workspace: WorkspaceSchema,
  membership: WorkspaceMemberSchema,
});
export type MeOutput = z.infer<typeof MeOutputSchema>;

// Browser mutation inputs never accept actor, workspace or other server-owned fields.
export const CreateTaskInputSchema = z.strictObject({
  title: NameSchema,
  description: TextSchema,
  status: z.enum(['backlog', 'todo']).optional(),
  priority: TaskPrioritySchema.optional(),
  repositoryId: IdSchema.nullable(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;
export const UpdateTaskInputSchema = z.strictObject({
  revision: CountSchema,
  title: NameSchema.optional(),
  description: TextSchema.optional(),
  status: TaskStatusSchema.optional(),
  priority: TaskPrioritySchema.nullable().optional(),
  repositoryId: IdSchema.nullable().optional(),
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskInputSchema>;
export const TaskOutputSchema = TaskSchema;
export type TaskOutput = z.infer<typeof TaskOutputSchema>;
export const CreateRunInputSchema = z
  .strictObject({
    runnerId: IdSchema,
    agentProfileId: IdSchema,
    baseRef: NameSchema,
    baseCommitSha: CommitShaSchema,
    runConfig: RunConfigSchema,
    initialPrompt: TextSchema,
  })
  .refine(
    (input) => input.agentProfileId === input.runConfig.agentProfileId,
    'RunConfig must use the selected agent profile',
  );
export type CreateRunInput = z.infer<typeof CreateRunInputSchema>;
export const PromptInputSchema = z.strictObject({ text: TextSchema });
export type PromptInput = z.infer<typeof PromptInputSchema>;
export const ResolveApprovalInputSchema = z.strictObject({
  decision: ApprovalDecisionSchema,
});
export type ResolveApprovalInput = z.infer<typeof ResolveApprovalInputSchema>;
export const CreateRunnerInputSchema = z.strictObject({
  name: NameSchema,
  kind: RunnerKindSchema,
  maxConcurrency: SequenceSchema.optional(),
});
export type CreateRunnerInput = z.infer<typeof CreateRunnerInputSchema>;
export const CreateRunnerOutputSchema = z.strictObject({
  runner: RunnerSchema,
  pairingCode: NameSchema,
  expiresAt: TimestampSchema,
});
export type CreateRunnerOutput = z.infer<typeof CreateRunnerOutputSchema>;
export const CreateAgentProfileInputSchema = AgentProfileSchema.pick({
  runnerId: true,
  engine: true,
  displayName: true,
  launch: true,
  defaultModel: true,
});
export type CreateAgentProfileInput = z.infer<
  typeof CreateAgentProfileInputSchema
>;
export const UpdateAgentProfileInputSchema = CreateAgentProfileInputSchema.omit(
  { runnerId: true },
).partial();
export type UpdateAgentProfileInput = z.infer<
  typeof UpdateAgentProfileInputSchema
>;
