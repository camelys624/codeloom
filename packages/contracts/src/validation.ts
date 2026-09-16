import { z } from 'zod';

export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;
export const MAX_TRANSCRIPT_CHUNK_BYTES = 64 * 1024;
export const MAX_FRAME_STRING_BYTES = 32 * 1024;
export const MAX_TRANSCRIPT_FRAMES = 1024;
export const MAX_JSON_DEPTH = 32;
export const MAX_JSON_NODES = 16384;
export const MAX_PATCH_BYTES = 20 * 1024 * 1024;
export const MAX_LOG_BYTES = 50 * 1024 * 1024;
export const MAX_RUN_DIFF_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

/** Validate before serialization: cycles, non-JSON values and excessive depth must not reach stringify. */
export function isBoundedJson(
  value: unknown,
  maxBytes = MAX_EVENT_PAYLOAD_BYTES,
  maxStringBytes = maxBytes,
): value is JsonValue {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  let contentBytes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (++nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH)
      return false;
    const item = current.value;
    if (item === null || typeof item === 'boolean') continue;
    if (typeof item === 'string') {
      if (item.length > maxStringBytes) return false;
      const bytes = utf8ByteLength(item);
      contentBytes += bytes;
      if (bytes > maxStringBytes || contentBytes > maxBytes) return false;
      continue;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) return false;
      continue;
    }
    if (typeof item !== 'object' || seen.has(item)) return false;
    seen.add(item);
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      return false;
    const keys = Reflect.ownKeys(item);
    if (keys.length + nodes + stack.length > MAX_JSON_NODES) return false;
    for (const key of keys) {
      if (Array.isArray(item) && key === 'length') continue;
      if (typeof key !== 'string' || key.length > maxStringBytes) return false;
      const keyBytes = utf8ByteLength(key);
      if (!Array.isArray(item)) contentBytes += keyBytes;
      if (keyBytes > maxStringBytes || contentBytes > maxBytes) return false;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) return false;
      if (Array.isArray(item) && !/^(0|[1-9]\d*)$/.test(key)) return false;
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
    if (Array.isArray(item) && keys.length !== item.length + 1) return false;
  }
  try {
    return utf8ByteLength(JSON.stringify(value)) <= maxBytes;
  } catch {
    return false;
  }
}

export const JsonValueSchema = z.custom<JsonValue>(
  (value) => isBoundedJson(value),
  'Expected bounded JSON data',
);
export const JsonObjectSchema = z.custom<JsonObject>(
  (value) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    isBoundedJson(value),
  'Expected bounded JSON object',
);
export const FrameJsonSchema = z.custom<JsonValue>(
  (value) =>
    isBoundedJson(value, MAX_TRANSCRIPT_CHUNK_BYTES, MAX_FRAME_STRING_BYTES),
  'Expected bounded frame JSON',
);
export type FrameJson = z.infer<typeof FrameJsonSchema>;
export const IdSchema = z.string().min(1).max(256);
export type Id = z.infer<typeof IdSchema>;
export const TimestampSchema = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof TimestampSchema>;
export const SequenceSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);
export type Sequence = z.infer<typeof SequenceSchema>;
export const CursorSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
export type Cursor = z.infer<typeof CursorSchema>;
export const CountSchema = CursorSchema;
export type Count = z.infer<typeof CountSchema>;
export const CommitShaSchema = z
  .string()
  .regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/);
export type CommitSha = z.infer<typeof CommitShaSchema>;
export const Sha256Schema = z.string().regex(/^[a-fA-F0-9]{64}$/);
export type Sha256 = z.infer<typeof Sha256Schema>;
export const TextSchema = z
  .string()
  .max(MAX_EVENT_PAYLOAD_BYTES)
  .refine(
    (value) => utf8ByteLength(value) <= MAX_EVENT_PAYLOAD_BYTES,
    'Text exceeds 64 KiB',
  );
export type Text = z.infer<typeof TextSchema>;
export const FrameTextSchema = z
  .string()
  .max(MAX_FRAME_STRING_BYTES)
  .refine(
    (value) => utf8ByteLength(value) <= MAX_FRAME_STRING_BYTES,
    'Frame string exceeds 32 KiB',
  );
export type FrameText = z.infer<typeof FrameTextSchema>;
export const NameSchema = z.string().min(1).max(1024);
export type Name = z.infer<typeof NameSchema>;
