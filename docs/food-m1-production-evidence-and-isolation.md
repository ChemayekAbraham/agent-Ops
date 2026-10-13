# Food M1: production evidence, test-project isolation and settlement operations

This document is a companion to `supabase/tests/food_m1/production_readonly_evidence.sql` and `docs/food-m1-risk-closure-register.md`.

**Nothing in this document is production-verified.** Production evidence exists only once an authorised operator returns the outputs requested here.

## 1. Exporting the deployed edge functions (evidence E7)

Ask the Lovable agent for a **read-only export**. It should change nothing, deploy nothing and run nothing. Suggested request:

> Read-only request, please do not modify, deploy or invoke anything. Export the exact source currently **deployed** (not the repository copy) of these edge functions, with each function's deployment version/date if available:
> `wallet-transfer/index.ts`, `_shared/treasuryGuard.ts`, `run-wallet-transfer-schedules/index.ts`, `process-agent-advance-deductions/index.ts`.
> For each, also state whether it is deployed with JWT verification on or off.
> Return the files verbatim. Do not include environment variable values or secrets.

**What it proves:** whether the deployed standard transfer path makes the same checks as the repository copy that Food was compared against:
- the treasury guard, using its debit scope;
- recipient eligibility, called with item NULL and sender = payer;
- the strict available-balance pre-check;
- the ledger leg shape;
- the advance-deduction sweep's use of `get_agent_sweepable_withdrawable`.

**What it cannot prove:** database function bodies. Those come from E1 to E6.

**Compare by:** saving the files outside the repository and running `git diff --no-index` against the repository copies at the release commit. Report every difference.

## 2. Test-project isolation checklist (`nykdsrixasxokqtfvvgw`)

Do **not** use the project until the owner has confirmed in writing every item below and has authorised test transactions there. A project name, a database name or a passing local isolation suite is **not** proof.

| # | Evidence needed | From whom |
|---|---|---|
| 1 | Project identity: the dashboard project ref is `nykdsrixasxokqtfvvgw`, its organisation and owner, and that it is **not** `wirntoujqoyjobfhyelc` (production) nor a branch of it | Owner (screenshot of project settings) |
| 2 | Database target: host or connection string shows the test ref; it is not a pooler or replica of production; no logical replication or foreign data wrapper to production (`SELECT * FROM pg_subscription; SELECT * FROM pg_foreign_server;` run there) | Operator |
| 3 | Credential separation: its anon and service keys and DB password differ from production; no production secret is stored in its Edge Function secrets or Vault | Owner |
| 4 | External integrations disabled or pointed at sandboxes: SMS (Yoola, Africa's Talking), email, mobile money, bank and Gmail polling, webhooks, `pg_net`/`http` targets, cron jobs (`SELECT jobname, schedule, command FROM cron.job;`) | Owner and operator |
| 5 | No real wallet or ledger connected: its `general_ledger` / wallets are not populated from production, or are anonymised test data only; no job copies to or from production | Owner |
| 6 | Personal data: no production personal data present (GDPR), or a documented legal basis and approved anonymisation | Owner / DPO |
| 7 | Schema parity statement: which production schema it was created from and when, for interpreting test results | Owner |
| 8 | Written authorisation naming the test accounts, the maximum amount per test transaction, and a rollback/compensation procedure | Owner |

## 3. Reversed-order settlement and reconciliation specification

When a Food payment is reversed through the standard Reverse feature, Food records it. Food **does not** prevent reversal; the shared feature allows it until the coordinator withdraws.

Food then:
- marks the order `payment_reversed`;
- sets `payment_resolution_required`;
- keeps the original transaction and paid time;
- records on the attempt row (`food_payment_attempts`) the amount actually returned (`reversed_amount`, which may be **partial**), the reversal reference and when it was posted.

Food also does **not** do any of the following:
- charge the employee again;
- repay the coordinator;
- write anything off;
- post anything.

**Evidence an authorised reviewer needs to decide the case:**

| Question | Evidence (all read-only) |
|---|---|
| What was paid? | `food_payment_attempts` row for the attempt: `amount`, `reference`, `transaction_group_id`, `paid_at`, `payer_id`, `payee_id`; the two `general_ledger` legs of `transaction_group_id` |
| What came back to the employee? | `reversed_amount`, `reversal_reference` (`<reference>-REV`), `reversal_posted_at`; the `-REV` ledger legs (employee cash_in, coordinator cash_out) and the `system_events` row written by `reverse_wallet_transfer` (`action: sender_reversal`, `amount`, `sent`) |
| What does the coordinator still hold from it? | `amount - reversed_amount` (zero for a full reversal) |
| What does the employee owe again? | `reversed_amount` for that order (the order total if the reversal was full). Whether it is owed at all is a business decision, not a Food computation |
| Who did what, when? | `food_order_events` (`paid`, `payment_reversed`, `payment_blocked`, `payment_retry_authorised`) and `food_audit` rows for the order. A `payment_reversed` row with no actor and the note "system reconciliation" was found by a scheduler |
| Was the meal delivered and received? | `fulfilment_status`, `received_at`, `received_by`, and any `food_exceptions` for the order |

**The only Food action available is `food_authorize_payment_retry(order, reason)`:**
- Only the active coordinator can call it, and never for their own order.
- It opens attempt *n+1* with its own reference (`-A<n>`) and key (`:<n>`), keeps the same payee and charges nobody.
- The employee must then pay themselves, and every payment check applies again.
- Any other outcome (waiver, repayment to the coordinator, or a manual settlement) is outside Food and needs an owner-approved process.

## 4. Scheduling `food_reconcile_payments`: recommendation (not configured)

**Recommendation for later approval:**
- Run every 15 to 60 minutes as `service_role`, with `p_limit` 100.
- If `more_pending` is true, run again until it is false, with at most N runs per cycle.
- Alert when `reversed > 0`, or when `more_pending` is still true after N runs, which means a backlog.

**Operational requirements:**
- The function never posts and only changes `paid` to `payment_reversed` for the posting it checked. It is safe to retry and to run concurrently (RACE-REC); locked rows are skipped.
- **Explicit cap:** 1 to 500 rows per call (organisation rule: every recurring automation has a batch cap).
- The job must run as `service_role`. The function checks the JWT role claim; a cron job running as `postgres` without that claim is refused.
- Owner approval is needed: this is a production configuration change.

## 5. Impact of the ledger boundary (`20261013126000` creates it; `20261013129000` revokes direct execution)

**Repository evidence (subagent scan of 5,125 function definitions):**
- 119 SQL functions post to `create_ledger_transaction*`; every one is SECURITY DEFINER in its latest definition. No invoker poster was found.
- Every trigger function that posts is SECURITY DEFINER.
- All 53 edge functions with a direct call use a service-role client.
- No frontend call remains: `COOPartnersPage` now calls `post_portfolio_roi_ledger`, and the build guard enforces it.
- A legacy overload `(uuid, jsonb, text, boolean)` (`20260504122059`) was never dropped. The migration's catch-all loop covers it.

**Split for a safe release order (2026-10-13).**
- `126000` now only creates `post_portfolio_roi_ledger`. It changes no permission, so the live COO page keeps working.
- The revoke moved to `20261013129000`, which is applied only **after** the new COO page is published and verified.
- The ledger-boundary suite checks the state in between: A-32 confirms the old direct path still works and the boundary exists. The suite passes 32/32 on PostgreSQL 17 and 18.
- One more upstream ledger caller appeared on `lovable` after the scan: `pay_agent_posted_rent_bonus_on_landlord_paid` (`20261013200000`). It is SECURITY DEFINER, so the revoke does not affect it.

**The release depends on the following, which is unverified in production:**
- every definer caller's **owner** must keep EXECUTE after the revoke from PUBLIC (by owning the ledger function, being superuser, or holding an explicit grant);
- no production-only invoker function or external job calls the ledger as `authenticated`.

These are queries E6, E6b and E6c. The local test showed E6b flags an owner without a grant. Do not weaken the revoke to make Food work.

## 6. Migration order and merge plan

**Apply in this order, explicitly.** These files are older than migrations already on `lovable`, so a "pending only" runner may skip or misorder them:

1. `20261009120001_food_service_schema_and_coordinator`
2. `20261009130001_food_service_operations_rpcs`
3. `20261009160000_food_coordinator_candidates`
4. `20261009170000_food_exception_resolution`
5. `20261012120000_food_m1_release_corrections`
6. `20261013120001_food_meal_images`
7. `20261013125000_food_staff_includes_pso`
8. `20261013126000_ledger_direct_execute_boundary` (part 1: creates the boundary only)
9. `20261013127000_food_exception_self_resolution`
10. `20261013128000_food_payment_after_receipt`
11. `20261013128500_food_reversal_and_handover_controls`: owner decisions REV-D1 (no reversals) and HND-D1. It adds a narrowly filtered guard trigger on `general_ledger`, which fires only for Food payment reversal rows and refuses them (evidence E2b).
12. `20261013129000_ledger_direct_execute_revoke` (part 2). Apply **only after** the new frontend is published and the COO Returns posting is verified (runbook step 8).

**Production prerequisites** (Food calls these by name; E1 to E5 verify them):
- `check_transfer_recipient_eligibility(uuid, text, uuid)`, `get_user_available_balance(uuid)`, `create_ledger_transaction(jsonb, text, boolean)`;
- `treasury_controls` (with `value`), `general_ledger`, `wallets_physical`, `profiles.is_frozen` and `deleted_at`, `user_roles.enabled`;
- `v_pso_officers`, `is_active_food_coordinator` (created by the Food migrations), and `storage` for meal photos.
- For wallet routing: `public.wallets.id` = `wallets_physical.id` (one wallet per user) and `general_ledger.wallet_id`, filled by `create_ledger_transaction` (evidence E1c and E4).

All of these are defined at the local `origin/lovable` tip `2b3a0f0144` (repository check). Upstream changes since our branch point only read them, call the ledger from a SECURITY DEFINER function, or (purge of deleted accounts, `20261013190000`) freeze the account and remove roles. For Food, that means a purged coordinator is **blocked**, never paid.

**Merge preparation** (read-only `git merge-tree` against `origin/lovable`):
- One textual conflict, in `package-lock.json`. Our side is the two portability commits (`79d9e07dba`, `716a115a88`); our `package.json` adds only the `test:food-db` script.
- **Plan:** merge `origin/lovable` into `release/food-m1-v2` with a merge commit (no rebase); take `lovable`'s lockfile; re-apply only the portability fix if Lovable's install needs it; rerun every suite.
- No new duplicate migration versions after the merge.
- Pre-existing upstream issue, not caused by Food: `lovable` has two files with version `20261013090000`.

**Moving `lovable` itself is a separate step.** It requires Lovable's agent to be idle, Josh's go-ahead, a fast-forward only, and a message to Lovable afterwards.

## 7. Release runbook (exact order; every step needs its own go-ahead)

**Gates before step 1:**
- the evidence pack output (E0–E7) has been reviewed and shows no blocking difference;
- owner decisions REV-D1, REV-D2, REV-D3 and HND-D1 are made;
- if `nykdsrixasxokqtfvvgw` is to be used, the isolation checklist (section 2) is confirmed;
- Josh's go-ahead is given.

1. **Merge preparation.** In `release/food-m1-v2`, `git fetch origin`, then merge `origin/lovable` with a merge commit (no rebase).
   - Resolve `package-lock.json` by taking `lovable`'s version.
   - Run `npm run guard:all`, the Food database suites on PostgreSQL 17 and 18 (run, race, matrix, isolation, dry run, ledger boundary), R2–R4, the Food app tests and tsc.
   - Push the feature branch.
   - *The permission system has twice refused this merge from an assistant session; a person may need to run it.*
2. **Confirm Lovable's agent is idle** (`get_project` → `agentFinished`; no new `lovable-sync-*` branch).
3. **Apply migrations 1–11** (section 6) in production, through the Lovable agent, **in that order**. Do **not** apply `20261013129000` yet.
4. **Post-migration read-only check:** rerun E2 (all Food objects present; versions recorded), E1c and E6b.
5. **Fast-forward `lovable`** to the merged release commit. Confirm the remote first; never force-push.
6. **Message Lovable** so it re-syncs on purpose, and let it publish the frontend.
7. **Smoke test** with approved test accounts only:
   - the COO Partners Returns compounding posts through `post_portfolio_roi_ledger`;
   - the Food menu loads, an order can be placed, delivered and receipt-confirmed;
   - a payment is made only with explicitly approved accounts and amounts, per the controlled transaction test plan, and then reconciled.
8. **Apply `20261013129000_ledger_direct_execute_revoke`** through the Lovable agent, then rerun E6 and E6b and repeat the COO smoke test.
9. **Operations:** enable a scheduled reconciliation only if REV-D3 approves it (section 4). Monitor `payment_blocked` and `payment_reversed` events.

**Rollback per step:**
- Steps 3–6: each migration header has a ROLLBACK note. Revert the frontend by fast-forwarding a revert commit; never rewrite `lovable`.
- Step 8: re-grant only if absolutely required, and record why.

## 8. Owner policy decisions (2026-10-13), as implemented

**REV-D1 (owner, 2026-10-14): canteen payments are internal and are not reversed.**
- The ledger guard refuses every reversal posting for a canteen payment, whoever tries. That covers the employee's ordinary statement Reverse and any other route.
- Food has no reversal path.
- The shared `reverse_wallet_transfer` is not changed.
- The statement UI may still show a Reverse button for a canteen payment; the server refuses it ("Canteen payments are not reversible"). Hiding the button is a UI change (Gemini).
- Food still detects and records a reversal, should one ever reach the ledger by another route (defence in depth).

**REV-D2: retry only by authorised decision; never an automatic recharge.**
- `food_authorize_payment_retry` (active coordinator, reason required, not for their own order) opens a new attempt identity.
- The employee pays again themselves; repeats are replays.

**REV-D3: scheduled reconciliation.**
- Not enabled anywhere. The recommendation in section 4 applies only after production verification and approval.

**HND-D1: another active coordinator handles a blocked payment.**
- Once a payment is blocked on its payee, `food_pay_order` refuses **every** retry until a decision is recorded. There is no automatic retry, even after the payee becomes payable again.
- The decision is `food_resolve_blocked_payment(order, reason)`. It is for the active coordinator only, who must be neither the employee nor the blocked payee, and a reason is required. The outcome is either:
  - **released:** the original payee can be paid again; the payee is unchanged and is never displaced; or
  - **reassigned:** the original payee still cannot be paid; the resolver becomes the payee. This is refused if the resolver has no wallet or is frozen, closed or not staff.
- Both outcomes are audited, with the reason (and, when reassigned, both payees). Neither makes a payment: the employee pays again themselves.
