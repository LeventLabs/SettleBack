-- The full recovery proposal behind each recovery action, stored as written. recovery_actions keeps
-- the columns other checks query; this table keeps every bound field, so the digest the registry
-- records can be recomputed and compared on every read.

CREATE TABLE recovery_proposals (
  action_id TEXT PRIMARY KEY REFERENCES recovery_actions(id),
  proposal_json TEXT NOT NULL CHECK (json_valid(proposal_json) AND json_type(proposal_json) = 'object'),
  proposal_sha256 TEXT NOT NULL CHECK (length(proposal_sha256) = 64 AND proposal_sha256 NOT GLOB '*[^0-9a-f]*')
) STRICT;

CREATE TRIGGER recovery_proposals_match_action BEFORE INSERT ON recovery_proposals
  WHEN (SELECT action_sha256 FROM recovery_actions WHERE id = NEW.action_id) IS NOT NEW.proposal_sha256
  BEGIN SELECT RAISE(ABORT, 'proposal digest must equal the recovery action digest'); END;

CREATE TRIGGER recovery_proposals_no_update BEFORE UPDATE ON recovery_proposals BEGIN SELECT RAISE(ABORT, 'recovery proposals are immutable'); END;
CREATE TRIGGER recovery_proposals_no_delete BEFORE DELETE ON recovery_proposals BEGIN SELECT RAISE(ABORT, 'recovery proposals are immutable'); END;
