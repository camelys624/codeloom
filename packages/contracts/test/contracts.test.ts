import { ServerHelloSchema } from '../src/index.js';
import { describe, expect, it } from 'vitest';
import {
  AttemptCancelRequestedEventSchema,
  AttemptStatusSchema,
  EventsQuerySchema,
  FrameTextSchema,
  JsonValueSchema,
  MAX_FRAME_STRING_BYTES,
  MAX_JSON_DEPTH,
  RunnerEventSchema,
  RunDiffOutputSchema,
  SequenceSchema,
  TranscriptFramesSchema,
  TranscriptQuerySchema,
  TurnStatusSchema,
  canRetryRun,
  projectRunStatus,
  transitionAttempt,
  transitionTask,
} from '../src/index.js';

describe('irreversible execution state', () => {
  it('never resurrects terminal Attempts or Turns, including self-transitions', () => {
    for (const terminal of [
      'completed',
      'failed',
      'canceled',
      'lost',
    ] as const) {
      for (const next of AttemptStatusSchema.options) {
        expect(() => transitionAttempt(terminal, next)).toThrow();
      }
    }
    for (const terminal of ['completed', 'failed', 'canceled'] as const) {
      for (const next of TurnStatusSchema.options) {
        expect(() => transitionTurn(terminal, next)).toThrow();
      }
    }
  });

  it('allows a fresh Attempt after failure without reopening the old Attempt', () => {
    expect(projectRunStatus(transitionAttempt('running', 'failed'))).toBe(
      'failed',
    );
    expect(canRetryRun('failed')).toBe(true);
    expect(projectRunStatus('queued')).toBe('pending');
    expect(canRetryRun('completed')).toBe(false);
    expect(() => transitionAttempt('failed', 'queued')).toThrow();
  });

  it('fails an idle session after a Runner restart without resurrecting it', () => {
    const failed = transitionAttempt('idle', 'failed');
    expect(projectRunStatus(failed)).toBe('failed');
    expect(() => transitionAttempt(failed, 'idle')).toThrow();
  });

  it('keeps failed work in progress and restricts reopening done Tasks to a new Run', () => {
    expect(transitionTask('in_progress', 'in_progress', 'run_failed')).toBe(
      'in_progress',
    );
    expect(() =>
      transitionTask('in_progress', 'needs_review', 'run_failed'),
    ).toThrow();
    expect(transitionTask('in_progress', 'needs_review', 'run_completed')).toBe(
      'needs_review',
    );
    expect(transitionTask('needs_review', 'done', 'user')).toBe('done');
    expect(() => transitionTask('done', 'in_progress', 'user')).toThrow();
    expect(transitionTask('done', 'in_progress', 'run_created')).toBe(
      'in_progress',
    );
    expect(transitionTask('canceled', 'todo', 'user')).toBe('todo');
  });
});

describe('untrusted transport boundaries', () => {
  it('counts frame limits in UTF-8 bytes and applies an aggregate chunk limit', () => {
    expect(
      FrameTextSchema.safeParse('é'.repeat(MAX_FRAME_STRING_BYTES / 2)).success,
    ).toBe(true);
    expect(
      FrameTextSchema.safeParse('é'.repeat(MAX_FRAME_STRING_BYTES / 2 + 1))
        .success,
    ).toBe(false);
    const text = 'a'.repeat(MAX_FRAME_STRING_BYTES);
    expect(
      TranscriptFramesSchema.safeParse([{ t: 'text_delta', text }]).success,
    ).toBe(true);
    expect(
      TranscriptFramesSchema.safeParse([
        { t: 'text_delta', text },
        { t: 'text_delta', text },
      ]).success,
    ).toBe(false);
  });

  it('rejects cycles, executable properties and excessive depth without executing input', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(JsonValueSchema.safeParse(cyclic).success).toBe(false);
    let accessed = false;
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        accessed = true;
        return 'secret';
      },
    });
    expect(JsonValueSchema.safeParse(accessor).success).toBe(false);
    expect(accessed).toBe(false);
    let nested: unknown = null;
    for (let depth = 0; depth <= MAX_JSON_DEPTH; depth++) nested = { nested };
    expect(JsonValueSchema.safeParse(nested).success).toBe(false);
    expect(JsonValueSchema.safeParse({ token: undefined }).success).toBe(false);
  });

  it('rejects unsafe and ambiguous cursors rather than rounding or silently choosing a direction', () => {
    expect(SequenceSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(
      false,
    );
    expect(
      EventsQuerySchema.parse({ after: String(Number.MAX_SAFE_INTEGER) }).after,
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(
      EventsQuerySchema.safeParse({ after: '9007199254740993' }).success,
    ).toBe(false);
    expect(EventsQuerySchema.safeParse({ after: '1e3' }).success).toBe(false);
    expect(
      TranscriptQuerySchema.safeParse({ afterChunk: 0, beforeChunk: 5 })
        .success,
    ).toBe(false);
    expect(TranscriptQuerySchema.safeParse({ beforeChunk: 0 }).success).toBe(
      false,
    );
    expect(
      TranscriptQuerySchema.parse({ beforeChunk: '5', limit: '2' }),
    ).toEqual({ beforeChunk: 5, limit: 2 });
  });

  it('requires turn identity on the event envelope and rejects injected payload fields', () => {
    const event = {
      type: 'turn.started',
      turnId: 'trn_one',
      occurredAt: '2026-09-06T00:00:00Z',
      payload: { number: 1, prompt: 'work' },
    };
    expect(RunnerEventSchema.safeParse(event).success).toBe(true);
    expect(
      RunnerEventSchema.safeParse({
        ...event,
        turnId: undefined,
        payload: { ...event.payload, turnId: 'trn_other' },
      }).success,
    ).toBe(false);
    expect(
      RunnerEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, requester: 'usr_attacker' },
      }).success,
    ).toBe(false);
    expect(
      AttemptCancelRequestedEventSchema.safeParse({
        type: 'attempt.cancel_requested',
        occurredAt: event.occurredAt,
        payload: { scope: 'turn' },
      }).success,
    ).toBe(false);
  });
});

describe('runner reconnect controls', () => {
  it('accepts a server-issued cancel control in the hello reconciliation', () => {
    expect(
      ServerHelloSchema.parse({
        type: 'server.hello',
        protocolVersion: 1,
        runnerId: 'rnr_test',
        serverTime: '2026-09-13T00:00:00.000Z',
        attempts: [
          {
            attemptId: 'att_test',
            disposition: 'continue',
            controls: [{ type: 'attempt.cancel', attemptId: 'att_test' }],
          },
        ],
      }).attempts[0]?.controls[0]?.type,
    ).toBe('attempt.cancel');
  });
});

describe('run diff response', () => {
  it('accepts ordered turn metadata and rejects oversized patch text', () => {
    expect(
      RunDiffOutputSchema.parse({
        patch: 'diff --git a/src/a.ts b/src/a.ts\n',
        sizeBytes: 34,
        truncated: false,
        turns: [{ turnId: 'trn_one', number: 1, patchArtifactId: 'art_one' }],
      }).turns[0]?.number,
    ).toBe(1);
    expect(
      RunDiffOutputSchema.safeParse({
        patch: 'x'.repeat(65 * 1024),
        sizeBytes: 65 * 1024,
        truncated: true,
        turns: [],
      }).success,
    ).toBe(false);
  });
});
