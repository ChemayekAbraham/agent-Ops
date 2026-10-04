# Investigation & Fix — FinOps "Recover to Platform" reason_code validation error (2026-08-04)

**No wallet balance, ledger entry, projection, audit row or historical financial record was modified.** The only writes this turn were to one frontend file.

## 1. Executive Summary

The error the operator saw is a **client/server version skew**, not a code contract mismatch.

- `supabase/functions/finops-wallet-move/index.ts` gained the mandatory `reason_code` validation in the commit dated **2026-08-04 10:59:21 UTC**.
- `src/components/financial-ops/FinOpsWalletMovePanel.tsx` gained the matching **Reason code** dropdown and the `reason_code` payload field in the commit dated **2026-08-04 11:01:19 UTC** — two minutes later.

Lovable-managed **edge functions deploy immediately**, while the **browser bundle only changes on publish/reload**. The operator in the screenshot is running the pre-11:01 UI (its label reads `Reason (min 10 characters)`; the current source reads `Reason note (min 10 characters)` and carries a dropdown above it) against the post-10:59 edge function. That old UI sends `reason` only, so the function correctly rejects it with the 13-code allow-list message.

Current `main` is already contract-correct. The fix below removes the remaining ways an invalid payload can reach the function and makes the requirement explicit on screen.

## 2. Error Trace

| Stage | Evidence |
|---|---|
| Operator input | Merchant wallet (`MERC…04927`), bucket `Withdrawable`, amount `1000000`, free-text reason `NOT VALID AT…`, **no reason code selected (no such control in that build)** |
| Payload sent (old bundle) | `{ mode:'error_correction', source_user_id, source_bucket:'withdrawable', amount:1000000, reason:'NOT VALID AT…' }` — **no `reason_code`** |
| First component to reject | `finops-wallet-move`, `index.ts:174-181`, before any wallet read or ledger write |
| HTTP status | `400` |
| Body | `{"error":"A reason code is required. Allowed: duplicate_credit, wrong_bucket, wrong_user, fraud_hold, reconciliation, incorrect_float_allocation, fraud_investigation, failed_funding_reversal, test_transaction, wrong_recipient, treasury_adjustment, manual_reconciliation, other."}` |
| Surfaced as | `invokeEdgeFunction(..., { errorTitle: 'Move failed' })` toast |

Rejection happens at input validation — the request never touched `wallets`, `general_ledger` or any RPC, which is why nothing was half-posted.

## 3. API Contract Analysis (current source)

```
FinOpsWalletMovePanel.submit()      → body.reason_code (snake_case), body.reason
finops-wallet-move index.ts:136-137 → body.reason_code, body.reason
index.ts:185                        → reason = `[${label}] ${note}`  (composed audit string)
error_correction_approvals          → reason_code, reason_detail
error_correction_audit / alerts     → reason_code, reference_number, details
general_ledger                      → description carries the composed reason
```

**No mismatch.** No `reasonCode`/`correction_reason` variant exists anywhere in the path. The 13 client `REASON_CODES` values are byte-identical to the edge function's `REASON_CODES` keys.

## 4. Frontend Analysis

- Dropdown exists (`fwm-reason-code`), rendered unconditionally in the amount/reason card for every mode.
- Required: `canSubmit` includes `!!reasonCode` and `reason.trim().length >= 10`; `'other'` additionally demands a 30-character note via `governanceComplete`.
- Not hidden, not optional; value is bound to the payload at the `reason_code` key.
- The `same_user` bucket-reclassification path (`admin-float-to-withdrawable` / `admin-withdrawable-to-float`) previously sent only `reason`; those functions do not require a code, but the audit string is now prefixed with it.

## 5. Edge Function Analysis

`index.ts:174-181` — mandatory, no default, `null`/absent/unknown all rejected:

```ts
const reasonCode = String(body?.reason_code ?? "").trim();
if (!REASON_CODES[reasonCode]) {
  return json({ error: `A reason code is required. Allowed: ${Object.keys(REASON_CODES).join(", ")}.` }, 400);
}
if (reasonNote.length < 10) {
  return json({ error: "A reason note of at least 10 characters is required." }, 400);
}
const reason = `[${REASON_CODES[reasonCode]}] ${reasonNote}`;
```

Validation order: method → auth → treasury guard → role gate (`cfo|manager|super_admin|cto|operations`) → mode/user/bucket/amount → **reason_code** → note → balance → post.

## 6. Database Analysis

No database object rejected this request. `error_correction_approvals`, `error_correction_alerts` and `error_correction_audit` all carry a plain `text` `reason_code` column with no enum and no `CHECK`; the ledger triggers (`enforce_wallet_ledger_only`, `trg_set_wallet_bucket_from_recipient_type`, `enforce_recipient_routing`) never inspect it. The allow-list lives **only** in the edge function — which is why the reported string matches its `Object.keys` order exactly rather than any Postgres enum ordering.

## 7. Root Cause

**Deployment skew, evidenced by commit timestamps:** the mandatory `reason_code` validation shipped to the live edge function at 10:59:21 UTC, and the UI control that supplies it shipped at 11:01:19 UTC. Because edge functions deploy instantly while the client bundle requires a publish/reload, the operator's stale bundle submitted `reason` without `reason_code` and was rejected at `index.ts:174`. It is not a field-name mismatch, enum mismatch, RPC signature problem or database validation.

## 8. Implementation Summary

`src/components/financial-ops/FinOpsWalletMovePanel.tsx` (only file changed):

1. Pre-invoke contract guard at the top of `submit()` — aborts with a clear toast if `reason_code` is missing/unknown or the note is under 10 characters, so no invalid payload can reach the function even from a stale confirm dialog or a future call path.
2. Inline `Reason code is required` hint under the dropdown while it is empty.
3. Inline character counter under the note while it is 1–9 characters.
4. The `same_user` reclassification payload now prefixes the note with `[reason_code]`, so both paths persist the structured classification.

Unchanged by design: the dropdown's 13 approved values, the mandatory explanation box, `reason_code` + `reason` both being submitted, the correction governance block (justification / ticket ref / earned-income ack), the CFO and dual-approval thresholds, and the balanced double-entry posting.

## 9. Validation Results

- `tsgo --noEmit`: clean, no errors.
- Single caller confirmed: `finops-wallet-move` is invoked from exactly one place in `src/`, and it sends both fields.
- Client allow-list vs edge allow-list: 13/13 identical values.
- Live authenticated round trip was **not** executed, because any successful `Recover to platform` call posts real ledger legs and moves real money — out of scope for a read-only investigation. Operators can complete a real recovery once the app is published; the required steps are now: pick a reason code, write ≥10 characters (≥30 for "Other"), plus justification and ticket reference for corrections.

**Action needed to clear the error for live operators: publish the app** so the browser picks up the bundle that contains the dropdown. Until then the old bundle will keep hitting the same 400.
