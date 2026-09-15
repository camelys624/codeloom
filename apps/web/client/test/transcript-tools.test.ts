import { describe, expect, it } from 'vitest';
import type { TranscriptChunk } from '@agent-workspace/contracts';
import {
  countTranscriptFrames,
  filterTranscriptChunks,
  transcriptToText,
} from '../src/lib/transcript.js';

function chunk(
  chunkSeq: number,
  frames: TranscriptChunk['frames'],
): TranscriptChunk {
  return {
    attemptId: 'att_test',
    chunkSeq,
    turnId: 'trn_test',
    frames,
    frameCount: frames.length,
    byteSize: 64,
    createdAt: '2026-09-15T00:00:00.000Z',
  };
}

describe('transcript tools', () => {
  it('searches frame text and structured tool input without changing chunks', () => {
    const source = [
      chunk(1, [{ t: 'text_delta', text: 'Refactor the parser' }]),
      chunk(2, [
        {
          t: 'tool_call',
          callId: 'call_test',
          tool: 'shell',
          input: { command: 'bun test parser' },
        },
      ]),
    ];
    expect(
      filterTranscriptChunks(source, 'PARSER').map((item) => item.chunkSeq),
    ).toEqual([1, 2]);
    expect(filterTranscriptChunks(source, 'missing')).toEqual([]);
    expect(source.map((item) => item.chunkSeq)).toEqual([1, 2]);
  });

  it('formats all selected chunks for a plain-text download', () => {
    const selected = [
      chunk(3, [
        { t: 'warning', code: 'slow', message: 'Retrying request' },
        { t: 'file_changed', path: 'src/parser.ts', add: 4, del: 1 },
      ]),
    ];
    expect(countTranscriptFrames(selected)).toBe(2);
    expect(transcriptToText(selected)).toContain('chunk #3');
    expect(transcriptToText(selected)).toContain(
      '[warning:slow] Retrying request',
    );
    expect(transcriptToText(selected)).toContain(
      '[file changed] src/parser.ts (+4/-1)',
    );
  });
});
