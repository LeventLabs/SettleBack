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

**Planning stage.** This repository currently contains the project overview; application code, setup instructions, tests, and deployment references will follow as they are implemented.

The MVP targets:

- A recoverable-result scenario.
- An explicitly approved repayment scenario.
- An unresolved case that safely stops further spending.
- Cited evidence analysis and an inspectable recovery record.

Live HSP access and integration remain unverified for SettleBack. No deployed contract, completed payment flow, or production readiness is claimed.

## Team

Developed by **LeventLabs** for the **HSK Chain Horizon Hackathon Mumbai — Track 2: Agent Payments & A2A Settlement**.

Project domain: **settleback.xyz**.
