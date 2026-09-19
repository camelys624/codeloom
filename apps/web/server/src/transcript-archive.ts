import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Pool } from 'pg';
import { iso, one, transaction } from './db.js';

export const TRANSCRIPT_RETENTION_DAYS = 180;
export const TRANSCRIPT_ARCHIVE_MIME =
  'application/x.codeloom-transcript+jsonl';
export const TRANSCRIPT_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;

const ARCHIVE_ATTEMPT_LIMIT = 128;
const ARCHIVE_ROW_LIMIT = 512;
const ARCHIVE_FORMAT = 'codeloom.transcript';
const ARCHIVE_VERSION = 1;

type Row = Record<string, any>;

type ArchiveChunk = {
  chunkSeq: number;
  turnId: string;
  frames: unknown;
  frameCount: number;
  byteSize: number;
  createdAt: string;
};

type ArchiveMeta = {
  workspaceId: string;
  runId: string;
  attemptId: string;
};

export type TranscriptArchiveResult = {
  attemptsScanned: number;
  chunksArchived: number;
  artifactsCreated: number;
};

function archiveHeader(meta: ArchiveMeta): string {
  return `${JSON.stringify({
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    ...meta,
  })}\n`;
}

function archiveChunk(row: Row): ArchiveChunk {
  return {
    chunkSeq: Number(row.chunk_seq),
    turnId: String(row.turn_id),
    frames:
      typeof row.frames === 'string' ? JSON.parse(row.frames) : row.frames,
    frameCount: Number(row.frame_count),
    byteSize: Number(row.byte_size),
    createdAt: iso(row.created_at),
  };
}

function archiveChunkLine(chunk: ArchiveChunk): string {
  return `${JSON.stringify(chunk)}\n`;
}

export function encodeTranscriptArchive(
  meta: ArchiveMeta,
  chunks: readonly ArchiveChunk[],
): Buffer {
  const body = archiveHeader(meta) + chunks.map(archiveChunkLine).join('');
  return Buffer.from(body, 'utf8');
}

async function writeBlob(
  dataDir: string,
  body: Buffer,
  digest: string,
): Promise<{ blobRef: string; path: string }> {
  const blobRef = join('blobs', `${digest}-${randomUUID()}`);
  const path = join(dataDir, blobRef);
  const tempPath = join(dataDir, 'tmp', `${randomUUID()}.transcript`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await mkdir(dirname(tempPath), { recursive: true, mode: 0o700 });
  try {
    await writeFile(tempPath, body, { mode: 0o600 });
    await rename(tempPath, path);
    return { blobRef, path };
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function archiveAttemptBatch(
  pool: Pool,
  dataDir: string,
  attemptId: string,
  cutoff: Date,
): Promise<
  | { chunksArchived: number; artifactsCreated: number; artifactId: string }
  | undefined
> {
  const createdBlobPaths: string[] = [];
  try {
    return await transaction(pool, async (client) => {
      const attempt = one(
        await client.query<Row>(
          'SELECT workspace_id, run_id FROM attempts WHERE id = $1 FOR SHARE',
          [attemptId],
        ),
        'Attempt not found while archiving transcript',
      );
      const result = await client.query<Row>(
        `SELECT chunk_seq, turn_id, frames, frame_count, byte_size, created_at
         FROM transcript_chunks
         WHERE attempt_id = $1 AND created_at < $2
         ORDER BY chunk_seq
         LIMIT $3
         FOR UPDATE SKIP LOCKED`,
        [attemptId, cutoff, ARCHIVE_ROW_LIMIT],
      );
      if (result.rows.length === 0) return undefined;

      const meta: ArchiveMeta = {
        workspaceId: String(attempt.workspace_id),
        runId: String(attempt.run_id),
        attemptId,
      };
      const header = archiveHeader(meta);
      const selectedRows: Row[] = [];
      const selectedChunks: ArchiveChunk[] = [];
      let byteSize = Buffer.byteLength(header, 'utf8');
      for (const row of result.rows) {
        const chunk = archiveChunk(row);
        const line = archiveChunkLine(chunk);
        const lineBytes = Buffer.byteLength(line, 'utf8');
        if (
          selectedRows.length > 0 &&
          byteSize + lineBytes > TRANSCRIPT_ARCHIVE_MAX_BYTES
        )
          break;
        if (byteSize + lineBytes > TRANSCRIPT_ARCHIVE_MAX_BYTES)
          throw new Error('Transcript chunk exceeds log artifact limit');
        selectedRows.push(row);
        selectedChunks.push(chunk);
        byteSize += lineBytes;
      }

      const body = encodeTranscriptArchive(meta, selectedChunks);
      const digest = createHash('sha256').update(body).digest('hex');
      const existing = await client.query<Row>(
        `SELECT id, blob_ref FROM artifacts
         WHERE workspace_id = $1 AND attempt_id = $2 AND turn_id IS NULL
           AND kind = 'log' AND mime_type = $3 AND sha256 = $4
         ORDER BY created_at, id LIMIT 1`,
        [meta.workspaceId, meta.attemptId, TRANSCRIPT_ARCHIVE_MIME, digest],
      );

      let artifactId: string;
      let artifactsCreated = 0;
      if (existing.rows[0]) {
        const existingPath = join(dataDir, String(existing.rows[0].blob_ref));
        await access(existingPath);
        artifactId = String(existing.rows[0].id);
      } else {
        const blob = await writeBlob(dataDir, body, digest);
        createdBlobPaths.push(blob.path);
        const artifact = one(
          await client.query<Row>(
            `INSERT INTO artifacts
              (workspace_id, run_id, attempt_id, turn_id, kind, blob_ref, size_bytes, sha256, mime_type)
             VALUES ($1, $2, $3, NULL, 'log', $4, $5, $6, $7)
             RETURNING id`,
            [
              meta.workspaceId,
              meta.runId,
              meta.attemptId,
              blob.blobRef,
              body.byteLength,
              digest,
              TRANSCRIPT_ARCHIVE_MIME,
            ],
          ),
          'Transcript archive artifact insert failed',
        );
        artifactId = String(artifact.id);
        artifactsCreated = 1;
      }

      const deleted = await client.query(
        `DELETE FROM transcript_chunks
         WHERE attempt_id = $1 AND created_at < $2 AND chunk_seq = ANY($3::bigint[])
         RETURNING chunk_seq`,
        [attemptId, cutoff, selectedRows.map((row) => String(row.chunk_seq))],
      );
      return {
        chunksArchived: deleted.rowCount ?? 0,
        artifactsCreated,
        artifactId,
      };
    });
  } catch (error) {
    await Promise.all(
      createdBlobPaths.map((path) => rm(path, { force: true })),
    );
    throw error;
  }
}

export async function archiveOldTranscripts(
  pool: Pool,
  dataDir: string,
  now = new Date(),
): Promise<TranscriptArchiveResult> {
  const cutoff = new Date(
    now.getTime() - TRANSCRIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const candidates = await pool.query<{ attempt_id: string }>(
    `SELECT DISTINCT attempt_id
     FROM transcript_chunks
     WHERE created_at < $1
     ORDER BY attempt_id
     LIMIT $2`,
    [cutoff, ARCHIVE_ATTEMPT_LIMIT],
  );
  const summary: TranscriptArchiveResult = {
    attemptsScanned: candidates.rows.length,
    chunksArchived: 0,
    artifactsCreated: 0,
  };
  for (const candidate of candidates.rows) {
    while (true) {
      const batch = await archiveAttemptBatch(
        pool,
        dataDir,
        candidate.attempt_id,
        cutoff,
      );
      if (!batch) break;
      summary.chunksArchived += batch.chunksArchived;
      summary.artifactsCreated += batch.artifactsCreated;
    }
  }
  return summary;
}
