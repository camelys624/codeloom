CREATE INDEX transcript_chunks_created_at_idx
    ON transcript_chunks(created_at);

CREATE INDEX artifacts_transcript_archive_lookup_idx
    ON artifacts(attempt_id, sha256)
    WHERE kind = 'log'
      AND turn_id IS NULL
      AND mime_type = 'application/x.codeloom-transcript+jsonl';
