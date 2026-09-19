import { describe, expect, it, vi } from 'vitest';
import {
  ATTEMPT_METRIC_STATUSES,
  collectMetrics,
  formatPrometheus,
  type MetricsSnapshot,
} from '../src/metrics.js';

function snapshot(): MetricsSnapshot {
  return {
    runnersOnline: 2,
    attemptsByStatus: Object.fromEntries(
      ATTEMPT_METRIC_STATUSES.map((status) => [status, 0]),
    ) as MetricsSnapshot['attemptsByStatus'],
    attemptsLostTotal: 3,
    autoRetriesTotal: 4,
    claimLatencySeconds: 1.25,
    eventIngestLagSeconds: 0.5,
    transcriptChunksTotal: 20,
    approvalsPending: 1,
    runsWithMultipleActiveAttempts: 0,
    runnerMessagesTotal: 9,
    eventNacksTotal: 1,
    wsClients: 7,
  };
}

describe('Prometheus metrics formatting', () => {
  it('emits documented metrics with stable types and status labels', () => {
    const output = formatPrometheus(snapshot());

    expect(output).toContain('# TYPE aw_runners_online gauge');
    expect(output).toContain('aw_runners_online 2');
    expect(output).toContain(
      'aw_attempts_by_status{status="waiting_approval"} 0',
    );
    expect(output).toContain('# TYPE aw_attempts_lost_total counter');
    expect(output).toContain('aw_attempts_lost_total 3');
    expect(output).toContain('aw_runner_messages_total 9');
    expect(output).toContain('aw_event_nacks_total 1');
    expect(output).toContain('aw_claim_latency_seconds 1.25');
    expect(output).toContain('aw_runs_with_multiple_active_attempts 0');
    expect(output).toContain('aw_ws_clients 7');
    expect(output.endsWith('\n')).toBe(true);
  });

  it('escapes label values and never emits negative or non-finite samples', () => {
    const value = snapshot();
    value.attemptsByStatus.running = Number.NaN;
    expect(formatPrometheus(value)).toContain(
      'aw_attempts_by_status{status="running"} 0',
    );
  });
});

describe('Prometheus metrics collection', () => {
  it('maps database summary and status rows into a complete snapshot', async () => {
    const pool = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              runners_online: '2',
              attempts_lost_total: '3',
              auto_retries_total: '4',
              claim_latency_seconds: '1.25',
              event_ingest_lag_seconds: '0.5',
              transcript_chunks_total: '20',
              approvals_pending: '1',
              runs_multiple_active_attempts: '2',
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            { status: 'queued', count: '2' },
            { status: 'running', count: '1' },
          ],
        }),
    };

    await expect(collectMetrics(pool as never, 7, 9, 1)).resolves.toEqual({
      runnersOnline: 2,
      attemptsByStatus: {
        queued: 2,
        claimed: 0,
        preparing: 0,
        running: 1,
        idle: 0,
        waiting_approval: 0,
        completed: 0,
        failed: 0,
        canceled: 0,
        lost: 0,
      },
      attemptsLostTotal: 3,
      autoRetriesTotal: 4,
      claimLatencySeconds: 1.25,
      eventIngestLagSeconds: 0.5,
      transcriptChunksTotal: 20,
      approvalsPending: 1,
      runsWithMultipleActiveAttempts: 2,
      runnerMessagesTotal: 9,
      eventNacksTotal: 1,
      wsClients: 7,
    });
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('propagates database failures instead of publishing fabricated zeros', async () => {
    const failure = new Error('database unavailable');
    const pool = { query: vi.fn().mockRejectedValue(failure) };

    await expect(collectMetrics(pool as never, 0, 0, 0)).rejects.toBe(failure);
  });
});
