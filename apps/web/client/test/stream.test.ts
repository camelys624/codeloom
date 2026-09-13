import { describe, expect, it } from 'vitest';
import { AttemptStream } from '../src/lib/stream.js';
import type { RunEvent, TranscriptChunk } from '@agent-workspace/contracts';

const occurredAt = '2026-09-13T00:00:00.000Z';

function event(sequence: number): RunEvent {
  return {
    id: `evt_${sequence}`,
    workspaceId: 'ws_test',
    runId: 'run_test',
    attemptId: 'att_test',
    sequence,
    clientSeq: sequence,
    createdAt: occurredAt,
    occurredAt,
    type: 'attempt.preparing',
    payload: { detail: `step ${sequence}` },
  };
}

function chunk(chunkSeq: number): TranscriptChunk {
  return {
    attemptId: 'att_test',
    chunkSeq,
    turnId: 'trn_test',
    frames: [{ t: 'text_delta', text: `chunk ${chunkSeq}` }],
    frameCount: 1,
    byteSize: 32,
    createdAt: occurredAt,
  };
}

describe('AttemptStream recovery', () => {
  it('buffers live messages before history and drains them after hydration', () => {
    const stream = new AttemptStream('att_test');

    expect(stream.acceptEvent(event(3))).toBe('gap');
    expect(stream.acceptChunk(chunk(3))).toBe('gap');
    expect(stream.events).toHaveLength(0);
    expect(stream.chunks).toHaveLength(0);

    stream.hydrate({
      events: [event(1), event(2)],
      chunks: [chunk(1), chunk(2)],
      cursor: { eventCursor: 2, chunkCursor: 2 },
    });

    expect(stream.events.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(stream.chunks.map((item) => item.chunkSeq)).toEqual([1, 2, 3]);
    expect(stream.needsEventBackfill()).toBe(false);
    expect(stream.needsTranscriptBackfill()).toBe(false);
  });

  it('does not duplicate buffered messages when the REST backfill races WebSocket delivery', () => {
    const stream = new AttemptStream('att_test');

    expect(stream.acceptEvent(event(3))).toBe('gap');
    stream.appendHistory({
      events: [event(1), event(2), event(3)],
      chunks: [],
    });

    expect(stream.events.map((item) => item.sequence)).toEqual([1, 2, 3]);
  });
});
