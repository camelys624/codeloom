import { z } from 'zod';
import type {
  AttemptStatus,
  RunStatus,
  TaskStatus,
  TurnStatus,
} from './domain.js';

export const ATTEMPT_TRANSITIONS: Readonly<
  Record<AttemptStatus, readonly AttemptStatus[]>
> = {
  queued: ['claimed', 'canceled', 'failed'],
  claimed: ['preparing', 'failed', 'canceled', 'lost'],
  preparing: ['running', 'failed', 'canceled', 'lost'],
  running: [
    'waiting_approval',
    'idle',
    'completed',
    'failed',
    'canceled',
    'lost',
  ],
  idle: ['running', 'completed', 'failed', 'canceled', 'lost'],
  waiting_approval: ['running', 'completed', 'failed', 'canceled', 'lost'],
  completed: [],
  failed: [],
  canceled: [],
  lost: [],
};

export const TURN_TRANSITIONS: Readonly<
  Record<TurnStatus, readonly TurnStatus[]>
> = {
  running: ['waiting_approval', 'completed', 'failed', 'canceled'],
  waiting_approval: ['running', 'failed', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
};

export const RUN_STATUS_BY_ATTEMPT: Readonly<Record<AttemptStatus, RunStatus>> =
  {
    queued: 'pending',
    claimed: 'pending',
    preparing: 'pending',
    running: 'active',
    idle: 'idle',
    waiting_approval: 'waiting_approval',
    completed: 'completed',
    failed: 'failed',
    canceled: 'canceled',
    lost: 'lost',
  };

export const TaskTransitionCauseSchema = z.enum([
  'user',
  'run_created',
  'run_completed',
  'run_failed',
  'run_canceled',
  'run_lost',
]);
export type TaskTransitionCause = z.infer<typeof TaskTransitionCauseSchema>;
type TaskTransition = {
  readonly to: TaskStatus;
  readonly cause: TaskTransitionCause;
};
/** Task completion is not terminal: a new Run can reopen done, and a user can reopen canceled. */
export const TASK_TRANSITIONS: Readonly<
  Record<TaskStatus, readonly TaskTransition[]>
> = {
  backlog: [
    { to: 'todo', cause: 'user' },
    { to: 'in_progress', cause: 'run_created' },
    { to: 'canceled', cause: 'user' },
  ],
  todo: [
    { to: 'backlog', cause: 'user' },
    { to: 'in_progress', cause: 'run_created' },
    { to: 'canceled', cause: 'user' },
  ],
  in_progress: [
    { to: 'needs_review', cause: 'run_completed' },
    { to: 'in_progress', cause: 'run_created' },
    { to: 'in_progress', cause: 'run_failed' },
    { to: 'in_progress', cause: 'run_canceled' },
    { to: 'in_progress', cause: 'run_lost' },
    { to: 'canceled', cause: 'user' },
  ],
  needs_review: [
    { to: 'done', cause: 'user' },
    { to: 'in_progress', cause: 'run_created' },
    { to: 'canceled', cause: 'user' },
  ],
  done: [{ to: 'in_progress', cause: 'run_created' }],
  canceled: [{ to: 'todo', cause: 'user' }],
};

export function canTransitionAttempt(
  from: AttemptStatus,
  to: AttemptStatus,
): boolean {
  return ATTEMPT_TRANSITIONS[from].includes(to);
}
export function transitionAttempt(
  from: AttemptStatus,
  to: AttemptStatus,
): AttemptStatus {
  if (!canTransitionAttempt(from, to))
    throw new Error(`Invalid Attempt transition: ${from} -> ${to}`);
  return to;
}
export function canTransitionTurn(from: TurnStatus, to: TurnStatus): boolean {
  return TURN_TRANSITIONS[from].includes(to);
}
export function transitionTurn(from: TurnStatus, to: TurnStatus): TurnStatus {
  if (!canTransitionTurn(from, to))
    throw new Error(`Invalid Turn transition: ${from} -> ${to}`);
  return to;
}
export function canTransitionTask(
  from: TaskStatus,
  to: TaskStatus,
  cause: TaskTransitionCause,
): boolean {
  return TASK_TRANSITIONS[from].some(
    (transition) => transition.to === to && transition.cause === cause,
  );
}
export function transitionTask(
  from: TaskStatus,
  to: TaskStatus,
  cause: TaskTransitionCause,
): TaskStatus {
  if (!canTransitionTask(from, to, cause))
    throw new Error(`Invalid Task transition: ${from} -> ${to} (${cause})`);
  return to;
}
export function projectRunStatus(status: AttemptStatus | undefined): RunStatus {
  return status === undefined ? 'pending' : RUN_STATUS_BY_ATTEMPT[status];
}
export function isTerminalAttempt(status: AttemptStatus): boolean {
  return ATTEMPT_TRANSITIONS[status].length === 0;
}
export function isTerminalTurn(status: TurnStatus): boolean {
  return TURN_TRANSITIONS[status].length === 0;
}
export function canRetryRun(status: RunStatus): boolean {
  return status === 'failed' || status === 'canceled' || status === 'lost';
}
