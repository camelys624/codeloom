import { describe, expect, it } from 'vitest';
import type { Clock } from '@agent-workspace/contracts';
import { TurnBudget } from '../src/turn-budget.js';

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: Clock = {
    now: () => new Date(now),
    setTimeout: (callback, ms) => {
      const id = ++nextId;
      timers.set(id, { at: now + ms, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as unknown as number);
    },
  };
  return {
    clock,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
  };
}

describe('TurnBudget', () => {
  it('pauses the execution budget while approval is pending', () => {
    const fake = fakeClock();
    let expired = false;
    const budget = new TurnBudget(fake.clock, 1000, () => {
      expired = true;
    });

    budget.start();
    fake.advance(900);
    budget.pause();
    fake.advance(10_000);
    expect(expired).toBe(false);

    budget.resume();
    fake.advance(99);
    expect(expired).toBe(false);
    fake.advance(1);
    expect(expired).toBe(true);
  });
});
