-- Wallet sign-in sessions. A session exists only after a verified signature over a challenge the
-- server issued, and the challenge nonce is unique, so one signed challenge opens at most one
-- session. Only the SHA-256 of the session token is stored. A session can be revoked once and is
-- never deleted, so the table is also the sign-in record.

CREATE TABLE sessions (
  token_sha256 TEXT PRIMARY KEY CHECK (length(token_sha256) = 64 AND token_sha256 NOT GLOB '*[^0-9a-f]*'),
  nonce TEXT NOT NULL UNIQUE CHECK (length(nonce) = 64 AND nonce NOT GLOB '*[^0-9a-f]*'),
  environment TEXT NOT NULL CHECK (environment IN ('local', 'testnet', 'mixed', 'mainnet')),
  address TEXT NOT NULL CHECK (length(address) = 42 AND address GLOB '0x*' AND substr(address, 3) NOT GLOB '*[^0-9a-f]*'),
  chain_id INTEGER NOT NULL CHECK (chain_id > 0),
  roles TEXT NOT NULL CHECK (roles IN ('', 'operator')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > created_at),
  revoked_at TEXT,
  revoke_reason TEXT CHECK (revoke_reason IS NULL OR revoke_reason IN ('LOGOUT', 'REPLACED', 'WALLET_CHANGED', 'ROLE_REMOVED')),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
) STRICT;

CREATE TRIGGER sessions_revoke_once BEFORE UPDATE ON sessions
WHEN OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
  OR NEW.token_sha256 IS NOT OLD.token_sha256 OR NEW.nonce IS NOT OLD.nonce OR NEW.environment IS NOT OLD.environment
  OR NEW.address IS NOT OLD.address OR NEW.chain_id IS NOT OLD.chain_id OR NEW.roles IS NOT OLD.roles
  OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT, 'a session can only be revoked, once'); END;

CREATE TRIGGER sessions_no_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'sessions are kept as the sign-in record'); END;
