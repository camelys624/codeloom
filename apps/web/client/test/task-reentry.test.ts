import { describe, expect, it } from 'vitest';
import { AttemptStream } from '../src/lib/stream.js';

describe('Task re-entry stream support', () => {
  it('keeps a Run stream usable when the user returns to Task detail', () => {
    const stream = new AttemptStream('att_task_return');
    expect(stream.attemptId).toBe('att_task_return');
    expect(stream.events).toEqual([]);
    expect(stream.chunks).toEqual([]);
  });
});
