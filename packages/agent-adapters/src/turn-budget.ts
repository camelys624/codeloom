import type { Clock } from '@agent-workspace/contracts';

export class TurnBudget {
  private remainingMs: number;
  private timer?: ReturnType<Clock['setTimeout']>;
  private startedAt?: number;
  private stopped = false;
  private expired = false;

  constructor(
    private readonly clock: Clock,
    durationMs: number,
    private readonly onExpired: () => void,
  ) {
    this.remainingMs = Math.max(0, durationMs);
  }

  start(): void {
    this.resume();
  }

  pause(): void {
    if (this.stopped || this.expired || this.timer === undefined) return;
    const elapsed = Math.max(
      0,
      this.clock.now().getTime() - (this.startedAt ?? this.clock.now().getTime()),
    );
    this.remainingMs = Math.max(0, this.remainingMs - elapsed);
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.startedAt = undefined;
  }

  resume(): void {
    if (this.stopped || this.expired || this.timer !== undefined) return;
    if (this.remainingMs <= 0) {
      this.expire();
      return;
    }
    this.startedAt = this.clock.now().getTime();
    this.timer = this.clock.setTimeout(() => this.expire(), this.remainingMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.startedAt = undefined;
  }

  private expire(): void {
    if (this.stopped || this.expired) return;
    this.expired = true;
    this.timer = undefined;
    this.startedAt = undefined;
    this.remainingMs = 0;
    this.onExpired();
  }
}
