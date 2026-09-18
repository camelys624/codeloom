import { describe, expect, it } from 'vitest';
import {
  TRANSCRIPT_ARCHIVE_MIME,
  TRANSCRIPT_ARCHIVE_MAX_BYTES,
  encodeTranscriptArchive,
} from '../src/transcript-archive.js';

describe('transcript archive format', () => {
  it('writes a self-describing UTF-8 JSONL archive with ordered chunks', () => {
    const body = encodeTranscriptArchive(
      {
        workspaceId: 'ws_test',
        runId: 'run_test',
        attemptId: 'att_test',
      },
      [
        {
          chunkSeq: 1,
          turnId: 'turn_test',
          frames: [{ t: 'text_delta', text: '你好' }],
          frameCount: 1,
          byteSize: 32,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    );
    const lines = body.toString('utf8').trimEnd().split('\n');
    const header = lines[0];
    const chunk = lines[1];
    expect(header).toBeDefined();
    expect(chunk).toBeDefined();
    expect(JSON.parse(header ?? '')).toEqual({
      format: 'codeloom.transcript',
      version: 1,
      workspaceId: 'ws_test',
      runId: 'run_test',
      attemptId: 'att_test',
    });
    expect(JSON.parse(chunk ?? '')).toMatchObject({
      chunkSeq: 1,
      turnId: 'turn_test',
      frames: [{ t: 'text_delta', text: '你好' }],
    });
    expect(Buffer.byteLength(body)).toBe(body.byteLength);
    expect(TRANSCRIPT_ARCHIVE_MIME).toBe(
      'application/x.codeloom-transcript+jsonl',
    );
    expect(TRANSCRIPT_ARCHIVE_MAX_BYTES).toBe(50 * 1024 * 1024);
  });
});
