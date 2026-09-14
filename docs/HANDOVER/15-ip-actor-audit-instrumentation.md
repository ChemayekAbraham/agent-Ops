# IP & actor audit instrumentation initiative (2026-09-13 to 2026-09-14)

**Read this when:** you need to know whether a sensitive action captures IP/actor identity, before
adding a new capture trigger or edge-function audit log, before trusting `request.headers` for
anything, or when `security_ip_audit_alerts` flags something and you need to know what's already
been ruled out.

## Why this exists

The founder's own words, which set the scope for everything below: IP capture should be **mandatory
for any action that changes money, authority, identity, payout destination, or financial records**.
IP is forensic evidence, not proof of identity. And the architectural rule that shaped every fix in
this initiative:

> The browser must never tell the database what its IP is. Capture the IP server-side at the Edge
> Function/API boundary. Otherwise a malicious client could simply submit `ip_address = '127.0.0.1'`
> and poison the audit trail. Behind a trusted proxy such as Cloudflare, the backend should resolve
> the real client IP only from the trusted proxy headers and record it itself.

## Part 1 — the 49 implementation items

One migration/fix per sensitive action category, each deployed and pushed as its own commit. In
rough chronological order:

1. **`withdrawal_requests`** — `request_ip_address`/`request_user_agent` +
   `capture_withdrawal_request_client_context()` BEFORE INSERT trigger.
2. **Payout-account lock** — see [`12-withdrawal-payout-account-lock.md`](./12-withdrawal-payout-account-lock.md).
3. **`general_ledger`** — `create_ledger_transaction()` (the single enforced ledger-write RPC,
   guarded by `trg_enforce_ledger_rpc_only`) extended to capture `ip_address`/`user_agent` directly.
4. **`profile_field_audit`** — `log_profile_field_changes()` extended to also track
   `mobile_money_name` (previously untracked) plus IP capture.
5. **`withdrawal_claim_attempts`** — `merchant_claim_log()` extended with IP capture.
6. **`deposit_requests`** — same BEFORE INSERT pattern as item 1.
7. **`login_phase_events`** — new `capture_login_phase_event_ip()` trigger (the table had a
   `user_agent` column but no capture trigger at all before this).
8. **`withdrawal_notification_log`** — `accept_withdrawal_dispatch()` stamps IP/UA on the
   *accepting* agent's row only, never the superseded ones.
9. **`audit_logs`** (395k+ rows, ~190 RPC writers at the time) — one `capture_audit_log_ip()`
   BEFORE INSERT trigger covers all of them without touching any RPC body. This is the
   one-shared-choke-point pattern used repeatedly through this initiative: add one trigger on a
   shared table (or one fix inside a shared library function many callers already route through)
   instead of editing every individual caller.
10. **`auth.users` password changes** — new `password_change_audit` table +
    `log_password_change_on_auth_users()` trigger on `encrypted_password` UPDATE. Caveat: GoTrue's
    own password-reset path may not carry the same header context as a direct client call — noted
    in the migration itself, not fully resolved.
11. **Bulk exports** (~55 genuine export sites out of ~200 candidate files, triaged from an initial
    incorrect estimate of "~20") — every CSV/XLSX/PDF export site got a logging call added to its
    existing download handler. Shared helper files (`xlsxExport.ts`, `exportUtils.ts`,
    `csvExport.ts`, `pdfAuditReport.ts`) got the logging added once at the shared function and
    covered many call sites per file; standalone single-purpose PDF generators were instrumented
    individually.
12. **Role grants/revocations, KYC level changes, partner/landlord payout destination changes,
    withdrawal approval stage transitions (`system_events`)** — same pattern, each its own
    migration.

**Every one of these commits was pushed individually, never batched** — this was an explicit,
repeated instruction, not a style choice. If you're adding a 50th item, keep doing that.

## Part 2 — the edge-runtime IP-spoofing correction (critical)

While building item 12 above, a serious bug was found in **every one of the 9 capture triggers
already built** at that point: they blindly trusted `x-forwarded-for` from `request.headers`
without checking whether the call was a genuine browser→PostgREST request or a **service-role edge
function call**. When a Supabase Edge Function calls the database using the service-role key, that
call's own `user-agent` matches `Deno/x.x.x (variant; SupabaseEdgeRuntime/x.x.x; ...)`, and any
`x-forwarded-for` present in that context is **Supabase's own infrastructure IP**, not the real
actor's — worse than null, because it's confidently wrong.

Fixed in `20260914100000_fix_edge_runtime_ip_spoofing_in_capture_triggers.sql`: every capture
trigger now checks `v_ua ILIKE '%SupabaseEdgeRuntime%'` first and treats that as "no real IP
available" (null), never trusting the header in that case. This same guard is now standard in
every capture function written since.

**Cleanup**: `deposit_requests` (2 rows), `profile_field_audit` (1 row), and `audit_logs` (some
rows) had already recorded the wrong infrastructure IP by the time this was caught — nulled out in
the same migration. **`general_ledger`'s 68 corrupted rows were deliberately left uncleaned** —
`trg_enforce_ledger_rpc_only` blocks any write to `general_ledger` outside `create_ledger_transaction`,
including a metadata-only cleanup UPDATE, and that guard was respected rather than bypassed.

## Part 3 — agreement acceptance IP was client-supplied, not server-verified

A follow-up review reported the 7 agreement-acceptance tables (tenant, merchant, lender-vouch,
lending-agent, supporter, employee agreement acceptances, plus borrower-vouch disclosures) at
97–100% IP coverage and moved on. That was the wrong metric. **All 7 hooks had the browser itself
calling `https://api.ipify.org?format=json` and sending the result as `ip_address` in the insert
payload** — spoofable by any modified client, and the small gaps in "coverage" were that third-party
network call occasionally failing, not random noise.

Fixed in `20260914160000_enforce_server_side_agreement_ip_capture.sql`: a BEFORE INSERT trigger,
`enforce_server_side_agreement_ip()`, on all 7 tables, that **unconditionally overwrites**
`ip_address`/`device_info` with the server-resolved value — unlike every other capture trigger in
this series (which only fills in a value when the column is null), because here the client actively
supplies a value that must never be trusted. The frontend's `api.ipify.org` calls were deliberately
left in place (Gemini's UI lane, and harmless now that the server always overwrites whatever they
send) — removing that dead network call is a worthwhile follow-up but not a security requirement.

An 8th hook, `useAgentAgreement.ts`, references a table (`agent_agreement_acceptance`) that does not
exist in the database at all — confirmed via an empty `information_schema.columns` query. Dead/
broken code, not a security gap, left alone.

## Part 4 — landlord MoMo-number changes with no actor (root cause found)

27 `audit_logs` rows (`action_type = 'landlord_material_change_applied'`, from
`guard_landlord_agreement_backed_changes()`, which fires on any landlord payout-field change and
already logs which fields changed but never captured old/new values) had `user_id = NULL`. Every
lead was checked and ruled out: `ops_update_landlord` (requires auth, already logs correctly to both
`audit_logs` and `system_events`), `EditLandlordDialog.tsx`'s direct client update (correctly
attributes name/phone changes, but the null-actor rows were momo-only), every cron job referencing
"landlord" (none write `mobile_money_number`), and most of the 38 edge functions that reference
`landlords`.

**Root cause: `supabase/functions/issue-landlord-payout-otp/index.ts`.** When an agent edits the
landlord's phone number on the payout-OTP form, this edge function silently persists the corrected
number back onto `landlords.mobile_money_number` via its service-role client — with no `auth.uid()`
in that specific write, so the guard trigger logged it with a null actor. **Verified conclusively**:
cross-referenced all 27 null-actor rows against `landlord_payout_otp_challenges` by `landlord_id` +
timestamp — every single one matched this one code path within about a second.

Fixed in commit `64bde2d6d`: the edge function now writes an explicit `audit_logs` row at the point
of the update, attributing it to the real `agent_id` (already known in that function's scope, from
the caller's JWT), with `actor_type: 'agent'`, old→new number, the source function name, and the
real client IP from this edge function's own inbound request (the actual trust boundary here, since
the DB-level trigger correctly cannot see past the service-role hop). **This is an edge function
change — it needs the project's normal deploy pipeline, not live from a database push.**

## Part 5 — missing-IP watchdog

`20260914170000_missing_ip_watchdog.sql`: a new `security_ip_audit_alerts` table +
`detect_missing_ip_on_sensitive_actions()`, scheduled hourly via `pg_cron`
(`detect-missing-ip-on-sensitive-actions-hourly`), following the project's existing `detect_*` /
`*_alerts` convention (e.g. `payout_proof_integrity_alerts`) rather than inventing a new mechanism.

Checks: withdrawal approved/rejected without IP (`system_events`); manual ledger corrections
without IP (`general_ledger.category = 'system_balance_correction'`, narrowed to exclude the
automated payroll-loyalty-bonus and platform-expense-transfer postings that otherwise dominate that
category — 77 of an initial 85 hits were the payroll cron alone); role grants/revocations; partner
and landlord payout-destination changes without IP (the landlord check excludes rows already
explained by the Part 4 companion audit row); agreement acceptances without IP (regression guard on
the Part 3 fix); KYC level changes without IP. Each check is duplicate-guarded against **any** prior
alert for the same `(source_table, record_id, issue_type)`, resolved or not — see Part 8 for why it
originally excluded only unresolved ones, and what that got wrong — and scoped to a rolling 48-hour
window.

Query it with:

```sql
SELECT issue_type, severity, count(*) FROM public.security_ip_audit_alerts
WHERE NOT resolved GROUP BY 1, 2 ORDER BY 3 DESC;
```

`resolved` + `resolution_note` are how an investigated alert gets closed out — see Part 6 for two
worked examples of resolving a whole batch with an explanation rather than silently deleting it.

## Part 6 — adversarial regression test

Ran directly against the SQL trust boundary — `set_config('request.headers', ..., true)` inside
transactions that were rolled back (or, for the one case that needed a real, non-rolled-back test,
one that fails on its own) — rather than firing real HTTP requests at production.

**Tests that passed as-is:**
- A spoofed `ip_address`/`device_info` in the client insert payload, plus a spoofed
  `x-forwarded-for` header, against `tenant_agreement_acceptance`: the server-resolved value won,
  both client-supplied values were discarded.
- A `user-agent` crafted to mimic `SupabaseEdgeRuntime` while also carrying a spoofed
  `x-forwarded-for`, trying to slip a fake IP past the edge-runtime guard: both `ip_address` and
  `device_info` correctly came back null rather than trusting anything in that context.

**Two real bugs found and fixed (`20260914180000_adversarial_regression_fixes.sql`):**

1. **Header trust ordering, in all 13 capture functions built by this point.** Every one checked
   `x-forwarded-for`'s first comma-separated hop *before* `cf-connecting-ip`. That's backwards: a
   client can pre-set its own `x-forwarded-for` header before the request ever reaches Cloudflare,
   and a reverse proxy conventionally *appends* its own observed address to whatever list it
   received rather than replacing it — so the leftmost XFF entry can be entirely attacker-authored.
   `cf-connecting-ip` is set by Cloudflare from the actual TCP connection and cannot be forged by
   the client. Fixed everywhere: `cf-connecting-ip` checked first, XFF's first hop only as a
   fallback for requests that reach Postgres without going through Cloudflare at all.

2. **Blocked withdrawal attempts were forensically invisible.** See
   [`12-withdrawal-payout-account-lock.md`](./12-withdrawal-payout-account-lock.md) for the full
   story — `RAISE EXCEPTION` aborts the whole transaction, so a log write placed *before* it (the
   first fix attempted) gets undone along with it. The real fix lives in
   `submit_withdrawal_request`'s own exception handler.

**Deliberately not run against production**: actually approving a real withdrawal or granting a
role through an alternative path, since either would mutate real state outside a reversible
transaction. **Still open** — needs a staging environment. See "What's still open" below.

## Part 7 — follow-up investigation (2026-09-14, after the four closure requirements)

The watchdog's first live run reported 153 withdrawal approvals and 6 ledger corrections missing
IP in a 48-hour window. Both were investigated individually rather than dismissed:

- **The 153**: `system_events.ip_address`/`user_agent` did not exist as columns before the
  Part-1-item-12 migration deployed (hours before the watchdog's first run) — the overwhelming
  majority are simply historical rows predating the capture capability, not a live gap. Exactly
  **one** post-deployment row existed, and it traced to `approve-withdrawal` completing a
  withdrawal through its service-role client — same class of bug as Part 4 (a genuine human actor,
  correctly un-attributable by the DB-side guard because of the service-role hop, with the real IP
  available only in the edge function's own inbound request). Fixed in commit `774741625`: the edge
  function now backfills the exact `system_events` row its completion produces (matched by
  withdrawal id, event type, **and** `metadata->>'stage' = 'completed'` specifically, so it can
  never touch a different approval stage's event for the same withdrawal). The same file had the
  Part-6 header-ordering bug independently duplicated three times — fixed by extracting a shared
  `supabase/functions/_shared/resolveClientIp.ts` helper, a first step toward the single
  platform-wide IP-resolution utility recommended below.
- **The 6** (really 3 corrections, 2 ledger legs each): all `set_merchant_desk_float_to()`
  corrections, role-gated to CFO/financial_ops/super_admin, each requiring a reason and evidence
  note (both present, quoting real MoMo transaction references), each with a companion `audit_logs`
  row (`merchant_desk_float_set`) carrying the real actor. `general_ledger.ip_address` simply wasn't
  captured on any row before 2026-09-13 19:12 UTC — a full day after these 3 corrections — so this
  is historical, not a live gap. Fully explained, resolved with notes.

Two pre-existing functions (predating this whole initiative) were found to have the same class of
bug and fixed:

- **`log_financial_ops_violation`** (commit `8c7b84356`) — the evidence trail for unauthorized
  financial-ops action attempts. Had the ordering bug **plus** a second, independent bug: its
  `coalesce(split_part(...), cf-connecting-ip)` could never actually reach the `cf-connecting-ip`
  side, because `split_part` on an empty string returns `''`, not `NULL`. Also had no edge-runtime
  guard at all before this fix.
- **`record_signup_attempt`** (commit `ac4836074`) — worse than misordered: it never read
  `cf-connecting-ip` at all, only `x-forwarded-for`, so the hard IP block list
  (`blocked_signup_ips`) silently never applied whenever that header was absent or spoofed. A
  second overload of this function takes `p_ip` as a caller-supplied parameter instead of resolving
  it from headers — grepped the whole `src/` tree, nothing calls it; left as dead code rather than
  guessed at.

## Part 8 — independent E2E test agent report (2026-09-14, later the same day)

A separate agent, briefed with a self-contained payments E2E test plan, ran the withdrawal
manager→CFO→FinOps chain, the merchant telecom atomicity fix, the payout-account lock, and the
Part 6 adversarial header tests independently — via the same rolled-back-transaction technique —
and largely corroborated everything above. It also found three things this initiative had missed:

1. **`issue-landlord-payout-otp` still had the vulnerable XFF-before-cf-connecting-ip ordering.**
   The very function whose landlord MoMo actor-attribution fix (Part 4, `64bde2d6d`) this whole
   initiative was built around had never been updated to use the shared
   `_shared/resolveClientIp.ts` helper — so the IP recorded alongside that fix's real `agent_id`
   could still be attacker-influenced. Fixed (`51831a2d4`): switched to the shared helper. Confirmed
   it was the only such site in the file.
2. **A direct database status update can move a withdrawal straight to `completed` without
   traversing manager/CFO/FinOps approval, and the resulting audit event's actor could be
   misattributed to the withdrawal owner.** Investigated the workflow question first:
   `approve-withdrawal`'s own `approvableStatuses` is `["pending", "requested", "manager_approved"]`
   — manager approval is already optional by design, and 8,627 of 8,705 approved/completed
   withdrawals go straight from `pending` to a single FinOps completion in normal production
   traffic. **This is not a bypass of a required workflow; it's the workflow.** No DB-level state
   machine was added — enforcing "always require all three stages" would break real, legitimate
   traffic that the business never required to have them.
   The actor-misattribution half was real and independent of that question, though: the old
   `COALESCE(NEW.processed_by, NEW.user_id)` fallback in `log_withdrawal_status_event()` could
   misattribute either a system/cron-driven completion to its recipient (checked: 78 of 8,705 rows
   have `processed_by IS NULL`, almost all legitimately automated "Proxy payout delivery for ..."
   completions, not evidence of a historical staff bypass) or a staff member's direct bypass of
   `approve-withdrawal` to the wrong person entirely. Fixed (`b6938c505`): the fallback now prefers
   `auth.uid()` (the actual authenticated caller of the current statement) over the withdrawal
   owner, and when truly no actor exists, leaves `user_id` null with an explicit
   `metadata.actor_type = 'system'` instead of guessing — verified with two rolled-back tests
   matching both cases.
3. **The missing-IP watchdog was re-flagging alerts that had already been investigated and
   resolved.** Every dedup guard in `detect_missing_ip_on_sensitive_actions()` excluded only
   *unresolved* prior alerts, so resolving a batch with an explanation made those exact rows
   eligible to be re-inserted as fresh unresolved alerts on the very next hourly cron tick.
   Confirmed empirically: all 159 rows the agent found "unresolved" were exact `record_id`
   duplicates of the batch already resolved with notes in Part 7. Fixed (`1c8360a70`): dedup now
   checks whether a row has *ever* been alerted on before, resolved or not — a triaged row no
   longer resurfaces on its own. The 159 duplicates were resolved with a note pointing back at this
   fix; a resolved alert can still be manually reopened if new information calls for it.
   This same investigation also confirmed the `approve-withdrawal` completion-IP backfill from Part
   7 is **not yet live in production** — a genuinely new `withdrawal_status_event_missing_ip` alert
   (record id `530d3686-...`, 2026-09-14 05:08 UTC) matches the exact same actor pattern as before
   the fix, meaning the edge function change is still only committed to the repo, pending the
   normal deploy pipeline. Left unresolved on purpose — it accurately reflects live state.

The agent's other findings all confirmed existing behavior rather than surfacing anything new:
merchant telecom principal/telecom independent idempotency held on both a synthetic test and three
real production payouts sampled after the cutoff; the payout-account lock and its blocked-attempt
logging worked correctly, including the edge-runtime-suppression case; all three Part 6 header-trust
tests (client-spoofed agreement IP, edge-runtime-UA impersonation, Cloudflare-over-XFF ordering)
passed again independently; the 30-day and test-window ledger balance checks were both clean
(`unbalanced_multileg = 0`).

## What's still open

1. **Deploy the `approve-withdrawal` and `issue-landlord-payout-otp` edge function changes.** Both
   are committed (`774741625`, `51831a2d4`) but edge functions need the project's normal deploy
   pipeline, not a live database push — Part 8 found direct evidence (`approve-withdrawal`) that
   the fix is not live yet.
2. **A role-grant/revoke staging mutation test** (grant → revoke → disable → re-enable, verifying
   the audit trail survives both the normal UI path and any direct supported backend path) is the
   one test from the original plan neither this initiative nor the Part 8 agent has run.
3. **A single shared IP-resolution utility.** `supabase/functions/_shared/resolveClientIp.ts` exists
   and is used by `approve-withdrawal`, but roughly a dozen other capture points (all the SQL
   functions listed in Part 1/2/3) still each carry their own copy of the same
   cf-connecting-ip-then-XFF logic inline. Consolidating them into one Postgres function (mirrored
   by the TS helper for edge functions) is the single change that would prevent this exact ordering
   bug from reappearing the next time someone writes a new capture point by copy-pasting an old one.
3. `password_change_audit`'s GoTrue-path caveat (Part 1, item 10) was never fully resolved — worth
   revisiting if a password-reset audit row ever shows a suspiciously empty IP.
4. Removing the now-redundant `api.ipify.org` client-side fetch in the 7 agreement-acceptance hooks
   (Part 3) is cosmetic cleanup, not a security requirement, since the server always overwrites
   whatever they send — but it's dead weight worth removing eventually.

## Closure status

| Requirement | Status |
|---|---|
| 49 implementation items | ✅ Complete |
| Landlord MoMo actor attribution | ✅ Root cause fixed |
| Agreement IP captured server-side | ✅ Fixed |
| Missing-IP watchdog | ✅ Running hourly |
| Adversarial IP/logging regression | ✅ Completed, produced 2 real fixes |
| 153 missing-IP withdrawal approvals | ✅ Investigated — historical + 1 live case, fixed |
| 6 ledger corrections | ✅ Investigated — fully explained, no action needed |
| `log_financial_ops_violation` / `record_signup_attempt` | ✅ Fixed |
| Independent E2E test agent report (withdrawal chain, merchant telecom, header trust) | ✅ Corroborated + found 3 new issues, all fixed |
| `issue-landlord-payout-otp` IP ordering | ✅ Fixed |
| Withdrawal-completion actor misattribution | ✅ Fixed |
| Missing-IP watchdog re-flagging bug | ✅ Fixed |
| Deploy `approve-withdrawal` / `issue-landlord-payout-otp` edge function changes | 🟡 Open — committed, not yet deployed |
| Role-grant/revoke staging mutation test | 🟡 Open — needs a staging environment |
| Single shared IP-resolution utility (full rollout) | 🟡 Partial — two edge functions done, SQL functions not yet consolidated |

From here, the priority shifts from **building logging** to **monitoring and using**
`security_ip_audit_alerts` as the ongoing control.
