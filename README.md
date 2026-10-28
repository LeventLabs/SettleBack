# SettleBack

**Recovery for paid agent jobs.**

An agent pays for a service. The request times out. Did the job fail, did the response disappear, or is the payment still being confirmed?

SettleBack is being built to reconcile payment, execution, and delivery evidence, then coordinate a safe next step.

## The recovery workflow

| What happened | Intended response |
|---|---|
| The result exists, but the response was lost | Retrieve the existing result without starting another paid job. |
| Payment is verified and the service terms support repayment | Obtain the seller's approval, make a separate repayment, and verify settlement. |
| Evidence or payment status is uncertain | Keep the case open and stop automatic new spending within the application. |

The first workflow covers one buyer agent, one seller, and an asynchronous data-extraction job. The same problem can occur in research, document processing, and other paid AI services.

## Evidence before action

SettleBack separates three questions: **Was it paid? Was it executed? Was it delivered?**

Deterministic checks handle payment identities, amounts, permissions, and duplicate actions. Claude is intended to interpret conflicting records and service terms, cite supporting evidence, and identify what remains unknown. Model output does not authorize a transfer.

The operator sees a case timeline, the relevant evidence, a recommended action, and its approval status.

## Built around HSP and HSK Chain

The planned integration uses HashKey Settlement Protocol (HSP) to verify the original payment and any seller-authorized repayment. An HSK Chain recovery registry will record action reservations and outcomes that the application consumes.

A repayment is a new seller-funded transfer, not a reversal. Payment evidence does not prove service quality, and the registry does not control transfers made outside SettleBack.

## Current status

**Early development.** The domain rules, payment and registry simulators, the agent-to-agent payment flow against the simulated gateway, the recovery registry contract with its Foundry tests, the instrumented demo service, evidence-backed cases with a rules-only assessment, and a cited Claude assessment for the cases the rules cannot settle are in place and tested locally. Recovery execution, the case interface, live HSP integration, and deployment references will follow as they are implemented.

The MVP targets:

- A recoverable-result scenario.
- An explicitly approved repayment scenario.
- An unresolved case that safely stops further spending.
- Cited evidence analysis and an inspectable recovery record.

Live HSP access and integration remain unverified for SettleBack. No deployed contract, completed payment flow, or production readiness is claimed.

## Development

Requirements: Node.js 24.15 or later (see `.nvmrc`), npm 11, and [Foundry](https://getfoundry.sh/) for the contracts.

```bash
git clone --recurse-submodules https://github.com/LeventLabs/SettleBack.git
# or, in an existing clone: git submodule update --init

npm install
cp config/settleback.example.env .env   # optional; defaults are local and safe
# add ANTHROPIC_API_KEY to .env to enable assessments; .env is ignored by git

npm run typecheck    # TypeScript across all workspaces
npm test             # unit tests
npm run build        # typecheck, web production build, contract build
forge test --root contracts   # contract unit, fuzz, and invariant tests

npm run dev:server   # API on http://127.0.0.1:8787
npm run dev:web      # web shell on http://127.0.0.1:5173 (proxies /api to the server)
```

The server runs its TypeScript sources directly with Node's built-in type stripping, so there is no server build step. SQLite and request signing will use Node's built-in `node:sqlite` and `node:crypto`.

| Path | Contents |
|---|---|
| `apps/server` | Fastify API, SQLite storage, and the Claude assessment client |
| `apps/web` | React + Vite case workspace |
| `packages/domain` | Shared domain types, state machines with per-transition actor rules, deterministic recovery checks, evidence validation and redaction, cited spans, the rules-only assessment, validation and decision rules for the model assessment, canonical JSON and SHA-256 helpers |
| `packages/adapters` | Payment and registry interfaces, webhook signature verification, settlement verification against the chain, and deterministic simulators with fault injection |
| `packages/demo-service` | The paid extraction job: an edge proxy, a job service, a worker, and an artifact store, each keeping its own records, run in simulated time with injectable faults |
| `fixtures` | Synthetic service terms with their machine-readable refund rules, a source document with its expected result, labeled recovery cases, and signing-policy cases |
| `migrations` | SQLite schema; applied in order at startup and refused if an applied file changes |
| `evaluation` | Recorded live runs of the Claude assessment over the fixture cases, with a generated report |
| `contracts` | The recovery registry and the deployment marker, with Foundry unit, fuzz, and invariant tests |
| `config` | Non-secret configuration examples |

The demo service performs the purchased work for real: it extracts structured items from the source document and stores the result by its SHA-256 digest. The edge writes nginx-style access lines, the worker writes its own application log under its own job alias and clock, and the job service keeps a structured status whose every change goes through the job state machine. A job starts at most once per operation and is never restarted after an uncertain run. Faults are injected as component behavior (a dropped response, a terminal failure, an edge timeout while the worker finishes late, a lost status update, a corrupted artifact), so disagreeing records come from components that actually disagree.

All fixture data is synthetic. The recovery cases describe what each component must record and the expected outcome; the evidence itself is produced by running the demo service with injected faults, not written by hand. The only exception is buyer claims, which are labeled as hand-written.

Each environment uses its own SQLite database (default `data/settleback-<environment>.db`, ignored by git). A database records the environment it was created for and cannot be opened under another one. The schema enforces the core money rules itself: amounts are positive integer strings in token base units, recorded payment terms and transaction hashes cannot change, each settlement proof can be bound only once, and every update to a mutable record advances its revision by exactly one.

Each operation has at most one case, however many times or by whom it is opened; only the operation's buyer or an operator can open it. Evidence is recorded as immutable items, and its trust level comes from who submitted it, never from what it says: records from the configured service identity are authenticated service records (still the seller's own assertions), gateway and chain records come from server-side reconciliation, and anything a person types or pastes is a claim, even when it looks like a worker log. The bound service terms are always the first item, so their clauses can be cited like any other record. Only plain text and JSON are accepted: at most 20 items, 256 KiB each, and 1 MiB per case, with claims limited to half of each budget so they cannot crowd out service records. Control characters and malformed text are refused, HTML and scripts are stored as inert text, and credentials (private keys, bearer tokens, cookies, API keys, and secret-named fields) are redacted before anything is stored or shown; the digest of the submitted bytes is kept alongside the digest of the stored text. Redaction is pattern-based, not a guarantee. Resubmitting an event with different content is refused and logged rather than overwriting it, and every new item advances the case's evidence revision, which sends a case that is still under review back for reassessment and makes any earlier approval stale.

A rules-only assessment runs before any model is involved. It reads only structured records from trusted sources (the payment attempt, the job service's status, the artifact store, and gateway records) and never free-text logs or claims. It resolves straightforward cases: a completed artifact that matches its digest and its job can be retrieved, a terminal failure before any artifact is repayable under delivery-based terms, started compute stays billable under compute-billable terms, a verified payment with no job can be fulfilled once, and a payment that never produced a transaction needs no action. Contradicting records, such as an artifact whose bytes no longer match, are escalated. When the records do not settle the case, for example when the job's last structured status is still running while its own log says it finished, the rules abstain and say what evidence is missing; a missing record is never read as proof that a job did not run. Every finding cites exact byte ranges of the stored evidence, and the citations are checked the same way any later model citation will be. The fixture cases run end to end against this path: their evidence comes from running the demo service and the gateway simulator, not from hand-written logs.

When the rules abstain, the seller or an operator can request a Claude assessment of that evidence revision. Claude (pinned to `claude-opus-5-5` by default, structured output, no tools) reads the free-text records and the terms and returns findings with verbatim quotes, a suggested action, and the evidence that is missing. Evidence is passed as data inside delimiters the evidence cannot close, and nothing the model returns is trusted as is. The server finds every quote in the item it names and stores the byte range it found, rejects the whole response if any quote is absent or a claim is presented as proof, and records a refusal, a truncated or malformed response, a timeout, or an answer from a different model as a failed assessment that leaves the case with a person. There is no automatic retry and no fallback model; a person can retry a failed attempt, and a successful one is reused for its revision. A suggested repayment is never eligible on the model's word. A suggested retrieval becomes eligible only after code looks up the artifact digest the model quoted from an authenticated record and confirms with the artifact store and the job service that the artifact exists unaltered and was written by this operation's job; a log line naming a digest is a lead, not proof. Every request and result is stored append-only with its prompt digest, model, origin (live, recorded, or scripted test input), raw response, token usage, and duration.

The [evaluation](evaluation/README.md) runs the pinned model over every fixture case: three times through the product path where the rules abstain, once as a probe where they resolve. In the recorded runs, the hidden completion became retrievable in every run only after code verified the artifact the model cited, the same log line without a stored artifact never led to retrieval, and no response failed validation. The raw responses are committed, and a test replays each one through the same validation and decision code. The cases are synthetic and few; this checks specific behaviors and is not an accuracy estimate.

State changes for payments, jobs, cases, and recovery actions go through explicit state machines. Each transition lists who may make it and whether it must cite recorded evidence. The language model is not an actor on any transition, only server-side reconciliation can mark a payment verified, and an unknown payment can never be released for a fresh attempt automatically.

The local environment runs against simulators for the HSP gateway, the chain, and the recovery registry. They follow the gateway's documented statuses and webhook retries and can inject lost responses, failed broadcasts, reorganizations, delayed finality, wrong receipts, missing transactions, outages, and unreachable webhooks. Everything they produce is labeled simulated and refused outside the local environment. Every API response carries `x-settleback-mode` and `x-settleback-network` headers, and the interface shows when it is a simulation. A payment counts as settled only when the gateway record and the on-chain transfer both match the expected payer, payee, token, chain, and principal amount.

Payments follow the HSP Merchant gateway's agent-to-agent pattern as its public documentation describes it. The receiving agent builds a Cart Mandate for the job's fixed terms (one x402 option on the operation's chain and token, paid to the seller, for exactly the job's USD price), hashes the canonical JSON of its contents, signs that hash in an ES256K merchant JWT, and creates the order with an HMAC-signed request. The attempt and its gateway identifiers are stored before the order is created, so a lost response or a restart is recovered by querying the same identifiers and never opens a second order. Before anything is signed, the buyer's Payment Agent recomputes the cart hash over the contents it received, verifies the JWT against the merchant key it pinned beforehand (algorithm, audience, issuer, expiry), checks the cart's expiry and the gateway's amount rules, and requires the payee, chain, token, and USD amount due to match the operation, the payee to be on its allowlist, and the price plus the maximum fee to fit its per-payment and daily limits. The Payment Mandate is built only from that validated cart, is signed once per attempt, and after a lost submission the outcome is read back from the gateway instead of signing again. The gateway simulator applies the same request-signature, nonce, JWT, cart-hash, amount, expiry, and one-time-cart checks, and accepts a mandate only when it is bound to the order's cart hash and amount due. The Payment Mandate format and its submission endpoint are not publicly documented yet, so that step is a labeled simulation; live completion waits for the gateway's specification and access. A gateway-reported USD rate other than the pinned stablecoin rate blocks verification.

The `RecoveryRegistry` contract holds no tokens, makes no external calls, and has no owner, upgrade path, case cancellation, budget reset, or reservation release. A verifier address fixed at deployment registers each case with its terms (buyer, seller, token, principal, the original payment's chain and transaction, the service-terms and eligibility-rules hashes, the action and evidence digests, the action kind, and a deadline) and later records the single outcome. Every payment reference is qualified by its chain and can be bound only once, so an original payment can never be presented as a repayment or reused for another case. A repayment is reserved either by the seller for that one case or by the seller's delegate under a standing policy the seller activated. A policy is an immutable version bound to the delegate, signer, token, payment chain, service-terms hash, eligibility-rules hash, per-case and daily limits, and a validity window; only the seller can activate, pause, resume, revoke, or replace it, and one version is active per seller, chain, and token. Exposure belongs to that scope, not to a version: every reservation, including explicit per-case ones, stays outstanding across days and versions until the verifier records the repayment, which moves it to the day's booked total in one step. An automatic reservation must fit `booked today + outstanding + amount <= daily limit` and the per-case limit, so pausing, revoking, replacing, or waiting never frees uncertain budget. Retrieval of an existing result is reserved and completed by the verifier and involves no money. The verifier is trusted to record truthfully; it cannot reserve a repayment, act for a seller, or change a policy. A separate `SettleBackDeploymentMarker` records, on another network, the commit and the chain and address of the registry deployment it points to; it is a pointer, not the registry.

`SETTLEBACK_ENV` selects `local`, `testnet`, `mixed` (testnet payments with the mainnet registry), or `mainnet`. Payment writes are disabled by default. Live environments refuse to enable them until their chain, token, gateway, and finality settings exist.

## Team

Developed by **LeventLabs** for the **HSK Chain Horizon Hackathon Mumbai — Track 2: Agent Payments & A2A Settlement**.

Project domain: **settleback.xyz**.
