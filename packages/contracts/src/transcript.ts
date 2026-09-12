import { z } from 'zod';
import { UsageSnapshotSchema } from './domain.js';
import {
  CountSchema,
  FrameJsonSchema,
  FrameTextSchema,
  IdSchema,
  MAX_FRAME_STRING_BYTES,
  MAX_TRANSCRIPT_CHUNK_BYTES,
  MAX_TRANSCRIPT_FRAMES,
  SequenceSchema,
  TimestampSchema,
  isBoundedJson,
} from './validation.js';

const truncation = {
  truncated: z.boolean().optional(),
  logArtifactId: IdSchema.optional(),
};
export const TextDeltaFrameSchema = z.strictObject({
  t: z.literal('text_delta'),
  text: FrameTextSchema,
  ...truncation,
});
export type TextDeltaFrame = z.infer<typeof TextDeltaFrameSchema>;
export const ThoughtDeltaFrameSchema = z.strictObject({
  t: z.literal('thought_delta'),
  text: FrameTextSchema,
  ...truncation,
});
export type ThoughtDeltaFrame = z.infer<typeof ThoughtDeltaFrameSchema>;
export const ToolCallFrameSchema = z.strictObject({
  t: z.literal('tool_call'),
  callId: IdSchema,
  tool: FrameTextSchema,
  input: FrameJsonSchema,
  ...truncation,
});
export type ToolCallFrame = z.infer<typeof ToolCallFrameSchema>;
export const ToolResultFrameSchema = z.strictObject({
  t: z.literal('tool_result'),
  callId: IdSchema,
  output: FrameTextSchema,
  ...truncation,
});
export type ToolResultFrame = z.infer<typeof ToolResultFrameSchema>;
export const FileChangedFrameSchema = z.strictObject({
  t: z.literal('file_changed'),
  path: FrameTextSchema,
  add: CountSchema,
  del: CountSchema,
  ...truncation,
});
export type FileChangedFrame = z.infer<typeof FileChangedFrameSchema>;
export const PlanUpdatedFrameSchema = z.strictObject({
  t: z.literal('plan_updated'),
  plan: FrameJsonSchema,
  ...truncation,
});
export type PlanUpdatedFrame = z.infer<typeof PlanUpdatedFrameSchema>;
export const UsageFrameSchema = z.strictObject({
  t: z.literal('usage'),
  usage: UsageSnapshotSchema,
  ...truncation,
});
export type UsageFrame = z.infer<typeof UsageFrameSchema>;
export const WarningFrameSchema = z.strictObject({
  t: z.literal('warning'),
  code: FrameTextSchema,
  message: FrameTextSchema,
  ...truncation,
});
export type WarningFrame = z.infer<typeof WarningFrameSchema>;
export const TranscriptFrameSchema = z.discriminatedUnion('t', [
  TextDeltaFrameSchema,
  ThoughtDeltaFrameSchema,
  ToolCallFrameSchema,
  ToolResultFrameSchema,
  FileChangedFrameSchema,
  PlanUpdatedFrameSchema,
  UsageFrameSchema,
  WarningFrameSchema,
]);
export type TranscriptFrame = z.infer<typeof TranscriptFrameSchema>;
export const TranscriptFramesSchema = z
  .array(TranscriptFrameSchema)
  .min(1)
  .max(MAX_TRANSCRIPT_FRAMES)
  .refine(
    (frames) =>
      isBoundedJson(frames, MAX_TRANSCRIPT_CHUNK_BYTES, MAX_FRAME_STRING_BYTES),
    'Transcript frames exceed the chunk or string limit',
  );
export type TranscriptFrames = z.infer<typeof TranscriptFramesSchema>;
export const TranscriptChunkSchema = z
  .strictObject({
    attemptId: IdSchema,
    chunkSeq: SequenceSchema,
    turnId: IdSchema,
    frames: TranscriptFramesSchema,
    frameCount: CountSchema,
    byteSize: CountSchema.max(MAX_TRANSCRIPT_CHUNK_BYTES),
    createdAt: TimestampSchema,
  })
  .refine(
    (chunk) => chunk.frameCount === chunk.frames.length,
    'frameCount must match frames',
  );
export type TranscriptChunk = z.infer<typeof TranscriptChunkSchema>;
