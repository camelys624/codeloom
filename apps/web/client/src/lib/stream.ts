import type { RunEvent, TranscriptChunk } from '@agent-workspace/contracts';

type EventMessage = { attemptId: string; sequence: number; event: RunEvent };
type TranscriptMessage = {
  attemptId: string;
  chunkSeq: number;
  turnId: string;
  frames: TranscriptChunk['frames'];
};

export type StreamHydration = {
  events: readonly RunEvent[];
  chunks: readonly TranscriptChunk[];
  cursor: { eventCursor: number; chunkCursor: number };
};

export class AttemptStream {
  readonly events: RunEvent[] = [];
  readonly chunks: TranscriptChunk[] = [];
  private eventBuffer: EventMessage[] = [];
  private transcriptBuffer: TranscriptMessage[] = [];
  private historyLoaded = false;
  lastSequence = 0;
  lastChunkSeq = 0;

  constructor(readonly attemptId: string) {}

  get hydrated(): boolean {
    return this.historyLoaded;
  }

  hydrate(history: StreamHydration): void {
    if (this.historyLoaded) return;
    const eventSequences = new Set(this.events.map((event) => event.sequence));
    for (const event of history.events
      .filter((item) => item.attemptId === this.attemptId)
      .sort((left, right) => left.sequence - right.sequence)) {
      if (!eventSequences.has(event.sequence)) {
        this.events.push(event);
        eventSequences.add(event.sequence);
      }
    }
    this.events.sort((left, right) => left.sequence - right.sequence);
    const chunkSequences = new Set(this.chunks.map((chunk) => chunk.chunkSeq));
    for (const chunk of history.chunks
      .filter((item) => item.attemptId === this.attemptId)
      .sort((left, right) => left.chunkSeq - right.chunkSeq)) {
      if (!chunkSequences.has(chunk.chunkSeq)) {
        this.chunks.push(chunk);
        chunkSequences.add(chunk.chunkSeq);
      }
    }
    this.chunks.sort((left, right) => left.chunkSeq - right.chunkSeq);
    this.lastSequence = Math.max(
      history.cursor.eventCursor,
      this.events.at(-1)?.sequence ?? 0,
    );
    this.lastChunkSeq = Math.max(
      history.cursor.chunkCursor,
      this.chunks.at(-1)?.chunkSeq ?? 0,
    );
    this.historyLoaded = true;
    const bufferedEvents = this.eventBuffer
      .sort((left, right) => left.sequence - right.sequence)
      .splice(0);
    const bufferedChunks = this.transcriptBuffer
      .sort((left, right) => left.chunkSeq - right.chunkSeq)
      .splice(0);
    for (const message of bufferedEvents) this.acceptEvent(message.event);
    for (const message of bufferedChunks)
      this.acceptChunk({
        attemptId: this.attemptId,
        chunkSeq: message.chunkSeq,
        turnId: message.turnId,
        frames: message.frames,
        frameCount: message.frames.length,
        byteSize: JSON.stringify(message.frames).length,
        createdAt: new Date().toISOString(),
      });
  }

  appendHistory(history: StreamHydration): void {
    for (const event of history.events) this.acceptEvent(event);
    for (const chunk of history.chunks) this.acceptChunk(chunk);
  }

  acceptEvent(event: RunEvent): 'accepted' | 'duplicate' | 'gap' {
    if (
      event.attemptId !== this.attemptId ||
      event.sequence <= this.lastSequence
    )
      return 'duplicate';
    if (event.sequence !== this.lastSequence + 1) {
      if (!this.eventBuffer.some((item) => item.sequence === event.sequence))
        this.eventBuffer.push({
          attemptId: this.attemptId,
          sequence: event.sequence,
          event,
        });
      return 'gap';
    }
    this.events.push(event);
    this.lastSequence = event.sequence;
    this.drainEvents();
    return 'accepted';
  }

  acceptChunk(chunk: TranscriptChunk): 'accepted' | 'duplicate' | 'gap' {
    if (
      chunk.attemptId !== this.attemptId ||
      chunk.chunkSeq <= this.lastChunkSeq
    )
      return 'duplicate';
    if (chunk.chunkSeq !== this.lastChunkSeq + 1) {
      if (
        !this.transcriptBuffer.some((item) => item.chunkSeq === chunk.chunkSeq)
      )
        this.transcriptBuffer.push({
          attemptId: this.attemptId,
          chunkSeq: chunk.chunkSeq,
          turnId: chunk.turnId,
          frames: chunk.frames,
        });
      return 'gap';
    }
    this.chunks.push(chunk);
    this.lastChunkSeq = chunk.chunkSeq;
    this.drainChunks();
    return 'accepted';
  }

  private drainEvents(): void {
    this.eventBuffer.sort((a, b) => a.sequence - b.sequence);
    while (this.eventBuffer[0]?.sequence === this.lastSequence + 1) {
      const next = this.eventBuffer.shift();
      if (!next) break;
      this.events.push(next.event);
      this.lastSequence = next.sequence;
    }
  }

  private drainChunks(): void {
    this.transcriptBuffer.sort((a, b) => a.chunkSeq - b.chunkSeq);
    while (this.transcriptBuffer[0]?.chunkSeq === this.lastChunkSeq + 1) {
      const next = this.transcriptBuffer.shift();
      if (!next) break;
      this.chunks.push({
        attemptId: this.attemptId,
        chunkSeq: next.chunkSeq,
        turnId: next.turnId,
        frames: next.frames,
        frameCount: next.frames.length,
        byteSize: JSON.stringify(next.frames).length,
        createdAt: new Date().toISOString(),
      });
      this.lastChunkSeq = next.chunkSeq;
    }
  }

  needsEventBackfill(): boolean {
    return this.eventBuffer.length > 0;
  }

  needsTranscriptBackfill(): boolean {
    return this.transcriptBuffer.length > 0;
  }
}
