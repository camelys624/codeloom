import type { RunEvent, Turn } from '@agent-workspace/contracts';

const TURN_EVENT_TYPES: Partial<Record<RunEvent['type'], true>> = {
  'turn.started': true,
  'turn.completed': true,
  'turn.failed': true,
  'turn.canceled': true,
};

export type TimelineEntry =
  | { kind: 'event'; at: string; event: RunEvent }
  | { kind: 'turn'; at: string; turn: Turn };

/** Build one chronological view without duplicating Turn lifecycle events. */
export function buildTimeline(
  events: readonly RunEvent[],
  turns: readonly Turn[],
): TimelineEntry[] {
  const turnIds = new Set(turns.map((turn) => turn.id));
  const entries: TimelineEntry[] = [];
  for (const event of events) {
    if (
      event.turnId &&
      turnIds.has(event.turnId) &&
      TURN_EVENT_TYPES[event.type]
    )
      continue;
    entries.push({ kind: 'event', at: event.occurredAt, event });
  }
  for (const turn of turns)
    entries.push({ kind: 'turn', at: turn.startedAt, turn });
  return entries.sort((left, right) => {
    const byTime = left.at.localeCompare(right.at);
    if (byTime !== 0) return byTime;
    if (left.kind !== right.kind) return left.kind === 'turn' ? -1 : 1;
    if (left.kind === 'turn' && right.kind === 'turn')
      return left.turn.number - right.turn.number;
    if (left.kind === 'event' && right.kind === 'event')
      return left.event.sequence - right.event.sequence;
    return 0;
  });
}
