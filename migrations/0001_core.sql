-- Core records for operations, payments, evidence, cases, and recovery actions.
-- Amounts are base-unit integer strings; hashes are lowercase hex; addresses are lowercase.
-- Immutable records reject UPDATE and DELETE. Mutable records must advance revision by exactly one.

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TRIGGER meta_no_update BEFORE UPDATE ON meta BEGIN SELECT RAISE(ABORT, 'meta is immutable'); END;
CREATE TRIGGER meta_no_delete BEFORE DELETE ON meta BEGIN SELECT RAISE(ABORT, 'meta is immutable'); END;

CREATE TABLE policies (
  id TEXT PRIMARY KEY CHECK (id GLOB '[a-z0-9]*' AND id NOT GLOB '*[^a-z0-9-]*'),
  content TEXT NOT NULL CHECK (length(content) > 0),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER policies_no_update BEFORE UPDATE ON policies BEGIN SELECT RAISE(ABORT, 'policies are immutable; publish a new version'); END;
CREATE TRIGGER policies_no_delete BEFORE DELETE ON policies BEGIN SELECT RAISE(ABORT, 'policies are immutable'); END;

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL CHECK (environment IN ('local', 'testnet', 'mixed', 'mainnet')),
  buyer TEXT NOT NULL CHECK (length(buyer) = 42 AND buyer GLOB '0x*' AND substr(buyer, 3) NOT GLOB '*[^0-9a-f]*'),
  seller TEXT NOT NULL CHECK (length(seller) = 42 AND seller GLOB '0x*' AND substr(seller, 3) NOT GLOB '*[^0-9a-f]*'),
  service_id TEXT NOT NULL CHECK (length(service_id) > 0),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  policy_id TEXT NOT NULL REFERENCES policies(id),
  policy_sha256 TEXT NOT NULL CHECK (length(policy_sha256) = 64 AND policy_sha256 NOT GLOB '*[^0-9a-f]*'),
  chain_id INTEGER NOT NULL CHECK (chain_id > 0),
  token TEXT NOT NULL CHECK (length(token) = 42 AND token GLOB '0x*' AND substr(token, 3) NOT GLOB '*[^0-9a-f]*'),
  token_decimals INTEGER NOT NULL CHECK (token_decimals BETWEEN 0 AND 36),
  price_usd TEXT NOT NULL CHECK (
    price_usd GLOB '[0-9]*.[0-9][0-9]' AND price_usd NOT GLOB '*[^0-9.]*'
    AND length(price_usd) - length(replace(price_usd, '.', '')) = 1
    AND (price_usd GLOB '0.*' OR price_usd NOT GLOB '0*')
    AND price_usd <> '0.00'
  ),
  amount_base_units TEXT NOT NULL CHECK (
    amount_base_units GLOB '[1-9]*' AND amount_base_units NOT GLOB '*[^0-9]*'
  ),
  intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256) = 64 AND intent_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  CHECK (buyer <> seller)
) STRICT;

CREATE TRIGGER operations_no_update BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT, 'operations are immutable'); END;
CREATE TRIGGER operations_no_delete BEFORE DELETE ON operations BEGIN SELECT RAISE(ABORT, 'operations are immutable'); END;

CREATE TABLE idempotency_records (
  actor TEXT NOT NULL,
  route TEXT NOT NULL,
  key TEXT NOT NULL CHECK (length(key) BETWEEN 8 AND 128),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  result_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor, route, key)
) STRICT;

CREATE TRIGGER idempotency_no_update BEFORE UPDATE ON idempotency_records BEGIN SELECT RAISE(ABORT, 'idempotency records are immutable'); END;
CREATE TRIGGER idempotency_no_delete BEFORE DELETE ON idempotency_records BEGIN SELECT RAISE(ABORT, 'idempotency records are immutable'); END;

CREATE TABLE payment_attempts (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('ORIGINAL', 'REPAYMENT')),
  state TEXT NOT NULL CHECK (state IN (
    'CREATED', 'PREPARED', 'SIGNING_REQUESTED', 'SUBMITTED', 'OBSERVED', 'VERIFIED',
    'UNKNOWN', 'REJECTED_NO_SEND', 'FAILED'
  )),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  payer TEXT NOT NULL CHECK (length(payer) = 42 AND payer GLOB '0x*' AND substr(payer, 3) NOT GLOB '*[^0-9a-f]*'),
  payee TEXT NOT NULL CHECK (length(payee) = 42 AND payee GLOB '0x*' AND substr(payee, 3) NOT GLOB '*[^0-9a-f]*'),
  chain_id INTEGER NOT NULL CHECK (chain_id > 0),
  token TEXT NOT NULL CHECK (length(token) = 42 AND token GLOB '0x*' AND substr(token, 3) NOT GLOB '*[^0-9a-f]*'),
  amount_base_units TEXT NOT NULL CHECK (amount_base_units GLOB '[1-9]*' AND amount_base_units NOT GLOB '*[^0-9]*'),
  intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256) = 64 AND intent_sha256 NOT GLOB '*[^0-9a-f]*'),
  deployment_id TEXT NOT NULL CHECK (length(deployment_id) > 0),
  cart_mandate_id TEXT UNIQUE,
  payment_request_id TEXT UNIQUE,
  flow_id TEXT,
  request_id TEXT,
  cart_sha256 TEXT CHECK (cart_sha256 IS NULL OR (length(cart_sha256) = 64 AND cart_sha256 NOT GLOB '*[^0-9a-f]*')),
  payment_mandate_sha256 TEXT CHECK (
    payment_mandate_sha256 IS NULL OR (length(payment_mandate_sha256) = 64 AND payment_mandate_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  tx_hash TEXT CHECK (tx_hash IS NULL OR (length(tx_hash) = 66 AND tx_hash GLOB '0x*' AND substr(tx_hash, 3) NOT GLOB '*[^0-9a-f]*')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- At most one live attempt per purpose and operation. A new attempt needs the previous one to be definitively closed.
CREATE UNIQUE INDEX payment_attempts_one_live_original ON payment_attempts (operation_id)
  WHERE purpose = 'ORIGINAL' AND state NOT IN ('REJECTED_NO_SEND', 'FAILED');
CREATE UNIQUE INDEX payment_attempts_one_live_repayment ON payment_attempts (operation_id)
  WHERE purpose = 'REPAYMENT' AND state NOT IN ('REJECTED_NO_SEND', 'FAILED');

CREATE TRIGGER payment_attempts_fixed_intent BEFORE UPDATE ON payment_attempts
  WHEN NEW.id IS NOT OLD.id OR NEW.operation_id IS NOT OLD.operation_id OR NEW.purpose IS NOT OLD.purpose
    OR NEW.payer IS NOT OLD.payer OR NEW.payee IS NOT OLD.payee OR NEW.chain_id IS NOT OLD.chain_id
    OR NEW.token IS NOT OLD.token OR NEW.amount_base_units IS NOT OLD.amount_base_units
    OR NEW.intent_sha256 IS NOT OLD.intent_sha256 OR NEW.deployment_id IS NOT OLD.deployment_id
    OR NEW.created_at IS NOT OLD.created_at
  BEGIN SELECT RAISE(ABORT, 'payment attempt intent is immutable'); END;

CREATE TRIGGER payment_attempts_write_once_refs BEFORE UPDATE ON payment_attempts
  WHEN (OLD.cart_mandate_id IS NOT NULL AND NEW.cart_mandate_id IS NOT OLD.cart_mandate_id)
    OR (OLD.payment_request_id IS NOT NULL AND NEW.payment_request_id IS NOT OLD.payment_request_id)
    OR (OLD.flow_id IS NOT NULL AND NEW.flow_id IS NOT OLD.flow_id)
    OR (OLD.request_id IS NOT NULL AND NEW.request_id IS NOT OLD.request_id)
    OR (OLD.cart_sha256 IS NOT NULL AND NEW.cart_sha256 IS NOT OLD.cart_sha256)
    OR (OLD.payment_mandate_sha256 IS NOT NULL AND NEW.payment_mandate_sha256 IS NOT OLD.payment_mandate_sha256)
    OR (OLD.tx_hash IS NOT NULL AND NEW.tx_hash IS NOT OLD.tx_hash)
  BEGIN SELECT RAISE(ABORT, 'payment references cannot change once recorded'); END;

CREATE TRIGGER payment_attempts_revision BEFORE UPDATE ON payment_attempts
  WHEN NEW.revision IS NOT OLD.revision + 1
  BEGIN SELECT RAISE(ABORT, 'payment attempt revision must advance by one'); END;

CREATE TRIGGER payment_attempts_no_delete BEFORE DELETE ON payment_attempts BEGIN SELECT RAISE(ABORT, 'payment attempts are permanent'); END;

CREATE TABLE service_jobs (
  operation_id TEXT PRIMARY KEY REFERENCES operations(id),
  state TEXT NOT NULL CHECK (state IN ('NOT_STARTED', 'INVOKED', 'RUNNING', 'COMPLETED', 'FAILED', 'UNKNOWN')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  external_job_id TEXT UNIQUE,
  artifact_sha256 TEXT CHECK (artifact_sha256 IS NULL OR (length(artifact_sha256) = 64 AND artifact_sha256 NOT GLOB '*[^0-9a-f]*')),
  invoked_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER service_jobs_fixed_operation BEFORE UPDATE ON service_jobs
  WHEN NEW.operation_id IS NOT OLD.operation_id
    OR (OLD.external_job_id IS NOT NULL AND NEW.external_job_id IS NOT OLD.external_job_id)
    OR (OLD.artifact_sha256 IS NOT NULL AND NEW.artifact_sha256 IS NOT OLD.artifact_sha256)
    OR (OLD.invoked_at IS NOT NULL AND NEW.invoked_at IS NOT OLD.invoked_at)
  BEGIN SELECT RAISE(ABORT, 'service job identity and recorded results are immutable'); END;

CREATE TRIGGER service_jobs_revision BEFORE UPDATE ON service_jobs
  WHEN NEW.revision IS NOT OLD.revision + 1
  BEGIN SELECT RAISE(ABORT, 'service job revision must advance by one'); END;

CREATE TRIGGER service_jobs_no_delete BEFORE DELETE ON service_jobs BEGIN SELECT RAISE(ABORT, 'service jobs are permanent'); END;

CREATE TABLE evidence_items (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id),
  source TEXT NOT NULL CHECK (source IN (
    'gateway-record', 'edge-log', 'worker-log', 'artifact-store', 'service-status', 'buyer-claim', 'policy', 'chain'
  )),
  provenance TEXT NOT NULL CHECK (provenance IN ('AUTHENTICATED_SERVICE', 'GATEWAY', 'CHAIN', 'CLAIM', 'POLICY')),
  source_event_id TEXT NOT NULL CHECK (length(source_event_id) > 0),
  observed_at TEXT,
  received_at TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  content_path TEXT NOT NULL CHECK (length(content_path) > 0),
  UNIQUE (operation_id, source, source_event_id)
) STRICT;

CREATE TRIGGER evidence_items_no_update BEFORE UPDATE ON evidence_items BEGIN SELECT RAISE(ABORT, 'evidence is immutable; submit a new item'); END;
CREATE TRIGGER evidence_items_no_delete BEFORE DELETE ON evidence_items BEGIN SELECT RAISE(ABORT, 'evidence is immutable'); END;

CREATE TABLE cases (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),
  status TEXT NOT NULL CHECK (status IN (
    'OPEN', 'ASSESSING', 'REVIEW_REQUIRED', 'UNRESOLVED', 'ACTION_PREPARED', 'RESERVED',
    'EXECUTION_REQUESTED', 'VERIFIED', 'DELIVERY_ACKED', 'RECORD_PENDING', 'RECOVERED', 'REPAID', 'QUARANTINED'
  )),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  evidence_sha256 TEXT CHECK (evidence_sha256 IS NULL OR (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*')),
  registry_case_key TEXT UNIQUE CHECK (
    registry_case_key IS NULL OR (length(registry_case_key) = 66 AND registry_case_key GLOB '0x*' AND substr(registry_case_key, 3) NOT GLOB '*[^0-9a-f]*')
  ),
  eligibility_rules_sha256 TEXT CHECK (
    eligibility_rules_sha256 IS NULL OR (length(eligibility_rules_sha256) = 64 AND eligibility_rules_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  auto_eligible INTEGER NOT NULL DEFAULT 0 CHECK (auto_eligible IN (0, 1)),
  opened_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER cases_fixed_identity BEFORE UPDATE ON cases
  WHEN NEW.id IS NOT OLD.id OR NEW.operation_id IS NOT OLD.operation_id OR NEW.opened_by IS NOT OLD.opened_by
    OR NEW.created_at IS NOT OLD.created_at
    OR (OLD.registry_case_key IS NOT NULL AND NEW.registry_case_key IS NOT OLD.registry_case_key)
  BEGIN SELECT RAISE(ABORT, 'case identity is immutable'); END;

CREATE TRIGGER cases_revision BEFORE UPDATE ON cases
  WHEN NEW.revision IS NOT OLD.revision + 1
  BEGIN SELECT RAISE(ABORT, 'case revision must advance by one'); END;

CREATE TRIGGER cases_no_delete BEFORE DELETE ON cases BEGIN SELECT RAISE(ABORT, 'cases are permanent'); END;

CREATE TABLE assessments (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  case_revision INTEGER NOT NULL CHECK (case_revision >= 0),
  policy_sha256 TEXT NOT NULL CHECK (length(policy_sha256) = 64 AND policy_sha256 NOT GLOB '*[^0-9a-f]*'),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  recommendation TEXT CHECK (recommendation IS NULL OR recommendation IN ('RETRIEVE', 'REPAY', 'ESCALATE')),
  validation_status TEXT NOT NULL CHECK (validation_status IN ('VALID', 'INVALID', 'FAILED')),
  findings_json TEXT NOT NULL CHECK (json_valid(findings_json)),
  created_at TEXT NOT NULL,
  UNIQUE (case_id, case_revision)
) STRICT;

CREATE TRIGGER assessments_no_update BEFORE UPDATE ON assessments BEGIN SELECT RAISE(ABORT, 'assessments are immutable'); END;
CREATE TRIGGER assessments_no_delete BEFORE DELETE ON assessments BEGIN SELECT RAISE(ABORT, 'assessments are immutable'); END;

CREATE TABLE recovery_actions (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL UNIQUE REFERENCES cases(id),
  action TEXT NOT NULL CHECK (action IN ('RETRIEVE', 'REPAY')),
  authorization_mode TEXT CHECK (authorization_mode IS NULL OR authorization_mode IN ('PER_CASE', 'STANDING_POLICY')),
  authorization_id TEXT,
  authorization_version INTEGER CHECK (authorization_version IS NULL OR authorization_version > 0),
  action_sha256 TEXT NOT NULL CHECK (length(action_sha256) = 64 AND action_sha256 NOT GLOB '*[^0-9a-f]*'),
  evidence_sha256 TEXT NOT NULL CHECK (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  amount_base_units TEXT CHECK (amount_base_units IS NULL OR (amount_base_units GLOB '[1-9]*' AND amount_base_units NOT GLOB '*[^0-9]*')),
  payer TEXT CHECK (payer IS NULL OR (length(payer) = 42 AND payer GLOB '0x*' AND substr(payer, 3) NOT GLOB '*[^0-9a-f]*')),
  payee TEXT CHECK (payee IS NULL OR (length(payee) = 42 AND payee GLOB '0x*' AND substr(payee, 3) NOT GLOB '*[^0-9a-f]*')),
  chain_id INTEGER CHECK (chain_id IS NULL OR chain_id > 0),
  token TEXT CHECK (token IS NULL OR (length(token) = 42 AND token GLOB '0x*' AND substr(token, 3) NOT GLOB '*[^0-9a-f]*')),
  deadline TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'PREPARED', 'RESERVED', 'EXECUTION_REQUESTED', 'VERIFIED', 'DELIVERY_ACKED', 'RECORD_PENDING', 'COMPLETED', 'STRANDED'
  )),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  approval_tx TEXT CHECK (approval_tx IS NULL OR (length(approval_tx) = 66 AND approval_tx GLOB '0x*' AND substr(approval_tx, 3) NOT GLOB '*[^0-9a-f]*')),
  policy_tx TEXT CHECK (policy_tx IS NULL OR (length(policy_tx) = 66 AND policy_tx GLOB '0x*' AND substr(policy_tx, 3) NOT GLOB '*[^0-9a-f]*')),
  registry_tx TEXT CHECK (registry_tx IS NULL OR (length(registry_tx) = 66 AND registry_tx GLOB '0x*' AND substr(registry_tx, 3) NOT GLOB '*[^0-9a-f]*')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (action = 'REPAY' AND authorization_mode IS NOT NULL AND amount_base_units IS NOT NULL
      AND payer IS NOT NULL AND payee IS NOT NULL AND chain_id IS NOT NULL AND token IS NOT NULL AND payer <> payee)
    OR (action = 'RETRIEVE' AND authorization_mode IS NULL AND amount_base_units IS NULL)
  ),
  CHECK ((authorization_mode = 'STANDING_POLICY') = (authorization_id IS NOT NULL AND authorization_version IS NOT NULL))
) STRICT;

CREATE TRIGGER recovery_actions_fixed_intent BEFORE UPDATE ON recovery_actions
  WHEN NEW.id IS NOT OLD.id OR NEW.case_id IS NOT OLD.case_id OR NEW.action IS NOT OLD.action
    OR NEW.authorization_mode IS NOT OLD.authorization_mode OR NEW.authorization_id IS NOT OLD.authorization_id
    OR NEW.authorization_version IS NOT OLD.authorization_version OR NEW.action_sha256 IS NOT OLD.action_sha256
    OR NEW.evidence_sha256 IS NOT OLD.evidence_sha256 OR NEW.amount_base_units IS NOT OLD.amount_base_units
    OR NEW.payer IS NOT OLD.payer OR NEW.payee IS NOT OLD.payee OR NEW.chain_id IS NOT OLD.chain_id
    OR NEW.token IS NOT OLD.token OR NEW.deadline IS NOT OLD.deadline OR NEW.created_at IS NOT OLD.created_at
    OR (OLD.approval_tx IS NOT NULL AND NEW.approval_tx IS NOT OLD.approval_tx)
    OR (OLD.policy_tx IS NOT NULL AND NEW.policy_tx IS NOT OLD.policy_tx)
    OR (OLD.registry_tx IS NOT NULL AND NEW.registry_tx IS NOT OLD.registry_tx)
  BEGIN SELECT RAISE(ABORT, 'recovery action terms are immutable'); END;

CREATE TRIGGER recovery_actions_revision BEFORE UPDATE ON recovery_actions
  WHEN NEW.revision IS NOT OLD.revision + 1
  BEGIN SELECT RAISE(ABORT, 'recovery action revision must advance by one'); END;

CREATE TRIGGER recovery_actions_no_delete BEFORE DELETE ON recovery_actions BEGIN SELECT RAISE(ABORT, 'recovery actions are permanent'); END;

CREATE TABLE delivery_acks (
  operation_id TEXT PRIMARY KEY REFERENCES operations(id),
  buyer TEXT NOT NULL CHECK (length(buyer) = 42 AND buyer GLOB '0x*' AND substr(buyer, 3) NOT GLOB '*[^0-9a-f]*'),
  artifact_sha256 TEXT NOT NULL CHECK (length(artifact_sha256) = 64 AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'),
  acknowledged_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER delivery_acks_no_update BEFORE UPDATE ON delivery_acks BEGIN SELECT RAISE(ABORT, 'delivery acknowledgements are immutable'); END;
CREATE TRIGGER delivery_acks_no_delete BEFORE DELETE ON delivery_acks BEGIN SELECT RAISE(ABORT, 'delivery acknowledgements are immutable'); END;

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  prior_revision INTEGER,
  new_revision INTEGER,
  actor TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX events_by_entity ON events (entity_type, entity_id, seq);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

-- A settlement proof (transaction hash) can fund exactly one binding within a deployment and chain,
-- whatever its type, so an original payment can never be reused as a repayment or for another operation.
CREATE TABLE proof_allocations (
  deployment_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL CHECK (chain_id > 0),
  proof_id TEXT NOT NULL CHECK (length(proof_id) = 66 AND proof_id GLOB '0x*' AND substr(proof_id, 3) NOT GLOB '*[^0-9a-f]*'),
  proof_type TEXT NOT NULL CHECK (proof_type IN ('ORIGINAL_PAYMENT', 'REPAYMENT')),
  operation_id TEXT NOT NULL REFERENCES operations(id),
  action_id TEXT REFERENCES recovery_actions(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, chain_id, proof_id),
  CHECK ((proof_type = 'REPAYMENT') = (action_id IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX proof_allocations_one_original ON proof_allocations (operation_id) WHERE proof_type = 'ORIGINAL_PAYMENT';
CREATE UNIQUE INDEX proof_allocations_one_per_action ON proof_allocations (action_id) WHERE action_id IS NOT NULL;
CREATE TRIGGER proof_allocations_no_update BEFORE UPDATE ON proof_allocations BEGIN SELECT RAISE(ABORT, 'proof allocations are immutable'); END;
CREATE TRIGGER proof_allocations_no_delete BEFORE DELETE ON proof_allocations BEGIN SELECT RAISE(ABORT, 'proof allocations are immutable'); END;

-- One-use permit per payment attempt. The only permitted change is ISSUED -> CONSUMED.
CREATE TABLE execution_permits (
  attempt_id TEXT PRIMARY KEY REFERENCES payment_attempts(id),
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  state TEXT NOT NULL CHECK (state IN ('ISSUED', 'CONSUMED')),
  issued_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK ((state = 'CONSUMED') = (consumed_at IS NOT NULL))
) STRICT;

CREATE TRIGGER execution_permits_consume_once BEFORE UPDATE ON execution_permits
  WHEN NOT (OLD.state = 'ISSUED' AND NEW.state = 'CONSUMED' AND NEW.attempt_id IS OLD.attempt_id
    AND NEW.fencing_token IS OLD.fencing_token AND NEW.issued_at IS OLD.issued_at)
  BEGIN SELECT RAISE(ABORT, 'an execution permit can only be consumed once'); END;

CREATE TRIGGER execution_permits_no_delete BEFORE DELETE ON execution_permits BEGIN SELECT RAISE(ABORT, 'execution permits are permanent'); END;
