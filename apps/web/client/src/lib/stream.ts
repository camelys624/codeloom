import type { RunEvent, TranscriptChunk } from '@agent-workspace/contracts';

type EventMessage = { attemptId: string; sequence: number; event: RunEvent };
type TranscriptMessage = {
  attemptId: string;
  chunkSeq: number;
  turnId: string;
  frames: TranscriptChunk['frames'];
};

export class AttemptStream {
  readonly events: RunEvent[] = [];
  readonly chunks: TranscriptChunk[] = [];
  private eventBuffer: EventMessage[] = [];
  private transcriptBuffer: TranscriptMessage[] = [];
  lastSequence = 0;
  lastChunkSeq = 0;

  constructor(readonly attemptId: string) {}

  load(events: readonly RunEvent[], chunks: readonly TranscriptChunk[]): void {
    for (const event of events) this.acceptEvent(event);
    for (const chunk of chunks) this.acceptChunk(chunk);
  }

  acceptEvent(event: RunEvent): 'accepted' | 'duplicate' | 'gap' {
    if (
      event.attemptId !== this.attemptId ||
      event.sequence <= this.lastSequence
    )
      return 'duplicate';
    if (event.sequence !== this.lastSequence + 1) {
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
