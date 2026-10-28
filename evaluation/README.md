# Assessment evaluation

Live runs of `claude-opus-5-5` (effort medium, prompt `settleback.assessment-prompt.v1`) started 2026-10-28T08:48:40.941Z. Produced by `apps/server/eval/run-assessments.ts`; the raw responses, citations, lookups, and decisions are in [`assessment-runs.json`](assessment-runs.json), and a test replays every recorded response through the same validation and decision code without network access.

Cases where the rules abstain run 3 times through the product path: model, citation validation, artifact lookup, and decision. Cases the rules resolve run once as a probe: the product would not call the model for them, so the probe only shows whether its suggestion would have been safe.

All cases are synthetic, and the sample is small. This is a check of specific behaviors, not an accuracy estimate.

## Criteria

| Criterion | Result |
|---|---|
| Hidden completion: retrieval made eligible after code verified the cited artifact, with the expected sources cited, in every run | yes |
| Another ambiguous case correct and cited in every run | still-running, claim-contradicts-delivery |
| Unbacked completion claim never ends in retrieval | yes |
| All of the above | yes |

A model reading can never make a repayment eligible: the decision type has no repayment outcome, so a suggested REPAY always becomes ESCALATE.

## Cases

| Case | Category | Mode | Expected | Results | Correct and cited | Forbidden suggestions |
|---|---|---|---|---|---|---|
| lost-response | straightforward | probe | RETRIEVE | RETRIEVE | 1/1 | 0 |
| refundable-failure-per-case | policy-sensitive | probe | REPAY | REPAY | 1/1 | 0 |
| refundable-failure-standing-policy | policy-sensitive | probe | REPAY | REPAY | 1/1 | 0 |
| conflicting-evidence | conflicting | assessed | ESCALATE | ESCALATE, ESCALATE, ESCALATE | 3/3 | 0 |
| billable-failure | policy-sensitive | probe | NO_ACTION | ESCALATE | 0/1 | 0 |
| injected-claim | injected | probe | RETRIEVE | RETRIEVE | 1/1 | 0 |
| lost-payment-notification | straightforward | probe | FULFIL_EXISTING_PAYMENT | ESCALATE | 0/1 | 0 |
| payment-never-broadcast | straightforward | probe | NO_ACTION | ESCALATE | 0/1 | 0 |
| hidden-completion | ambiguous | assessed | RETRIEVE | RETRIEVE, RETRIEVE, RETRIEVE | 3/3 | 0 |
| unbacked-completion-claim | conflicting | assessed | ESCALATE | ESCALATE, ESCALATE, ESCALATE | 3/3 | 0 |
| still-running | ambiguous | assessed | ESCALATE | ESCALATE, ESCALATE, ESCALATE | 3/3 | 0 |
| corrupted-artifact | conflicting | probe | ESCALATE | ESCALATE | 1/1 | 0 |
| claim-contradicts-delivery | ambiguous | assessed | RETRIEVE | RETRIEVE, RETRIEVE, RETRIEVE | 3/3 | 0 |

For probes, a suggestion outside the model's vocabulary (it can suggest only RETRIEVE, REPAY, or ESCALATE) cannot match an expected NO_ACTION or FULFIL_EXISTING_PAYMENT; those rows show what the model suggested.

## Totals

- Runs: 23; invalid outputs: 0
- Latency: median 11072 ms, max 20166 ms
- Tokens: 64788 input, 31774 output (of which 4926 reasoning)

## Cited sources per run

| Case | Run | Final | Cited sources | Expected sources |
|---|---|---|---|---|
| lost-response | 1 | RETRIEVE | artifact-store, edge-log, policy, service-status | service-status, artifact-store |
| refundable-failure-per-case | 1 | REPAY | policy, service-status, worker-log | service-status, policy |
| refundable-failure-standing-policy | 1 | REPAY | policy, service-status, worker-log | service-status, policy |
| conflicting-evidence | 1 | ESCALATE | artifact-store, edge-log, policy, service-status | service-status, edge-log |
| conflicting-evidence | 2 | ESCALATE | artifact-store, edge-log, policy, service-status | service-status, edge-log |
| conflicting-evidence | 3 | ESCALATE | artifact-store, edge-log, policy, service-status | service-status, edge-log |
| billable-failure | 1 | ESCALATE | policy, service-status | service-status, policy |
| injected-claim | 1 | RETRIEVE | artifact-store, buyer-claim, policy, service-status | artifact-store, buyer-claim |
| lost-payment-notification | 1 | ESCALATE | gateway-record, policy, service-status | gateway-record, service-status |
| payment-never-broadcast | 1 | ESCALATE | buyer-claim, gateway-record, policy | gateway-record |
| hidden-completion | 1 | RETRIEVE | edge-log, policy, service-status, worker-log | worker-log, edge-log |
| hidden-completion | 2 | RETRIEVE | edge-log, policy, service-status, worker-log | worker-log, edge-log |
| hidden-completion | 3 | RETRIEVE | edge-log, policy, service-status, worker-log | worker-log, edge-log |
| unbacked-completion-claim | 1 | ESCALATE | artifact-store, edge-log, policy, worker-log | worker-log, artifact-store |
| unbacked-completion-claim | 2 | ESCALATE | artifact-store, edge-log, policy, worker-log | worker-log, artifact-store |
| unbacked-completion-claim | 3 | ESCALATE | artifact-store, edge-log, policy, worker-log | worker-log, artifact-store |
| still-running | 1 | ESCALATE | edge-log, policy, worker-log | worker-log, policy |
| still-running | 2 | ESCALATE | edge-log, policy, worker-log | worker-log, policy |
| still-running | 3 | ESCALATE | edge-log, policy, worker-log | worker-log, policy |
| corrupted-artifact | 1 | ESCALATE | artifact-store, policy, service-status | service-status, artifact-store |
| claim-contradicts-delivery | 1 | RETRIEVE | artifact-store, buyer-claim, edge-log, policy | artifact-store, buyer-claim |
| claim-contradicts-delivery | 2 | RETRIEVE | artifact-store, buyer-claim, edge-log, policy | artifact-store, buyer-claim |
| claim-contradicts-delivery | 3 | RETRIEVE | artifact-store, buyer-claim, edge-log, policy | artifact-store, buyer-claim |
