import { describe, expect, it } from 'vitest';
import type { Task } from '@agent-workspace/contracts';
import {
  canMoveTask,
  sortTasks,
  taskMatchesFilters,
} from '../src/lib/tasks.js';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'tsk_test',
    workspaceId: 'ws_test',
    title: 'Improve task board',
    description: 'Make task triage faster',
    status: 'backlog',
    priority: 'low',
    repositoryId: null,
    revision: 1,
    createdBy: 'usr_test',
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('task board behavior', () => {
  it('filters by title, description, and exact priority', () => {
    expect(taskMatchesFilters(task(), 'triage', 'all')).toBe(true);
    expect(taskMatchesFilters(task(), 'missing', 'all')).toBe(false);
    expect(taskMatchesFilters(task(), '', 'low')).toBe(true);
    expect(taskMatchesFilters(task(), '', 'urgent')).toBe(false);
  });

  it('sorts priority before recency without mutating the query result', () => {
    const olderUrgent = task({
      id: 'tsk_urgent',
      priority: 'urgent',
      updatedAt: '2026-09-13T00:00:00.000Z',
    });
    const newerLow = task({
      id: 'tsk_low',
      priority: 'low',
      updatedAt: '2026-09-15T00:00:00.000Z',
    });
    const source = [newerLow, olderUrgent];
    expect(sortTasks(source).map((item) => item.id)).toEqual([
      'tsk_urgent',
      'tsk_low',
    ]);
    expect(source.map((item) => item.id)).toEqual(['tsk_low', 'tsk_urgent']);
  });

  it('allows only user-valid task status transitions', () => {
    expect(canMoveTask(task({ status: 'backlog' }), 'todo')).toBe(true);
    expect(canMoveTask(task({ status: 'done' }), 'todo')).toBe(false);
    expect(canMoveTask(task({ status: 'canceled' }), 'todo')).toBe(true);
  });
});
