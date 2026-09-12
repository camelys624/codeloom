import { z } from 'zod';
import {
  AgentCapabilitiesSchema,
  AgentEngineSchema,
  ApprovalDecisionSchema,
  RepositoryAccessSchema,
  RunSchema,
  RunnerStatusSchema,
} from './domain.js';
import { RunEventSchema, RunnerEventSchema } from './events.js';
import { TranscriptFramesSchema } from './transcript.js';
import {
  CountSchema,
  IdSchema,
  NameSchema,
  SequenceSchema,
  TextSchema,
  TimestampSchema,
} from './validation.js';

export const PROTOCOL_VERSION = 1;
export const RunnerHelloSchema = z.strictObject({
  type: z.literal('runner.hello'),
  protocolVersion: SequenceSchema,
  daemonVersion: NameSchema,
  os: NameSchema,
  arch: NameSchema,
  maxConcurrency: SequenceSchema,
  agents: z
    .array(
      z.strictObject({
        agentProfileId: IdSchema,
        engine: AgentEngineSchema,
        capabilities: AgentCapabilitiesSchema,
      }),
    )
    .max(1024),
  repositories: z
    .array(
      z.strictObject({
        repositoryId: IdSchema,
        access: RepositoryAccessSchema,
      }),
    )
    .max(10000),
  activeAttemptIds: z.array(IdSchema).max(1024),
});
export type RunnerHello = z.infer<typeof RunnerHelloSchema>;
export const ServerHelloSchema = z.strictObject({
  type: z.literal('server.hello'),
  protocolVersion: SequenceSchema,
  runnerId: IdSchema,
  serverTime: TimestampSchema,
  attempts: z
    .array(
      z.strictObject({
        attemptId: IdSchema,
        disposition: z.enum(['continue', 'stale']),
      }),
    )
    .max(1024),
});
export type ServerHello = z.infer<typeof ServerHelloSchema>;
export const RunnerStatusMessageSchema = z.strictObject({
  type: z.literal('runner.status'),
  load: z.strictObject({ active: CountSchema, capacity: CountSchema }),
});
export type RunnerStatusMessage = z.infer<typeof RunnerStatusMessageSchema>;
export const AttemptHeartbeatSchema = z.strictObject({
  type: z.literal('attempt.heartbeat'),
  attemptId: IdSchema,
});
export type AttemptHeartbeat = z.infer<typeof AttemptHeartbeatSchema>;
export const AttemptEventMessageSchema = z.strictObject({
  type: z.literal('attempt.event'),
  attemptId: IdSchema,
  clientSeq: SequenceSchema,
  event: RunnerEventSchema,
});
export type AttemptEventMessage = z.infer<typeof AttemptEventMessageSchema>;
export const AttemptTranscriptMessageSchema = z.strictObject({
  type: z.literal('attempt.transcript'),
  attemptId: IdSchema,
  chunkSeq: SequenceSchema,
  turnId: IdSchema,
  frames: TranscriptFramesSchema,
});
export type AttemptTranscriptMessage = z.infer<
  typeof AttemptTranscriptMessageSchema
>;
export const EventAckSchema = z.strictObject({
  type: z.literal('ack'),
  kind: z.literal('event'),
  attemptId: IdSchema,
  clientSeq: SequenceSchema,
});
export type EventAck = z.infer<typeof EventAckSchema>;
export const TranscriptAckSchema = z.strictObject({
  type: z.literal('ack'),
  kind: z.literal('transcript'),
  attemptId: IdSchema,
  chunkSeq: SequenceSchema,
});
export type TranscriptAck = z.infer<typeof TranscriptAckSchema>;
export const AckSchema = z.discriminatedUnion('kind', [
  EventAckSchema,
  TranscriptAckSchema,
]);
export type Ack = z.infer<typeof AckSchema>;
export const EventNackSchema = z.strictObject({
  type: z.literal('nack'),
  kind: z.literal('event'),
  attemptId: IdSchema,
  expectedClientSeq: SequenceSchema,
});
export type EventNack = z.infer<typeof EventNackSchema>;
export const TranscriptNackSchema = z.strictObject({
  type: z.literal('nack'),
  kind: z.literal('transcript'),
  attemptId: IdSchema,
  expectedChunkSeq: SequenceSchema,
});
export type TranscriptNack = z.infer<typeof TranscriptNackSchema>;
export const NackSchema = z.discriminatedUnion('kind', [
  EventNackSchema,
  TranscriptNackSchema,
]);
export type Nack = z.infer<typeof NackSchema>;
export const WorkAvailableSchema = z.strictObject({
  type: z.literal('work.available'),
});
export type WorkAvailable = z.infer<typeof WorkAvailableSchema>;
export const AttemptPromptSchema = z.strictObject({
  type: z.literal('attempt.prompt'),
  attemptId: IdSchema,
  turnId: IdSchema,
  text: TextSchema,
});
export type AttemptPrompt = z.infer<typeof AttemptPromptSchema>;
export const TurnCancelSchema = z.strictObject({
  type: z.literal('turn.cancel'),
  attemptId: IdSchema,
  turnId: IdSchema,
});
export type TurnCancel = z.infer<typeof TurnCancelSchema>;
export const AttemptCancelSchema = z.strictObject({
  type: z.literal('attempt.cancel'),
  attemptId: IdSchema,
});
export type AttemptCancel = z.infer<typeof AttemptCancelSchema>;
export const AttemptCloseSchema = z.strictObject({
  type: z.literal('attempt.close'),
  attemptId: IdSchema,
  reason: z.literal('user'),
});
export type AttemptClose = z.infer<typeof AttemptCloseSchema>;
export const ApprovalResolvedSchema = z.strictObject({
  type: z.literal('approval.resolved'),
  attemptId: IdSchema,
  requestId: IdSchema,
  decision: ApprovalDecisionSchema,
});
export type ApprovalResolved = z.infer<typeof ApprovalResolvedSchema>;
export const AttemptStaleSchema = z.strictObject({
  type: z.literal('attempt.stale'),
  attemptId: IdSchema,
  reason: TextSchema,
});
export type AttemptStale = z.infer<typeof AttemptStaleSchema>;
export const RunnerMessageSchema = z.discriminatedUnion('type', [
  RunnerHelloSchema,
  RunnerStatusMessageSchema,
  AttemptHeartbeatSchema,
  AttemptEventMessageSchema,
  AttemptTranscriptMessageSchema,
]);
export type RunnerMessage = z.infer<typeof RunnerMessageSchema>;
export const ServerMessageSchema = z.union([
  ServerHelloSchema,
  AckSchema,
  NackSchema,
  WorkAvailableSchema,
  AttemptPromptSchema,
  TurnCancelSchema,
  AttemptCancelSchema,
  AttemptCloseSchema,
  ApprovalResolvedSchema,
  AttemptStaleSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export const OutboxMessageSchema = z.discriminatedUnion('type', [
  AttemptEventMessageSchema,
  AttemptTranscriptMessageSchema,
]);
export type OutboxMessage = z.infer<typeof OutboxMessageSchema>;

export const SubscribeSchema = z.strictObject({
  type: z.literal('subscribe'),
  runId: IdSchema,
});
export type Subscribe = z.infer<typeof SubscribeSchema>;
export const BrowserMessageSchema = SubscribeSchema;
export type BrowserMessage = z.infer<typeof BrowserMessageSchema>;
export const BrowserEventSchema = z
  .strictObject({
    type: z.literal('event'),
    attemptId: IdSchema,
    sequence: SequenceSchema,
    event: RunEventSchema,
  })
  .refine(
    (message) =>
      message.attemptId === message.event.attemptId &&
      message.sequence === message.event.sequence,
    'Event envelope does not match persisted event',
  );
export type BrowserEvent = z.infer<typeof BrowserEventSchema>;
export const BrowserTranscriptSchema = z.strictObject({
  type: z.literal('transcript'),
  attemptId: IdSchema,
  chunkSeq: SequenceSchema,
  turnId: IdSchema,
  frames: TranscriptFramesSchema,
});
export type BrowserTranscript = z.infer<typeof BrowserTranscriptSchema>;
export const BrowserRunSchema = z.strictObject({
  type: z.literal('run'),
  run: RunSchema,
});
export type BrowserRun = z.infer<typeof BrowserRunSchema>;
export const BrowserServerMessageSchema = z.discriminatedUnion('type', [
  BrowserEventSchema,
  BrowserTranscriptSchema,
  BrowserRunSchema,
]);
export type BrowserServerMessage = z.infer<typeof BrowserServerMessageSchema>;

export const WorkNotificationSchema = z.strictObject({
  kind: z.literal('work'),
  runnerId: IdSchema,
});
export type WorkNotification = z.infer<typeof WorkNotificationSchema>;
export const RunNotificationSchema = z.strictObject({
  runId: IdSchema,
  attemptId: IdSchema,
  sequence: SequenceSchema.optional(),
  chunkSeq: SequenceSchema.optional(),
});
export type RunNotification = z.infer<typeof RunNotificationSchema>;
export const RunnerNotificationSchema = z.strictObject({
  runnerId: IdSchema,
  status: RunnerStatusSchema,
});
export type RunnerNotification = z.infer<typeof RunnerNotificationSchema>;
