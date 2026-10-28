-- Model-assisted assessments. A request is recorded before the model is called and a result after,
-- so a crash between them leaves a visible request without a result. Both tables are append-only.
-- An assessment is bound to the evidence revision it read; a later revision makes it stale.

-- Replaces the placeholder `assessments` table from 0001, which allowed one row per case revision and
-- could record neither a request before the model call nor a retry after a failure. No code wrote to
-- it; the guard aborts this migration rather than drop rows if any exist.
CREATE TEMP TABLE assessments_drop_guard (remaining INTEGER NOT NULL CHECK (remaining = 0));
INSERT INTO assessments_drop_guard SELECT count(*) FROM assessments;
DROP TABLE assessments_drop_guard;
DROP TRIGGER assessments_no_update;
DROP TRIGGER assessments_no_delete;
DROP TABLE assessments;

CREATE TABLE assessment_requests (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  evidence_revision INTEGER NOT NULL CHECK (evidence_revision >= 1),
  evidence_sha256 TEXT NOT NULL CHECK (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  -- Attempts for one revision are numbered from 1; a new attempt is allowed only after the previous one failed.
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  prompt_version TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL CHECK (length(prompt_sha256) = 64 AND prompt_sha256 NOT GLOB '*[^0-9a-f]*'),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('live', 'recorded', 'scripted')),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  UNIQUE (case_id, evidence_revision, attempt)
) STRICT;

CREATE TRIGGER assessment_requests_next_attempt BEFORE INSERT ON assessment_requests
  WHEN NEW.attempt IS NOT (SELECT count(*) + 1 FROM assessment_requests WHERE case_id = NEW.case_id AND evidence_revision = NEW.evidence_revision)
  BEGIN SELECT RAISE(ABORT, 'assessment attempts must be numbered consecutively per evidence revision'); END;

CREATE TRIGGER assessment_requests_after_success BEFORE INSERT ON assessment_requests
  WHEN EXISTS (
    SELECT 1 FROM assessment_requests r JOIN assessment_results s ON s.request_id = r.id
    WHERE r.case_id = NEW.case_id AND r.evidence_revision = NEW.evidence_revision AND s.status = 'SUCCEEDED'
  )
  BEGIN SELECT RAISE(ABORT, 'this evidence revision already has a successful assessment'); END;

CREATE TRIGGER assessment_requests_no_update BEFORE UPDATE ON assessment_requests BEGIN SELECT RAISE(ABORT, 'assessment requests are immutable'); END;
CREATE TRIGGER assessment_requests_no_delete BEFORE DELETE ON assessment_requests BEGIN SELECT RAISE(ABORT, 'assessment requests are immutable'); END;

CREATE TABLE assessment_results (
  request_id TEXT PRIMARY KEY REFERENCES assessment_requests(id),
  status TEXT NOT NULL CHECK (status IN ('SUCCEEDED', 'FAILED')),
  failure_code TEXT,
  failure_detail TEXT,
  served_model TEXT,
  stop_reason TEXT,
  refusal_category TEXT,
  -- The provider's raw text, kept for audit whether or not it validated.
  response_text TEXT CHECK (response_text IS NULL OR length(CAST(response_text AS BLOB)) <= 262144),
  response_sha256 TEXT CHECK (response_sha256 IS NULL OR (length(response_sha256) = 64 AND response_sha256 NOT GLOB '*[^0-9a-f]*')),
  assessment_json TEXT CHECK (assessment_json IS NULL OR json_valid(assessment_json)),
  -- The services' raw answers when code checked an artifact lead.
  lead_json TEXT CHECK (lead_json IS NULL OR json_valid(lead_json)),
  decision_json TEXT NOT NULL CHECK (json_valid(decision_json)),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  thinking_tokens INTEGER CHECK (thinking_tokens IS NULL OR thinking_tokens >= 0),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  completed_at TEXT NOT NULL,
  CHECK ((status = 'SUCCEEDED') = (failure_code IS NULL)),
  CHECK ((status = 'SUCCEEDED') = (assessment_json IS NOT NULL)),
  CHECK ((response_text IS NULL) = (response_sha256 IS NULL))
) STRICT;

CREATE TRIGGER assessment_results_no_update BEFORE UPDATE ON assessment_results BEGIN SELECT RAISE(ABORT, 'assessment results are immutable'); END;
CREATE TRIGGER assessment_results_no_delete BEFORE DELETE ON assessment_results BEGIN SELECT RAISE(ABORT, 'assessment results are immutable'); END;
