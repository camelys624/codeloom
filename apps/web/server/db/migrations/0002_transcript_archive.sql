CREATE INDEX transcript_chunks_created_at_idx
    ON transcript_chunks(created_at);

CREATE INDEX artifacts_transcript_archive_lookup_idx
    ON artifacts(attempt_id, sha256)
    WHERE kind = 'log'
      AND turn_id IS NULL
      AND mime_type = 'application/x.codeloom-transcript+jsonl';

ALTER TABLE attempts
    ADD COLUMN cleanup_status text CHECK (cleanup_status IN ('cleaned', 'missing', 'skipped_dirty', 'failed')),
    ADD COLUMN cleanup_detail text,
    ADD COLUMN cleanup_reported_at timestamptz;

CREATE INDEX attempts_cleanup_pending_idx
    ON attempts(runner_id, finished_at, cleanup_status)
    WHERE status = 'completed';
