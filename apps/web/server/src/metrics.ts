import type { Pool } from 'pg';

export const ATTEMPT_METRIC_STATUSES = [
  'queued',
  'claimed',
  'preparing',
  'running',
  'idle',
  'waiting_approval',
  'completed',
  'failed',
  'canceled',
  'lost',
] as const;

export type AttemptMetricStatus = (typeof ATTEMPT_METRIC_STATUSES)[number];

export type MetricsSnapshot = {
  runnersOnline: number;
  attemptsByStatus: Record<AttemptMetricStatus, number>;
  attemptsLostTotal: number;
  autoRetriesTotal: number;
  claimLatencySeconds: number;
  eventIngestLagSeconds: number;
  transcriptChunksTotal: number;
  approvalsPending: number;
  runsWithMultipleActiveAttempts: number;
  runnerMessagesTotal: number;
  eventNacksTotal: number;
  wsClients: number;
};

type MetricsRow = Record<string, unknown>;

function metricNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function metricText(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0';
  return value === 0 ? '0' : String(value);
}

function escapeLabel(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll('"', '\\"');
}

export async function collectMetrics(
  pool: Pool,
  wsClients: number,
  runnerMessagesTotal: number,
  eventNacksTotal: number,
): Promise<MetricsSnapshot> {
  const [summaryResult, statusesResult] = await Promise.all([
    pool.query<MetricsRow>(`
      SELECT
        (SELECT count(*) FROM runners WHERE status = 'online')::text AS runners_online,
        (SELECT count(*) FROM attempts WHERE status = 'lost')::text AS attempts_lost_total,
        COALESCE((SELECT sum(auto_retry_count) FROM runs), 0)::text AS auto_retries_total,
        COALESCE((
          SELECT avg(EXTRACT(EPOCH FROM (claimed_at - created_at)))
          FROM attempts
          WHERE claimed_at IS NOT NULL
            AND claimed_at >= now() - interval '24 hours'
        ), 0)::double precision AS claim_latency_seconds,
        COALESCE((
          SELECT max(GREATEST(EXTRACT(EPOCH FROM (created_at - occurred_at)), 0))
          FROM run_events
          WHERE created_at >= now() - interval '5 minutes'
        ), 0)::double precision AS event_ingest_lag_seconds,
        (SELECT count(*) FROM transcript_chunks)::text AS transcript_chunks_total,
        (SELECT count(*) FROM approval_requests WHERE status = 'pending')::text AS approvals_pending,
        COALESCE((
          SELECT count(*)
          FROM (
            SELECT run_id
            FROM attempts
            WHERE status IN ('claimed', 'preparing', 'running', 'idle', 'waiting_approval')
            GROUP BY run_id
            HAVING count(*) > 1
          ) AS violations
        ), 0)::text AS runs_multiple_active_attempts
    `),
    pool.query<MetricsRow>(`
      SELECT status, count(*)::text AS count
      FROM attempts
      GROUP BY status
    `),
  ]);

  const summary = summaryResult.rows[0] ?? {};
  const attemptsByStatus = Object.fromEntries(
    ATTEMPT_METRIC_STATUSES.map((status) => [status, 0]),
  ) as Record<AttemptMetricStatus, number>;
  for (const row of statusesResult.rows) {
    const status = String(row.status) as AttemptMetricStatus;
    if (status in attemptsByStatus)
      attemptsByStatus[status] = metricNumber(row.count);
  }

  return {
    runnersOnline: metricNumber(summary.runners_online),
    attemptsByStatus,
    attemptsLostTotal: metricNumber(summary.attempts_lost_total),
    autoRetriesTotal: metricNumber(summary.auto_retries_total),
    claimLatencySeconds: metricNumber(summary.claim_latency_seconds),
    eventIngestLagSeconds: metricNumber(summary.event_ingest_lag_seconds),
    transcriptChunksTotal: metricNumber(summary.transcript_chunks_total),
    runnerMessagesTotal: metricNumber(runnerMessagesTotal),
    eventNacksTotal: metricNumber(eventNacksTotal),
    wsClients: metricNumber(wsClients),
    approvalsPending: metricNumber(summary.approvals_pending),
    runsWithMultipleActiveAttempts: metricNumber(
      summary.runs_multiple_active_attempts,
    ),
  };
}

export function formatPrometheus(snapshot: MetricsSnapshot): string {
  const lines = [
    '# HELP aw_runners_online Number of runners currently connected to the service.',
    '# TYPE aw_runners_online gauge',
    `aw_runners_online ${metricText(snapshot.runnersOnline)}`,
    '# HELP aw_attempts_by_status Number of Attempts currently in each status.',
    '# TYPE aw_attempts_by_status gauge',
    ...ATTEMPT_METRIC_STATUSES.map(
      (status) =>
        `aw_attempts_by_status{status="${escapeLabel(status)}"} ${metricText(snapshot.attemptsByStatus[status])}`,
    ),
    '# HELP aw_attempts_lost_total Total number of Attempts that reached lost.',
    '# TYPE aw_attempts_lost_total counter',
    `aw_attempts_lost_total ${metricText(snapshot.attemptsLostTotal)}`,
    '# HELP aw_auto_retries_total Total number of pre-start automatic retries requested.',
    '# TYPE aw_auto_retries_total counter',
    `aw_auto_retries_total ${metricText(snapshot.autoRetriesTotal)}`,
    '# HELP aw_claim_latency_seconds Average time from Attempt creation to claim for Attempts claimed in the last 24 hours.',
    '# TYPE aw_claim_latency_seconds gauge',
    `aw_claim_latency_seconds ${metricText(snapshot.claimLatencySeconds)}`,
    '# HELP aw_event_ingest_lag_seconds Maximum event ingest lag observed in the last 5 minutes.',
    '# TYPE aw_event_ingest_lag_seconds gauge',
    `aw_event_ingest_lag_seconds ${metricText(snapshot.eventIngestLagSeconds)}`,
    '# HELP aw_transcript_chunks_total Total number of transcript chunks stored.',
    '# TYPE aw_transcript_chunks_total counter',
    `aw_transcript_chunks_total ${metricText(snapshot.transcriptChunksTotal)}`,
    '# HELP aw_approvals_pending Number of approval requests currently pending.',
    '# TYPE aw_approvals_pending gauge',
    `aw_approvals_pending ${metricText(snapshot.approvalsPending)}`,
    '# HELP aw_runs_with_multiple_active_attempts Number of Runs violating the single-active-Attempt invariant.',
    '# TYPE aw_runs_with_multiple_active_attempts gauge',
    `aw_runs_with_multiple_active_attempts ${metricText(snapshot.runsWithMultipleActiveAttempts)}`,
    '# HELP aw_runner_messages_total Total Runner event and transcript messages received.',
    '# TYPE aw_runner_messages_total counter',
    `aw_runner_messages_total ${metricText(snapshot.runnerMessagesTotal)}`,
    '# HELP aw_event_nacks_total Total Runner event or transcript messages rejected with a nack.',
    '# TYPE aw_event_nacks_total counter',
    `aw_event_nacks_total ${metricText(snapshot.eventNacksTotal)}`,
    '# HELP aw_ws_clients Number of browser WebSocket connections currently open.',
    '# TYPE aw_ws_clients gauge',
    `aw_ws_clients ${metricText(snapshot.wsClients)}`,
  ];
  return `${lines.join('\n')}\n`;
}
