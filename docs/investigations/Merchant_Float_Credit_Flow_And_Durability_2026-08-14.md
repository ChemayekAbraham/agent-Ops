# Merchant Float Credit — Full Money-Flow Trace & Durability Check

Date: 14 Aug 2026 · HEAD at time of writing: `6cc636cc2` (2026-08-14 15:00 UTC)
Scope: read-only code investigation. No wallet, ledger, or database writes were made while
producing this report.

## Why this doc exists

The merchant-agent float credit broke (company sent float, merchant's wallet never moved),
got root-caused, and got fixed earlier today. The question now is: **is the fix actually solid,
or does it just look fixed right now?** This doc traces the complete money path end to end —
Gmail inbox → parser → merchant match → ledger → wallet → dashboard — and then stress-tests
the fix itself, because the fix has already been rewritten twice today. That rewriting pattern
is, in fact, where the real "is this temporal" risk turned out to be hiding.

---

## 1. The full flow, as it exists right now

### Step 1 — Gmail polling picks up the SMS

A cron job (`gmail-poll-transactions-every-2min`) hits the `gmail-poll-transactions` edge
function every 2 minutes. It searches the connected Gmail inbox with a deliberately broad
query (any UGX/MoMo/bank keyword, `newer_than:30d`), fetches up to 50 matching messages, and
for each **new** one (deduped by Gmail message ID, transaction ID, and a content hash):

- Extracts the plain-text body (`extractPlainBody`, handles multipart/HTML).
- Runs it through `parseTransaction()` — a regex-based parser that pulls out `amount`,
  `transaction_id`, `direction` (`in`/`out`/`charge`), `channel` (`mtn_momo`/`airtel_money`/`bank`),
  and `counterparty` (the phone/name on the other side of the transaction).
- Inserts one row into `gmail_transactions` per email, `parsed = true` when amount or TID was
  extracted.

A company line sending money out reads to the parser as `direction: 'out'`, with `counterparty`
holding the recipient's phone number (e.g. `"You have deposited UGX 100,000 ... Mobile Number:
0704825473"` for Airtel, or `"UGX X was sent to NAME"` for MTN/bank).

### Step 2 — Deciding what an outbound email means

Every parsed, recent (`direction: 'out'`, ≤7 days old) row is handed to `tryAutoDebitPayout()`
(`gmail-poll-transactions/index.ts:1008`). This one function is where **three unrelated kinds of
outbound money** get disambiguated:

1. Company money delivered to a **merchant agent's float phone** → a float **credit**.
2. Company money sent to pay a **customer withdrawal or landlord payout** → a **debit** the
   engine reconciles against.
3. Anything else → left for manual review.

The current order of checks inside that function (as of `6cc636cc2`):

```
1018  eligibility gates: direction === 'out', amount > 0, ≤ 7 days old
1026  fetch the gmail_transactions row for this email (needed for every audit log below)
1035  resolve `cp` = counterparty (phone or name)
1040  Rule 1 — skip if this TID is already in ledger_reconciled_tids
1070  ── MERCHANT FLOAT DELIVERY CHECK (runs before Rule 3) ──
        cp's last 9 digits matched against cashout_agents.float_phone (is_active = true)?
        → yes: creditMerchantFloatFromOutboundSms(), then return — never falls through
        → no:  logged as float_phone_no_match, falls through to the debit path
1141  Rule 3 — welile_payout_source_accounts whitelist (emergency stop for AUTO-DEBIT only)
1170+ idempotency / double-debit guards / Rule 2 (never debit a merchant agent) / Rule 4 / debit
```

### Step 3 — Identifying the merchant

The match is exactly one lookup: `cashout_agents` where `is_active = true` and `float_phone`
ends in the same 9 digits as the SMS counterparty. `cashout_agents` is a CFO/ops-curated table —
this lookup **is** the whitelist for this path; it doesn't need or use
`welile_payout_source_accounts` (that table gates the *debit* engine only).

### Step 4 — Crediting the float (current implementation)

`creditMerchantFloatFromOutboundSms()` (`index.ts:1550`) no longer talks to another edge
function over HTTP. It calls one Postgres RPC, `record_merchant_float_delivery()`
(`supabase/migrations/20260814141423_...sql`), which does everything in a single transaction:

1. Normalizes the TID (`regexp_replace` to alphanumeric only).
2. If the TID is already in `ledger_reconciled_tids` → returns `already_reconciled` (no-op, not
   an error).
3. Re-verifies the agent is `is_active` in `cashout_agents` with a non-null `float_phone`
   (defense in depth — re-checked at the SQL layer, not just trusted from the caller).
4. Inserts into `merchant_float_deliveries` with a **unique constraint on `tid_normalized`**
   and `ON CONFLICT DO NOTHING` → if this exact delivery was already recorded, returns
   `already_recorded` instead of crediting twice.
5. Posts a balanced double-entry ledger transaction via `create_ledger_transaction()`:
   wallet-scope `cash_in` / `float` bucket / `agent_float_deposit` for the agent, and a mirrored
   platform-scope `cash_out` leg.
6. Stamps `ledger_reconciled_tids` so nothing else (Rule 1, a manual reconciliation, a future
   sweep) can later double-process the same TID.
7. Calls `apply_wallet_movement(...)` — **verified in this investigation to be a no-op with
   respect to money**: since `20260506161110_...sql` ("Wallet cache demolition"), both overloads
   of `apply_wallet_movement` only validate routing and ensure a `wallets_physical` identity row
   exists. They do not write a ledger row or a balance. So step 5 is the only real money
   movement; step 7 does not double-credit.

### Step 5 — Where the money actually "lands"

The `general_ledger` insert from step 5 fires `tg_refresh_wallet_projection_on_ledger`, which
marks the agent's row in `wallet_balances_projection` **dirty** (O(1)) rather than recomputing
the balance synchronously (`20260811050458_wallet_projection_dirty_flag_deferral.sql` — a
2026-08-11 performance change, unrelated to this incident). The actual number gets recomputed by:

- the next call that read-repairs that user (several wallet-read RPCs do this inline), or
- the `flush-dirty-wallet-projections` cron, every 2 minutes.

`wallets.float_balance` (the merchant's dashboard figure) is a view over this projection. So the
credit is real and ledger-backed the instant `record_merchant_float_delivery` commits, but the
**cached number a screen displays** can lag by up to one sweep cycle unless the specific read
path it goes through does its own read-repair first.

### Step 6 — Notifying the agent

On success, an SMS + transactional email are sent to the merchant ("UGX X was auto-credited to
your Operational Float. New float balance: Y"), and any previously-raised
`merchant_float_uncredited` alert for that email is auto-resolved.

### Why "normal" float never had this problem

A **customer** deposit (money coming *in* to any platform user) goes through a completely
different function, `tryAutoCreditOperationalFloat()` (called at `index.ts:787`), which has no
Rule 3 gate and never touches the auto-*debit* code path at all. The merchant-float case is
different specifically because it's an *outbound*-looking email (company → merchant) that has to
be reclassified as a credit — that reclassification is what lived inside the debit engine, behind
its debit-specific emergency stop. That's the entire reason this bug only ever affected merchant
agents and never affected ordinary users' float.

---

## 2. What was actually broken, and the fix history (today, in order)

| Time (UTC) | What happened |
|---|---|
| — | **Original bug**: merchant float credit lived at the bottom of `tryAutoDebitPayout`, *after* Rule 3 (`welile_payout_source_accounts` whitelist). That table has never had a seed row in any migration, so Rule 3 always tripped and returned before the float-phone match ever ran. Company→merchant sends produced **zero trace**: no deposit request, no ledger leg, no alert, nothing. |
| ~13:23–13:40 | **Fix 1**: gate reordered so the float-phone match runs before Rule 3; `raiseMerchantFloatAlert` added so any non-credit outcome is now visible; `approve-deposit`'s own gmail-direction re-verification widened (safely, only for the trusted service-role caller) to accept `direction: 'out'` proof, since without that fix `approve-deposit` would still have rejected the credit even after the gate was reordered. A backstop sweep (`sweepUnlinkedMerchantFloatSends`) was added — **first version auto-credited** any orphaned match it found, using a 7-day window. |
| 13:55–13:56 | The old HTTP-based approve flow (`insert deposit_request` → `fetch()` to `approve-deposit` → verify → approve) produced at least one `deposit_requests` row that ended up `status = 'rejected'` but had already left a balance effect — cleaned up by a targeted reversal migration (`20260814140634_...sql`) scoped to that exact 90-second window. |
| ~14:05–14:14 | **Fix 2 (current)**: the credit path was rewritten to call one atomic RPC, `record_merchant_float_delivery`, instead of the insert→HTTP→approve dance. The backstop sweep was changed to **detect and alert only — it no longer auto-credits anything**; retroactive crediting of historical gaps is now explicitly left to FinOps, and the sweep window was narrowed to 36 hours ("self-healing net for fresh gaps, not a mass historical backfill"). |
| 14:33 | A separate, correct fix (`20260814143324_merchant_float_positions_read_repair.sql`) closed a caching gap in `get_merchant_float_positions()` (the query behind the FinOps "Money with agents" card): it added a per-desk-agent read-repair loop so the card's "our cash still on their phones" figure could never show a stale pre-credit number. |
| 14:56 | A further rewrite of the same function, `get_merchant_float_positions()` (`20260814145634_...sql`), for an unrelated reason (stopping a double-count between ledger-posted and display-only reconciliation adjustments) — see §3, this is where a real regression was introduced. |

**Bottom line on "was it the main error": yes.** The Rule 3 ordering was the root cause of the
original symptom (money sent, nothing credited, no trace at all). That is fixed, and fixed in a
structurally sound way — not just reordered, but made atomic and idempotent at the database
layer (unique TID constraint + `ON CONFLICT DO NOTHING`, no HTTP hop, defense-in-depth
re-verification inside the RPC itself).

---

## 3. Is it durable, or does it just look fixed right now? — Two live regressions found

This is the part worth taking seriously: the instinct that this might be "temporal" was correct,
**but not for the reason originally suspected**. The credit mechanism itself (§1, Step 4) is now
solid. The instability is coming from a different place: **the same function
(`get_merchant_float_positions`) has been fully rewritten twice in one afternoon, and the second
rewrite silently dropped work done by the first**, because each migration does a complete
`CREATE OR REPLACE FUNCTION` from whatever copy of the function the author was looking at,
rather than a diff against the version that shipped 23 minutes earlier.

### Regression A — the read-repair fix from 14:33 is gone as of 14:56

`20260814143324_...sql` added this loop before trusting `wallets.float_balance`:

```sql
FOR v_agent_id IN
  SELECT DISTINCT ca.agent_id FROM public.cashout_agents ca WHERE ca.agent_id IS NOT NULL ...
LOOP
  IF NOT EXISTS (SELECT 1 FROM wallet_balances_projection w WHERE w.user_id = v_agent_id AND w.is_dirty = false) THEN
    PERFORM public.wallet_projection_read_repair(v_agent_id);
  END IF;
END LOOP;
```

`20260814145634_...sql` replaces the entire function body and **this loop is not present in the
new version** — the `held` CTE goes straight back to `LEFT JOIN public.wallets w`, no dirty check.
This is the exact stale-cache bug that was fixed 23 minutes earlier, back in production, for
whichever reason (a subsequent rewrite that started from an older copy of the function). If this
holds true, the "Money with agents" FinOps card can once again show a merchant's pre-credit float
balance for up to 2 minutes (or longer, if the sweep is delayed) after a real credit lands.

### Regression B — self-service access to this RPC now hard-fails

The 143324 version scoped its `desks` CTE with `WHERE v_is_finance OR ca.agent_id = auth.uid()`
— a finance user sees every desk, a merchant agent calling the same RPC sees only their own row.
The 145634 version instead does:

```sql
IF NOT v_is_finance THEN
  RAISE EXCEPTION 'Not authorized';
END IF;
```

with no `OR ca.agent_id = auth.uid()` anywhere, and the `desks` CTE has no row filter at all.
`v_is_finance` only covers `cfo / financial_ops / manager / super_admin / ceo / coo` — a merchant
agent's own role is `agent` (`app_role` enum: `tenant, agent, landlord, supporter, manager`), so
this check now **hard-rejects the merchant themself**.

This matters because `get_merchant_float_positions()` is not FinOps-only in practice:
`src/components/agent/MerchantFloatAvailableCard.tsx` — a merchant-agent-facing dashboard
widget, confirmed via `useMerchantFloatPositions()` in `src/hooks/useMerchantFloat.ts:110` —
calls this exact RPC. As it stands at `6cc636cc2`, a merchant agent opening their own dashboard
card should get an "Not authorized" exception instead of their float position. This needs to be
verified live (I did not have DB/runtime access to confirm the exception actually fires), but the
code path is unambiguous.

### A smaller, related loose end from earlier in the day

`20260814140009_...sql` (the migration that added `merchant_float_uncredited` to
`deposit_match_alerts_alert_type_check`) dropped-and-recreated that CHECK constraint without
`gmail_poll_stale`, a value the 2026-08-10 heartbeat monitor (`gmail-poll-heartbeat`) depends on
to alert when the polling cron itself goes silent. Not yet reintroduced as of `6cc636cc2`.

### The pattern behind all three

Every one of these is the same root cause: **a full `CREATE OR REPLACE` migration, written
without reading the immediately-prior version of the same function/constraint first, silently
reverts unrelated work that landed minutes or hours earlier.** The core merchant-float credit
bug is fixed and the fix is architecturally sound. But the *surrounding* observability and
access-control layer has been rewritten fast enough today that it's actively regressing itself.
That is the real substance behind "I think it's temporal" — not the credit mechanism regressing,
but its neighboring safeguards being overwritten out from under it.

---

## 4. Recommendations

1. **Re-apply the read-repair loop** to the current `get_merchant_float_positions()` (the version
   from `20260814143324_...sql`, merged into the current 145634 body) so the FinOps card can't go
   stale again.
2. **Restore the self-service filter** (`OR ca.agent_id = auth.uid()` on the `desks` CTE, and
   drop the hard `RAISE EXCEPTION` for non-finance callers) so `MerchantFloatAvailableCard` keeps
   working for merchant agents — then confirm live that a merchant-role user can load their own
   dashboard without error.
3. **Add `gmail_poll_stale` back** to `deposit_match_alerts_alert_type_check`.
4. **Process discipline for the rest of today's work**: before writing another
   `CREATE OR REPLACE FUNCTION` for `get_merchant_float_positions` (or any function that's been
   touched multiple times in one session), diff against the *current* migrated version, not
   against whatever local copy prompted the change — otherwise this same class of regression will
   keep recurring on every subsequent edit.
5. **FinOps to independently reconcile** the ~10 historical credits from the first (now-retired)
   auto-crediting backstop sweep against real MTN/Airtel statements — this was flagged previously
   and remains open; the current backstop no longer auto-credits, so no new instances of this are
   being created, but the historical ones haven't been confirmed either way.

## 5. What's genuinely solid (no further action needed)

- The core Rule-3-before-merchant-credit bug: fixed, and fixed correctly.
- The credit mechanism itself: atomic, idempotent (unique TID constraint + reconciled-TID stamp),
  defense-in-depth re-verified server-side, no HTTP round-trip to fail transiently, no
  double-credit via `apply_wallet_movement` (confirmed neutered since 2026-05-06).
- The backstop sweep's move to detect-only: correct governance — money movement stays a FinOps
  decision, automation only makes gaps visible.
- Alerting on every non-credit outcome: real, wired into every failure branch in
  `creditMerchantFloatFromOutboundSms`.
