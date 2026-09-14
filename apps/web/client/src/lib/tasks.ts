import {
  canTransitionTask,
  type Task,
  type TaskStatus,
} from '@agent-workspace/contracts';

export const TASK_COLUMNS = [
  'backlog',
  'todo',
  'in_progress',
  'needs_review',
  'done',
  'canceled',
] as const satisfies readonly TaskStatus[];

export const TASK_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In progress',
  needs_review: 'Review',
  done: 'Done',
  canceled: 'Canceled',
};

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function taskMatchesFilters(
  task: Task,
  query: string,
  priority: TaskPriority | 'all',
): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchesQuery =
    normalizedQuery.length === 0 ||
    task.title.toLocaleLowerCase().includes(normalizedQuery) ||
    task.description.toLocaleLowerCase().includes(normalizedQuery);
  const matchesPriority = priority === 'all' || task.priority === priority;
  return matchesQuery && matchesPriority;
}

export function sortTasks(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((left, right) => {
    const leftPriority = left.priority
      ? PRIORITY_ORDER[left.priority]
      : PRIORITY_ORDER.low + 1;
    const rightPriority = right.priority
      ? PRIORITY_ORDER[right.priority]
      : PRIORITY_ORDER.low + 1;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return (
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.title.localeCompare(right.title)
    );
  });
}

export function canMoveTask(task: Task, target: TaskStatus): boolean {
  return (
    task.status === target || canTransitionTask(task.status, target, 'user')
  );
}
