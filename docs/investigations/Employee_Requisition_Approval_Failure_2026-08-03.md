# Employee Requisition Approval Failure — read-only investigation
## 2026-08-03 · "Edge Function returned a non-2xx status code"

**Nothing was modified.** No edge function, migration, RLS, trigger, wallet, ledger, requisition or approval row was touched by this investigation. All findings come from source reads, edge-function logs and SELECT queries.

---

## Root cause (two defects, stacked)

**Primary defect — the wallet credit call is unauthenticated.**
`supabase/functions/_shared/requisitionWalletCredit.ts:127` calls
`admin.functions.invoke("cfo-direct-credit", …)`. With `npm:@supabase/supabase-js@2`, `functions.invoke`
attaches an `Authorization` header only from an active **session**. The `admin` client is created from the
service-role key with **no session**, so the outgoing request carries **no `Authorization` header at all**.
`cfo-direct-credit/index.ts:123-129` rejects that immediately with **HTTP 401 `{"error":"Unauthorized"}`**.

Log evidence, same second, both functions:
```
2026-08-03T06:09:57Z  cfo-direct-credit    ERROR  Missing or invalid Authorization header
2026-08-03T06:09:57Z  requisition-decide   ERROR  decide error TypeError: ...
```

**Secondary defect — the error handler itself throws, converting a handled failure into a 500.**
In the `catch` block that is supposed to record the failure gracefully,
`requisitionWalletCredit.ts:154-161` does:
```ts
await admin.from("audit_logs").insert({ … }).catch(() => {});
```
A PostgREST filter builder is a *thenable*, **not a Promise** — it has no `.catch()`. So the expression
raises `TypeError: admin.from(...).insert(...).catch is not a function` **inside the catch block**. That
TypeError escapes `creditRequisitionWallet` entirely, propagates to the outer `try` in
`requisition-decide/index.ts:139`, and returns **HTTP 500**. The graceful
`{ ok:false, message:"Approved — wallet credit failed…" }` return on line 162 is never reached.

Exact runtime error from the logs:
```
TypeError: admin.from(...).insert(...).catch is not a function
    at creditRequisitionWallet (functions/_shared/requisitionWalletCredit.ts:142:13)
    at async Object.handler (functions/requisition-decide/index.ts:95:24)
    at async mapped (ext:runtime/http.js:246:20)
```
(The deployed line 142 is the `.catch()` statement; the checked-in file shows it at 154-161 — the bundle is
offset by import elision. The identifier in the message is unambiguous.)

So the toast the CFO sees is **the second defect masking the first**.

---

## Phase 1 — Which function, entry point, payload, auth

| | |
|---|---|
| Button | `src/components/financial-ops/EmployeeRequisitionQueuePanel.tsx` → `decide()` at line 65 |
| Invoke | line 72: `supabase.functions.invoke('requisition-decide', { body: { id, action, reason, amount } })` |
| Function | `requisition-decide` |
| Entry point | `supabase/functions/requisition-decide/index.ts` → `Deno.serve` (line 10) |
| Payload | `{ id: "<uuid>", action: "approve", reason: undefined, amount: 150000 }` |
| Auth context | CFO's user JWT in `Authorization`; validated via `supabase.auth.getClaims(token)` (line 24); role gate against `user_roles` ∈ {cfo, super_admin, manager} (line 34-41). **Both passed** — the observed failure is far downstream. |

---

## Phase 2 — Full execution trace, with the stop point

```
Approve button (EmployeeRequisitionQueuePanel:65)                       OK
  ↓ supabase.functions.invoke('requisition-decide')                    OK
  ↓ Bearer token → auth.getClaims                          index.ts:24 OK
  ↓ role check cfo/super_admin/manager                     index.ts:34 OK
  ↓ body validation (id + action + amount override)        index.ts:43 OK
  ↓ UPDATE employee_requisitions SET status='approved'     index.ts:67 OK  ← COMMITTED
  ↓ profiles lookup by employee_email (ilike)              index.ts:79 OK
  ↓ creditRequisitionWallet(...)                           index.ts:88
      ↓ status==='approved' guard                     helper.ts:57      OK
      ↓ amount / userId guards                        helper.ts:60-67   OK
      ↓ wallets row exists for requester              helper.ts:70      OK
      ↓ INSERT requisition_wallet_credits (idempotency lock)
                                                      helper.ts:75      OK  ← ROW WRITTEN
      ↓ admin.functions.invoke('cfo-direct-credit')   helper.ts:127   ✗ 401
          cfo-direct-credit:123  no Authorization header → 401 Unauthorized
      ↓ catch → UPDATE credits status='failed'        helper.ts:147     OK
      ↓ UPDATE employee_requisitions wallet_credit_status='failed'
                                                      helper.ts:150     OK
      ↓ notifyAdminsOfFailure                         helper.ts:153     OK
      ↓ audit_logs.insert(...).catch(...)             helper.ts:154   ✗✗ TypeError
  ↓ TypeError unwinds past index.ts:88
  ↓ outer catch                                            index.ts:139
  ↓ return 500 { error: "admin.from(...).insert(...).catch is not a function" }

RPCs reached:      none
DB functions:      none
Triggers:          none
Ledger:            never posted
Wallet:            never credited
```

**Execution stops twice:** first at `helper.ts:127` (401 from `cfo-direct-credit`), then fatally at
`helper.ts:154` (TypeError inside the recovery path).

---

## Phase 3 — Complete server error

| Field | Value |
|---|---|
| HTTP status to browser | **500** (from `requisition-decide/index.ts:141`) |
| Upstream HTTP status | **401** from `cfo-direct-credit` |
| Upstream body | `{"error":"Unauthorized"}` |
| Upstream log line | `2026-08-03T06:09:57Z ERROR Missing or invalid Authorization header` (`cfo-direct-credit/index.ts:125`) |
| Exception type | `TypeError` |
| Exception message | `admin.from(...).insert(...).catch is not a function` |
| Function | `creditRequisitionWallet` |
| File / line | `_shared/requisitionWalletCredit.ts:142` (deployed) = `audit_logs.insert(...).catch(() => {})` at 154-161 in source |
| Stack | `creditRequisitionWallet → eventLoopTick → Object.handler (requisition-decide/index.ts:95) → mapped (http.js:246)` |
| SQLSTATE | **none — no SQL error occurred** |
| Constraint violated | **none** |
| RPC error | **none — no RPC was called** |
| Occurrences | 2026-08-03T06:09:50Z and 06:09:57Z (two Approve clicks) |

Note: the persisted `requisition_wallet_credits.error_message` reads
`"Edge Function returned a non-2xx status code"` — that is the supabase-js client's generic wrapper for the
401, which is why the real cause has been invisible from the UI and the table.

---

## Phase 4 — Validation gates, pass/fail

| # | Gate | Location | Result |
|---|---|---|---|
| 1 | Method is POST | index.ts:12 | pass |
| 2 | Bearer token present | index.ts:16 | pass |
| 3 | JWT valid (`getClaims`) | index.ts:24 | pass |
| 4 | Caller role ∈ cfo/super_admin/manager | index.ts:34 | pass |
| 5 | Body: id + action valid | index.ts:44 | pass |
| 6 | Reject requires ≥10-char reason | index.ts:45 | n/a (approve) |
| 7 | Amount override finite and > 0 | index.ts:51 | pass (150000) |
| 8 | Requisition row exists (`.single()`) | index.ts:67 | pass |
| 9 | Employee profile matches email | index.ts:79 | pass |
| 10 | Requisition status === 'approved' | helper.ts:57 | pass |
| 11 | Amount sane | helper.ts:60 | pass |
| 12 | Requester wallet exists | helper.ts:70 | pass |
| 13 | Duplicate-approval idempotency lock | helper.ts:75 | pass (row inserted) |
| 14 | **`cfo-direct-credit` Authorization header** | cfo-direct-credit:124 | **FAIL — 401** |
| 15 | Treasury guard / withdrawals paused | cfo-direct-credit:177 | never reached |
| 16 | CFO role re-check inside credit fn | cfo-direct-credit:180 | never reached |
| 17 | Solvency / overdraw check | cfo-direct-credit | never reached |
| 18 | Ledger double-entry balance | `create_ledger_transaction` | never reached |
| 19 | RLS | — | not implicated; every write used service-role |

**The failing gate is #14: the Authorization gate on `cfo-direct-credit`.**

Secondary consideration: even if a `Bearer <service-role-key>` header *were* sent, the request would still
fail. `cfo-direct-credit:142` only accepts a raw service-role bearer when
`system_auto_debit === true && operation === "debit"`; a requisition credit sends `operation: "credit"`, so it
would fall to `adminClient.auth.getUser(serviceKey)` at line 167 and 401 again. There is currently **no
service-to-service credit path** into `cfo-direct-credit`.

---

## Phase 5 — Database layer

| Item | Finding |
|---|---|
| RPC called | none. `create_ledger_transaction` was never invoked. |
| Trigger fired | none of the wallet/ledger triggers. Only ordinary row-update triggers on `employee_requisitions` and `requisition_wallet_credits` (audit/`updated_at`). |
| SQL exception | none |
| Constraint violated | none |

Confirmed by query: `requisition_wallet_credits` holds a `failed` row for `f12688fe…` with
`attempt_count = 2`, and no ledger legs exist for it. **The idempotency design held — there is no partial or
double credit.**

---

## Phase 6 — Failure classification

**Edge Function defect (service-to-service authentication), compounded by an Edge Function coding defect
in the error path.**

Not frontend. Not RPC. Not trigger. Not database. Not ledger. Not wallet. Not RLS. Not a business rule.

---

## Phase 7 — Final report

### Failure point
`supabase/functions/_shared/requisitionWalletCredit.ts:127` (401) and `:154` (TypeError → 500).

### Evidence
1. `cfo-direct-credit` log, 2026-08-03T06:09:50Z and 06:09:57Z: `ERROR Missing or invalid Authorization header`.
2. `requisition-decide` log, same timestamps: `TypeError: admin.from(...).insert(...).catch is not a function` at `requisitionWalletCredit.ts:142`.
3. `employee_requisitions` row `f12688fe-f63b-4c1b-8b17-50ab0df47e47`: `status='approved'`, `wallet_credit_status='failed'`, `approved_at=2026-08-03 06:09:57Z`, amount 150,000.
4. `requisition_wallet_credits`: `status='failed'`, `attempt_count=2`, `error_message='Edge Function returned a non-2xx status code'`.
5. Every other caller of `cfo-direct-credit` uses raw `fetch` with an explicit `Authorization: Bearer ${serviceKey}` header — `gmail-poll-transactions:1204`, `process-scheduled-payouts:142`, `sweep-payout-debits:281`. The requisition helper is the **only** caller using `admin.functions.invoke`, and the only one failing.
6. At 06:12:27Z a CFO-initiated `cfo-direct-credit` for the same amount and user **succeeded** (`ref=PAY-MSCU12D3-G80E`) — proving `cfo-direct-credit` and the whole ledger/wallet path are healthy when a human JWT is present. The break is purely the service-to-service hop.

### Blast radius
- **This is not new and not isolated to one requisition.** Five requisitions are stranded `approved` with a `failed` wallet credit:

  | requisition | amount UGX | employee | approved |
  |---|---|---|---|
  | f12688fe… | 150,000 | tcollines004@gmail.com | 2026-08-03 |
  | c4564a38… | 180,000 | grace.nation78@gmail.com | 2026-07-31 |
  | 48508678… | 665,000 | grace.nation78@gmail.com | 2026-07-31 |
  | e948460f… | 210,000 | enocklwegaba01@gmail.com | 2026-07-30 |
  | ee501077… | **18,000,000** | *(director_requisitions)* | 2026-07-31 |

  Total blocked: **UGX 19,205,000**, of which 18.0M is a director requisition.
- **`director_requisitions` is affected identically** — it shares `creditRequisitionWallet`.
- **`requisition-credit-retry`** (`EmployeeRequisitionQueuePanel:183`) calls the same helper, so every retry has reproduced the same 401 + 500 (`attempt_count` up to 3).
- **No financial damage.** No ledger legs, no wallet mutation, no double credit. The idempotency lock and the "one retryable failed row" design worked exactly as intended. Requisitions are stuck at `status='approved'` and never advance to `paid`.
- **Reputational/UX damage only**: CFO sees a meaningless error, employees are not paid through the system, and at least one payment (150,000 at 06:12) was worked around by a manual CFO Direct Credit. **A future retry of `f12688fe…` would credit that employee a second time**, because the manual credit was posted outside the requisition idempotency lock.

### Recommended implementation (not implemented)

1. **Fix the service-to-service auth hop.** Replace `admin.functions.invoke("cfo-direct-credit", …)` in `requisitionWalletCredit.ts` with a raw `fetch` to `${SUPABASE_URL}/functions/v1/cfo-direct-credit` carrying `Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}` and `apikey`, matching the three already-working callers. Read the real HTTP status and JSON body so the recorded `error_message` is diagnostic instead of `"non-2xx status code"`.
2. **Open a service-role credit path in `cfo-direct-credit`.** The current bypass at line 142 covers only `system_auto_debit` + `operation:"debit"`. Add an equivalent narrowly-scoped branch — e.g. `system_requisition_credit === true && operation === "credit"` — that requires the service-role bearer, resolves a finance actor for the platform leg, still runs the treasury guard, and carries the approver UUID through for audit. Without this, step 1 alone still 401s.
3. **Remove the `.catch()` on the PostgREST builder** (`requisitionWalletCredit.ts:154-161`). Wrap it in `try { await … } catch {}`. This alone converts the 500 into the intended graceful `ok:false` response with a readable message — worth shipping even before 1 and 2.
4. **Audit the whole codebase for `.from(...).insert(...).catch(`** and similar builder-`.catch()` patterns; the same latent TypeError may be sitting in other error paths.
5. **Surface upstream detail in the UI.** `EmployeeRequisitionQueuePanel:77` shows `data.error ?? error.message`; once the helper propagates the real body, the CFO will see "Unauthorized (401) from cfo-direct-credit" instead of the generic wrapper.
6. **Backlog remediation, in this order:** fix 1-3, then retry the four employee requisitions and the 18M director requisition through `requisition-credit-retry`. **Before retrying `f12688fe…`, reconcile against the manual 06:12 credit `PAY-MSCU12D3-G80E`** or the employee will be paid twice; the cleanest handling is to mark that one credited-out-of-band rather than retry it.
7. **Add an alert** on `requisition_wallet_credits.status = 'failed'` older than ~1 hour. This defect sat undetected from 2026-07-30 to 2026-08-03 across five requisitions and UGX 19.2M.
