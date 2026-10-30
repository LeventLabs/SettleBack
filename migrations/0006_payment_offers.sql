-- Authorizations a gateway prepared for a payer to sign (HSP Agentic Payment). Each offer is
-- stored as received after the Payment Agent checked it, so the same offer is shown again until
-- its quote expires, a signature is verified against exactly it, and reconciliation knows the
-- amount and nonce the payer authorized. At most one offer per attempt is claimed: the one whose
-- signature was handed to the gateway, recorded in the transaction that consumed the permit.

CREATE TABLE payment_offers (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES payment_attempts(id),
  offer_json TEXT NOT NULL CHECK (json_valid(offer_json)),
  offer_sha256 TEXT NOT NULL CHECK (length(offer_sha256) = 64 AND offer_sha256 NOT GLOB '*[^0-9a-f]*'),
  authorized_base_units TEXT NOT NULL CHECK (authorized_base_units GLOB '[1-9]*' AND authorized_base_units NOT GLOB '*[^0-9]*'),
  authorization_nonce TEXT NOT NULL CHECK (length(authorization_nonce) = 66 AND authorization_nonce GLOB '0x*' AND substr(authorization_nonce, 3) NOT GLOB '*[^0-9a-f]*'),
  valid_before INTEGER NOT NULL CHECK (valid_before > 0),
  quote_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  claimed_at TEXT
) STRICT;

CREATE INDEX payment_offers_by_attempt ON payment_offers (attempt_id, created_at);
CREATE UNIQUE INDEX payment_offers_one_claimed ON payment_offers (attempt_id) WHERE claimed_at IS NOT NULL;
CREATE UNIQUE INDEX payment_offers_unique_nonce ON payment_offers (authorization_nonce);

CREATE TRIGGER payment_offers_claim_once BEFORE UPDATE ON payment_offers
WHEN OLD.claimed_at IS NOT NULL OR NEW.claimed_at IS NULL
  OR NEW.id IS NOT OLD.id OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.offer_json IS NOT OLD.offer_json
  OR NEW.offer_sha256 IS NOT OLD.offer_sha256 OR NEW.authorized_base_units IS NOT OLD.authorized_base_units
  OR NEW.authorization_nonce IS NOT OLD.authorization_nonce OR NEW.valid_before IS NOT OLD.valid_before
  OR NEW.quote_expires_at IS NOT OLD.quote_expires_at OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'a payment offer can only be claimed, once'); END;

CREATE TRIGGER payment_offers_no_delete BEFORE DELETE ON payment_offers BEGIN SELECT RAISE(ABORT, 'payment offers are permanent'); END;
