import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttemptStream } from '../../web/client/src/lib/stream.js';
import { Outbox } from '../src/outbox.js';
import { runnerFiles } from '../src/config.js';

describe('reliability chaos invariants', () => {
  it('buffers out-of-order browser events and drains them without duplicates', () => {
    const stream = new AttemptStream('att_chaos');
    const event = (sequence: number) => ({
      id: `evt_${sequence}`,
      workspaceId: 'ws_chaos',
      runId: 'run_chaos',
      attemptId: 'att_chaos',
      sequence,
      clientSeq: sequence,
      type: 'attempt.claimed' as const,
      occurredAt: '2026-09-18T00:00:00.000Z',
      createdAt: '2026-09-18T00:00:00.000Z',
      payload: {},
    });
    expect(stream.acceptEvent(event(3))).toBe('gap');
    expect(stream.acceptEvent(event(1))).toBe('accepted');
    expect(stream.acceptEvent(event(2))).toBe('accepted');
    expect(stream.acceptEvent(event(3))).toBe('duplicate');
    expect(stream.acceptEvent(event(2))).toBe('duplicate');
    expect(stream.events.map((item) => item.sequence)).toEqual([1, 2, 3]);
  });

  it('keeps unacknowledged Runner messages across a write/reload cycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aw-chaos-outbox-'));
    try {
      const files = runnerFiles(root);
      const first = new Outbox(files);
      await first.init();
      await first.enqueue({
        type: 'attempt.event',
        attemptId: 'att_chaos',
        clientSeq: 1,
        event: {
          type: 'attempt.claimed',
          occurredAt: '2026-09-18T00:00:00.000Z',
          payload: {},
        },
      });
      const second = new Outbox(files);
      await second.init();
      expect(second.pending()).toHaveLength(1);
      await second.acknowledge('event', 'att_chaos', 1);
      await expect(readFile(files.outbox, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
