import type {
  TranscriptChunk,
  TranscriptFrame,
} from '@agent-workspace/contracts';

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

export function transcriptFrameText(frame: TranscriptFrame): string {
  switch (frame.t) {
    case 'text_delta':
      return frame.text;
    case 'thought_delta':
      return `[thought]\n${frame.text}`;
    case 'tool_call':
      return `[tool call] ${frame.tool}\n${json(frame.input)}`;
    case 'tool_result':
      return `[tool result] ${frame.output}`;
    case 'file_changed':
      return `[file changed] ${frame.path} (+${frame.add}/-${frame.del})`;
    case 'plan_updated':
      return `[plan]\n${json(frame.plan)}`;
    case 'usage':
      return `[usage] ${frame.usage.inputTokens} input / ${frame.usage.outputTokens} output`;
    case 'warning':
      return `[warning:${frame.code}] ${frame.message}`;
  }
}

export function filterTranscriptChunks(
  chunks: readonly TranscriptChunk[],
  query: string,
): TranscriptChunk[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...chunks];
  return chunks.filter((chunk) =>
    chunk.frames.some((frame) =>
      transcriptFrameText(frame).toLocaleLowerCase().includes(normalized),
    ),
  );
}

export function countTranscriptFrames(
  chunks: readonly TranscriptChunk[],
): number {
  return chunks.reduce((count, chunk) => count + chunk.frames.length, 0);
}

export function transcriptToText(chunks: readonly TranscriptChunk[]): string {
  if (chunks.length === 0) return '';
  return `${chunks
    .map((chunk) =>
      [
        `Turn ${chunk.turnId} · chunk #${chunk.chunkSeq}`,
        ...chunk.frames.map(transcriptFrameText),
      ].join('\n'),
    )
    .join('\n\n')}\n`;
}
