import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import type { OutboxMessage } from '@agent-workspace/contracts';
import { runnerFiles, type RunnerFiles } from './config.js';

export class Outbox {
  private messages: OutboxMessage[] = [];
  private initialized = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly files: RunnerFiles = runnerFiles()) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const content = await readFile(this.files.outbox, 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as OutboxMessage;
        this.messages.push(message);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private queueWrite(task: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.catch(() => undefined).then(task);
    this.writeQueue = next;
    return next;
  }

  private async persist(): Promise<void> {
    if (this.messages.length === 0) {
      await rm(this.files.outbox, { force: true });
      return;
    }
    await writeFile(
      this.files.outbox,
      `${this.messages.map((message) => JSON.stringify(message)).join('\n')}\n`,
      { mode: 0o600 },
    );
  }

  async enqueue(message: OutboxMessage): Promise<void> {
    await this.init();
    this.messages.push(message);
    await this.queueWrite(() =>
      appendFile(this.files.outbox, `${JSON.stringify(message)}\n`, {
        mode: 0o600,
      }),
    );
  }

  async acknowledge(
    kind: 'event' | 'transcript',
    attemptId: string,
    sequence: number,
  ): Promise<void> {
    await this.init();
    this.messages = this.messages.filter((message) => {
      if (kind === 'event' && message.type === 'attempt.event')
        return !(
          message.attemptId === attemptId && message.clientSeq <= sequence
        );
      if (kind === 'transcript' && message.type === 'attempt.transcript')
        return !(
          message.attemptId === attemptId && message.chunkSeq <= sequence
        );
      return true;
    });
    await this.queueWrite(() => this.persist());
  }

  async removeAttempt(attemptId: string): Promise<void> {
    await this.init();
    this.messages = this.messages.filter(
      (message) => message.attemptId !== attemptId,
    );
    await this.queueWrite(() => this.persist());
  }

  pending(): readonly OutboxMessage[] {
    return this.messages;
  }
}
