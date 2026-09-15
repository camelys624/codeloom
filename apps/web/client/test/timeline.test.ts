import { describe, expect, it } from 'vitest';
import type { RunEvent, Turn } from '@agent-workspace/contracts';
import { buildTimeline } from '../src/lib/timeline.js';

function event(
  type: RunEvent['type'],
  sequence: number,
  occurredAt: string,
  turnId?: string,
): RunEvent {
  const payload =
    type === 'attempt.started'
      ? {
          enforcement: {
            filesystem: 'engine' as const,
            network: 'none' as const,
            shell: 'runner' as const,
            gitPush: 'none' as const,
          },
          engineVersion: 'test',
        }
      : type === 'turn.started'
        ? { number: 1, prompt: 'Prompt 1' }
        : type === 'approval.requested'
          ? {
              requestId: 'apr_test',
              kind: 'tool' as const,
              title: 'Run tool',
              payload: {},
              expiresAt: '2026-09-15T00:05:00.000Z',
            }
          : type === 'turn.completed'
            ? {
                usage: undefined,
                diffStats: { files: 0, additions: 0, deletions: 0 },
                commitSha: '0123456789abcdef0123456789abcdef01234567',
                patchArtifactId: 'art_test',
              }
            : {};
  return {
    id: `evt_${sequence}`,
    workspaceId: 'ws_test',
    runId: 'run_test',
    attemptId: 'att_test',
    sequence,
    clientSeq: sequence,
    createdAt: occurredAt,
    occurredAt,
    type,
    ...(turnId ? { turnId } : {}),
    payload,
  } as RunEvent;
}

function turn(number: number, startedAt: string): Turn {
  return {
    id: `trn_${number}`,
    attemptId: 'att_test',
    number,
    prompt: `Prompt ${number}`,
    status: 'completed',
    startedAt,
  } as Turn;
}

describe('Run timeline', () => {
  it('orders turns with lifecycle events and removes duplicated turn events', () => {
    const entries = buildTimeline(
      [
        event('attempt.started', 1, '2026-09-15T00:00:01.000Z'),
        event('turn.started', 2, '2026-09-15T00:00:02.000Z', 'trn_1'),
        event('approval.requested', 3, '2026-09-15T00:00:03.000Z', 'trn_1'),
        event('turn.completed', 4, '2026-09-15T00:00:04.000Z', 'trn_1'),
      ],
      [turn(1, '2026-09-15T00:00:02.000Z')],
    );
    expect(entries.map((entry) => entry.kind)).toEqual([
      'event',
      'turn',
      'event',
    ]);
    expect(entries[1]?.kind === 'turn' && entries[1].turn.number).toBe(1);
  });
});
