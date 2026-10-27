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

**Early development.** The application skeleton (server, web shell, shared domain package, and contract workspace) is in place. Recovery features, tests for them, and deployment references will follow as they are implemented.

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

npm run typecheck    # TypeScript across all workspaces
npm test             # unit tests
npm run build        # typecheck, web production build, contract build

npm run dev:server   # API on http://127.0.0.1:8787
npm run dev:web      # web shell on http://127.0.0.1:5173 (proxies /api to the server)
```

The server runs its TypeScript sources directly with Node's built-in type stripping, so there is no server build step. SQLite and request signing will use Node's built-in `node:sqlite` and `node:crypto`.

| Path | Contents |
|---|---|
| `apps/server` | Fastify API |
| `apps/web` | React + Vite case workspace |
| `packages/domain` | Shared domain types, state machines with per-transition actor rules, deterministic recovery checks, canonical JSON and SHA-256 helpers |
| `packages/adapters` | Payment and registry interfaces, webhook signature verification, settlement verification against the chain, and deterministic simulators with fault injection |
| `packages/demo-service` | The paid extraction job: an edge proxy, a job service, a worker, and an artifact store, each keeping its own records, run in simulated time with injectable faults |
| `fixtures` | Synthetic service terms, a source document with its expected result, labeled recovery cases, and signing-policy cases |
| `migrations` | SQLite schema; applied in order at startup and refused if an applied file changes |
| `contracts` | Foundry workspace for the recovery registry |
| `config` | Non-secret configuration examples |

The demo service performs the purchased work for real: it extracts structured items from the source document and stores the result by its SHA-256 digest. The edge writes nginx-style access lines, the worker writes its own application log under its own job alias and clock, and the job service keeps a structured status whose every change goes through the job state machine. A job starts at most once per operation and is never restarted after an uncertain run. Faults are injected as component behavior (a dropped response, a terminal failure, an edge timeout while the worker finishes late, a lost status update, a corrupted artifact), so disagreeing records come from components that actually disagree.

All fixture data is synthetic. The recovery cases describe what each component must record and the expected outcome; the evidence itself is produced by running the demo service with injected faults, not written by hand. The only exception is buyer claims, which are labeled as hand-written.

Each environment uses its own SQLite database (default `data/settleback-<environment>.db`, ignored by git). A database records the environment it was created for and cannot be opened under another one. The schema enforces the core money rules itself: amounts are positive integer strings in token base units, recorded payment terms and transaction hashes cannot change, each settlement proof can be bound only once, and every update to a mutable record advances its revision by exactly one.

State changes for payments, jobs, cases, and recovery actions go through explicit state machines. Each transition lists who may make it and whether it must cite recorded evidence. The language model is not an actor on any transition, only server-side reconciliation can mark a payment verified, and an unknown payment can never be released for a fresh attempt automatically.

The local environment runs against simulators for the HSP gateway, the chain, and the recovery registry. They follow the gateway's documented statuses and webhook retries and can inject lost responses, failed broadcasts, reorganizations, delayed finality, wrong receipts, missing transactions, outages, and unreachable webhooks. Everything they produce is labeled simulated and refused outside the local environment. Every API response carries `x-settleback-mode` and `x-settleback-network` headers, and the interface shows when it is a simulation. A payment counts as settled only when the gateway record and the on-chain transfer both match the expected payer, payee, token, chain, and principal amount.

`SETTLEBACK_ENV` selects `local`, `testnet`, `mixed` (testnet payments with the mainnet registry), or `mainnet`. Payment writes are disabled by default. Live environments refuse to enable them until their chain, token, gateway, and finality settings exist.

## Team

Developed by **LeventLabs** for the **HSK Chain Horizon Hackathon Mumbai — Track 2: Agent Payments & A2A Settlement**.

Project domain: **settleback.xyz**.
