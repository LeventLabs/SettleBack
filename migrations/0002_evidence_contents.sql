-- Stored evidence text and how it was received. evidence_items.content_sha256 is the SHA-256 of the
-- submitted bytes; stored_sha256 is the SHA-256 of `content`, the text after credential redaction.
-- The per-case limits are repeated here so the database refuses what the application should already have refused.

CREATE TABLE evidence_contents (
  evidence_id TEXT PRIMARY KEY REFERENCES evidence_items(id),
  operation_id TEXT NOT NULL REFERENCES operations(id),
  -- Position within the operation's evidence, contiguous from 1. The case snapshot at revision r is sequence <= r.
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 20),
  submitted_by TEXT NOT NULL CHECK (submitted_by IN ('server', 'reconciler', 'service', 'operator', 'seller', 'buyer')),
  media_type TEXT NOT NULL CHECK (media_type IN ('text/plain', 'application/json')),
  original_bytes INTEGER NOT NULL CHECK (original_bytes BETWEEN 1 AND 262144),
  stored_sha256 TEXT NOT NULL CHECK (length(stored_sha256) = 64 AND stored_sha256 NOT GLOB '*[^0-9a-f]*'),
  redactions_json TEXT NOT NULL CHECK (json_valid(redactions_json) AND json_type(redactions_json) = 'array'),
  content TEXT NOT NULL CHECK (length(CAST(content AS BLOB)) > 0),
  UNIQUE (operation_id, sequence)
) STRICT;

CREATE TRIGGER evidence_contents_same_operation BEFORE INSERT ON evidence_contents
  WHEN (SELECT operation_id FROM evidence_items WHERE id = NEW.evidence_id) IS NOT NEW.operation_id
  BEGIN SELECT RAISE(ABORT, 'evidence content must belong to the operation of its evidence item'); END;

CREATE TRIGGER evidence_contents_next_sequence BEFORE INSERT ON evidence_contents
  WHEN NEW.sequence IS NOT (SELECT count(*) + 1 FROM evidence_contents WHERE operation_id = NEW.operation_id)
  BEGIN SELECT RAISE(ABORT, 'evidence sequence must be the next position for the operation'); END;

CREATE TRIGGER evidence_contents_case_bytes BEFORE INSERT ON evidence_contents
  WHEN (SELECT coalesce(sum(original_bytes), 0) FROM evidence_contents WHERE operation_id = NEW.operation_id) + NEW.original_bytes > 1048576
  BEGIN SELECT RAISE(ABORT, 'evidence for one case may not exceed 1048576 bytes'); END;

CREATE TRIGGER evidence_contents_no_update BEFORE UPDATE ON evidence_contents BEGIN SELECT RAISE(ABORT, 'evidence is immutable; submit a new item'); END;
CREATE TRIGGER evidence_contents_no_delete BEFORE DELETE ON evidence_contents BEGIN SELECT RAISE(ABORT, 'evidence is immutable'); END;
