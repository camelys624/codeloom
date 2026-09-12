import { z } from 'zod';
import {
  ApprovalDecisionSchema,
  ApprovalKindSchema,
  DiffStatsSchema,
  EnforcementReportSchema,
  RunErrorSchema,
  UsageSnapshotSchema,
} from './domain.js';
import {
  CommitShaSchema,
  IdSchema,
  JsonValueSchema,
  NameSchema,
  SequenceSchema,
  TextSchema,
  TimestampSchema,
  isBoundedJson,
} from './validation.js';

function boundedPayload<T extends z.ZodType>(schema: T) {
  return schema.refine(
    (payload) => isBoundedJson(payload),
    'Event payload exceeds 64 KiB or is not JSON',
  );
}
const eventEnvelope = {
  occurredAt: TimestampSchema,
  turnId: IdSchema.optional(),
};
const turnEnvelope = { ...eventEnvelope, turnId: IdSchema };
export const AttemptPreparingEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('attempt.preparing'),
  payload: boundedPayload(z.strictObject({ detail: TextSchema })),
});
export type AttemptPreparingEvent = z.infer<typeof AttemptPreparingEventSchema>;
export const AttemptStartedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('attempt.started'),
  payload: boundedPayload(
    z.strictObject({
      enforcement: EnforcementReportSchema,
      engineVersion: NameSchema,
    }),
  ),
});
export type AttemptStartedEvent = z.infer<typeof AttemptStartedEventSchema>;
export const TurnStartedEventSchema = z.strictObject({
  ...turnEnvelope,
  type: z.literal('turn.started'),
  payload: boundedPayload(
    z.strictObject({ number: SequenceSchema, prompt: TextSchema }),
  ),
});
export type TurnStartedEvent = z.infer<typeof TurnStartedEventSchema>;
export const TurnCompletedEventSchema = z.strictObject({
  ...turnEnvelope,
  type: z.literal('turn.completed'),
  payload: boundedPayload(
    z.strictObject({
      usage: UsageSnapshotSchema.optional(),
      diffStats: DiffStatsSchema,
      commitSha: CommitShaSchema,
      patchArtifactId: IdSchema,
    }),
  ),
});
export type TurnCompletedEvent = z.infer<typeof TurnCompletedEventSchema>;
export const TurnFailedEventSchema = z.strictObject({
  ...turnEnvelope,
  type: z.literal('turn.failed'),
  payload: boundedPayload(
    z.strictObject({ error: RunErrorSchema, attemptContinues: z.boolean() }),
  ),
});
export type TurnFailedEvent = z.infer<typeof TurnFailedEventSchema>;
export const TurnCanceledEventSchema = z.strictObject({
  ...turnEnvelope,
  type: z.literal('turn.canceled'),
  payload: boundedPayload(
    z.strictObject({ usage: UsageSnapshotSchema.optional() }),
  ),
});
export type TurnCanceledEvent = z.infer<typeof TurnCanceledEventSchema>;
export const ApprovalRequestedEventSchema = z.strictObject({
  ...turnEnvelope,
  type: z.literal('approval.requested'),
  payload: boundedPayload(
    z.strictObject({
      requestId: IdSchema,
      kind: ApprovalKindSchema,
      title: NameSchema,
      payload: JsonValueSchema,
      expiresAt: TimestampSchema,
    }),
  ),
});
export type ApprovalRequestedEvent = z.infer<
  typeof ApprovalRequestedEventSchema
>;
export const AttemptCompletedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('attempt.completed'),
  payload: boundedPayload(
    z.strictObject({
      headCommitSha: CommitShaSchema,
      reason: z.enum(['user', 'idle_timeout']),
    }),
  ),
});
export type AttemptCompletedEvent = z.infer<typeof AttemptCompletedEventSchema>;
export const AttemptFailedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('attempt.failed'),
  payload: boundedPayload(z.strictObject({ error: RunErrorSchema })),
});
export type AttemptFailedEvent = z.infer<typeof AttemptFailedEventSchema>;
export const AttemptCanceledEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('attempt.canceled'),
  payload: boundedPayload(
    z.strictObject({ headCommitSha: CommitShaSchema.optional() }),
  ),
});
export type AttemptCanceledEvent = z.infer<typeof AttemptCanceledEventSchema>;
export const AttemptQueuedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('attempt.queued'),
  payload: z.strictObject({}),
});
export type AttemptQueuedEvent = z.infer<typeof AttemptQueuedEventSchema>;
export const AttemptClaimedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('attempt.claimed'),
  payload: z.strictObject({}),
});
export type AttemptClaimedEvent = z.infer<typeof AttemptClaimedEventSchema>;
export const ApprovalResolvedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('approval.resolved'),
  payload: boundedPayload(
    z.strictObject({
      requestId: IdSchema,
      decision: ApprovalDecisionSchema,
      decidedBy: IdSchema,
    }),
  ),
});
export type ApprovalResolvedEvent = z.infer<typeof ApprovalResolvedEventSchema>;
export const AttemptCancelRequestedEventSchema = z
  .strictObject({
    ...eventEnvelope,
    type: z.literal('attempt.cancel_requested'),
    payload: z.strictObject({ scope: z.enum(['turn', 'attempt']) }),
  })
  .refine(
    (event) => event.payload.scope !== 'turn' || event.turnId !== undefined,
    'Turn cancellation requires an envelope turnId',
  );
export type AttemptCancelRequestedEvent = z.infer<
  typeof AttemptCancelRequestedEventSchema
>;
export const AttemptLostEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('attempt.lost'),
  payload: z.strictObject({}),
});
export type AttemptLostEvent = z.infer<typeof AttemptLostEventSchema>;
export const AttemptStaleDetectedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('attempt.stale_detected'),
  payload: z.strictObject({ fromRunnerId: IdSchema }),
});
export type AttemptStaleDetectedEvent = z.infer<
  typeof AttemptStaleDetectedEventSchema
>;

export const RunnerEventSchema = z.discriminatedUnion('type', [
  AttemptPreparingEventSchema,
  AttemptStartedEventSchema,
  TurnStartedEventSchema,
  TurnCompletedEventSchema,
  TurnFailedEventSchema,
  TurnCanceledEventSchema,
  ApprovalRequestedEventSchema,
  AttemptCompletedEventSchema,
  AttemptFailedEventSchema,
  AttemptCanceledEventSchema,
]);
export type RunnerEvent = z.infer<typeof RunnerEventSchema>;
export const ServerEventSchema = z.discriminatedUnion('type', [
  AttemptQueuedEventSchema,
  AttemptClaimedEventSchema,
  ApprovalResolvedEventSchema,
  AttemptCancelRequestedEventSchema,
  AttemptLostEventSchema,
  AttemptStaleDetectedEventSchema,
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;
export const StateEventSchema = z.union([RunnerEventSchema, ServerEventSchema]);
export type StateEvent = z.infer<typeof StateEventSchema>;
const persisted = {
  id: IdSchema,
  workspaceId: IdSchema,
  runId: IdSchema,
  attemptId: IdSchema,
  sequence: SequenceSchema,
  clientSeq: SequenceSchema.nullable().optional(),
  createdAt: TimestampSchema,
};
export const RunEventSchema = z.discriminatedUnion('type', [
  AttemptPreparingEventSchema.extend(persisted),
  AttemptStartedEventSchema.extend(persisted),
  TurnStartedEventSchema.extend(persisted),
  TurnCompletedEventSchema.extend(persisted),
  TurnFailedEventSchema.extend(persisted),
  TurnCanceledEventSchema.extend(persisted),
  ApprovalRequestedEventSchema.extend(persisted),
  AttemptCompletedEventSchema.extend(persisted),
  AttemptFailedEventSchema.extend(persisted),
  AttemptCanceledEventSchema.extend(persisted),
  AttemptQueuedEventSchema.extend(persisted),
  AttemptClaimedEventSchema.extend(persisted),
  ApprovalResolvedEventSchema.extend(persisted),
  AttemptCancelRequestedEventSchema.safeExtend(persisted),
  AttemptLostEventSchema.extend(persisted),
  AttemptStaleDetectedEventSchema.extend(persisted),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
