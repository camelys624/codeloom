import { describe, expect, it } from 'vitest';
import { AttemptStream } from '../../web/client/src/lib/stream.js';

type Event = Parameters<AttemptStream['acceptEvent']>[0];

function event(attemptId: string, sequence: number): Event {
  return {
    id: `evt_${attemptId}_${sequence}`,
    workspaceId: 'ws_chaos',
    runId: 'run_chaos',
    attemptId,
    sequence,
    clientSeq: sequence,
    type: 'attempt.claimed',
    occurredAt: '2026-09-18T00:00:00.000Z',
    createdAt: '2026-09-18T00:00:00.000Z',
    payload: {},
  };
}

describe('reliability chaos invariants', () => {
  it('replays random event delivery permutations without gaps or duplicates', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const stream = new AttemptStream(`att_${seed}`);
      const events = Array.from({ length: 25 }, (_, index) =>
        event(`att_${seed}`, index + 1),
      );
      let state = seed;
      for (let index = events.length - 1; index > 0; index -= 1) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        const swap = state % (index + 1);
        [events[index], events[swap]] = [events[swap], events[index]];
      }
      for (const item of events) stream.acceptEvent(item);
      expect(stream.events.map((item) => item.sequence)).toEqual(
        Array.from({ length: 25 }, (_, index) => index + 1),
      );
      expect(stream.needsEventBackfill()).toBe(false);
    }
  });
});
