import { z } from 'zod';
import {
  ApprovalDecisionSchema,
  ApprovalKindSchema,
  RunErrorSchema,
  UsageSnapshotSchema,
} from './domain.js';
import type { AgentCapabilities, AgentProfile, RunConfig } from './domain.js';
import type { TranscriptFrame } from './transcript.js';
import { IdSchema, JsonValueSchema, NameSchema } from './validation.js';

export interface Clock {
  now(): Date;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export const systemClock: Clock = {
  now: () => new Date(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export interface AgentAdapter {
  readonly engine: AgentProfile['engine'];
  probe(input: ProbeInput): Promise<AgentCapabilities>;
  startSession(input: StartSessionInput): Promise<AgentSessionHandle>;
}

export type ProbeInput = {
  launch: AgentProfile['launch'];
  env: Record<string, string>;
};

export type StartSessionInput = {
  attemptId: string;
  cwd: string;
  launch: AgentProfile['launch'];
  env: Record<string, string>;
  runConfig: RunConfig;
  onFrame: (frame: TranscriptFrame) => void;
  onPermissionRequest: (req: PermissionRequest) => Promise<PermissionDecision>;
  clock: Clock;
};

export interface AgentSessionHandle {
  prompt(input: {
    turnId: string;
    text: string;
    signal: AbortSignal;
  }): Promise<TurnResult>;
  cancelTurn(): Promise<void>;
  close(): Promise<void>;
}

export const TurnResultSchema = z.strictObject({
  stopReason: z.enum(['end_turn', 'canceled', 'max_turn_time', 'error']),
  usage: UsageSnapshotSchema.optional(),
  error: RunErrorSchema.optional(),
});
export type TurnResult = z.infer<typeof TurnResultSchema>;
export const PermissionRequestSchema = z.strictObject({
  requestId: IdSchema,
  kind: ApprovalKindSchema,
  title: NameSchema,
  payload: JsonValueSchema,
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;
export const PermissionDecisionSchema = z.strictObject({
  decision: ApprovalDecisionSchema,
});
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;
