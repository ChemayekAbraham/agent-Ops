# 196 — Agent collection errors CSV triage, 14 days to 2026-10-05

Source: `agent-collection-errors-all-14d-20261005-1439.csv` (389 rows, 72 agents, 2026-09-21 to 2026-10-05). Read-only investigation against live production; **no code or data was changed by this document.**

## Clusters, one at a time

| # | Cluster | Rows | Verdict |
|---|---|---|---|
| 1 | `IDBDatabase … connection is closing` | 140 | Already fixed (docs 142, 151). Last seen 2026-09-30, all from the old `fieldCollectStore-rxGmIFnf.js` bundle on stale tabs. Doc 186's new-build prompt is the mitigation. |
| 2 | Leaflet `_leaflet_pos` | 50 (+8 Safari) | Already fixed. All 22–24 Sep; agent maps got `map.stop()` on unmount in `020b159a46`; `153e90273a` (2026-10-05, on `origin/lovable`) extends it to the four non-agent maps. Executive `PropertyMapLeaflet` starts no animation, so not exposed. |
| 3 | Lazy-chunk `undefined (reading 'AgentTenantsSheet' …)` | ~34 | Stale-bundle chunk renames after deploys; same mitigation as cluster 1. |
| 4 | `INSUFFICIENT_TID_BACKED_FLOAT` near-misses | 108 (46 within 1,000 UGX) | The 09-21 rule working as designed. Agents only saw total float; the server checks the smaller TID-backed balance. UI fix delivered by Lovable in `AgentTenantCollectDialog.tsx` (shows "Available to collect", warns above it, locks Review/Confirm after a rejection until the amount or balance changes). Not yet committed to the repo at time of writing. |
| 5 | `fraud_blocked_wallet_credit` (SQLSTATE 28000) | 2 | Nyanzi Lydia Eseri, 2026-10-02 19:45 UTC, Babita Hasifa Hasifa, UGX 10,000 twice. Trigger `enforce_no_fraud_wallet_earnings` fired on an earner other than the agent (agent and referrer are not frozen or fraud-blocked now; she recorded ~12 other collections within minutes). Failed attempts roll back whole, so nothing posted. The Rent Plan still owes 331,096 and the UGX 10,000 may be unrecorded. |

Still to triage: `Write permission denied` (9), `reading 'target'` (7), IDB `get all index records` (7), `reading 'id'` (5).

## Finding that needs a decision: TID-backed counter drift

`agent_tid_backed_float` vs a ledger-derived balance (TID-matched deposits + reclass-in − float-used-for-rent), 565 agents:

- 438 equal; 59 counter **lower** than ledger (total 98.3M, 54 of them by more than 1,000); 68 counter **higher** (total 28.1M).
- Wafula Ronald ojiambo (1,998 vs 2,164) and Walyamboga Isaac (438 vs 626) are 166 and 188 low, which is exactly the "near-miss" gaps seen in the CSV. Not fractional shillings (all float ledger rows are whole amounts), not fee residue, and the zero-clamp never engaged (running balance never negative).
- Most "counter higher" cases are whole round amounts (e.g. Turibamwe Braison +5,000,000, Bayo Mercy +3,775,000) last updated on the 2026-09-23 seed day, mostly with no draws. Cause not established. The counter's draws come from `agent_collections`, the ledger formula uses `agent_float_used_for_rent`, so some difference is formula mismatch, not drift.
- **Not corrected.** Any fix is a deliberate change to what agents can collect and must be a delta, not an absolute set.

## Open

- Identify the blocked earner in the 2026-10-02 allocation (needs the failed transaction's legs).
- Confirm with Nyanzi Lydia Eseri whether Babita's UGX 10,000 was received and re-enter it if so.
- Decide on a TID counter reconciliation (start with the five largest overstatements).
