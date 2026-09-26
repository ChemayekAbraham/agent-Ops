# 138 — Merchant desk float returns are recorded automatically

**Status (2026-09-26 10:08 UTC): database side LIVE, edge function NOT deployed.**
Both migrations are applied and verified in production: the alert type is allowed,
`auto_create_deposits_from_gmail_impl` calls `auto_record_merchant_float_return`,
and anon/authenticated cannot execute it. `gmail-poll-transactions` still has
to be deployed; until then a return picked up by the edge path is still credited
as a deposit.

**Apply order matters.** `20260926090000` re-creates the impl as alert-only. Running
it after `20260926100000` silently reverts the automatic write-down; this happened
once on 2026-09-26 and was fixed by re-running `20260926100000`. Never re-run
`20260926090000` on its own.

## Why

On 2026-09-25 two merchant desks sent float back to the company:
Namulindwa Immeculate (UGX 5,000,000, TID157335971789) and Catherine Nabaggala
(UGX 4,000,000, TID157334845929). The Gmail matcher treats money from any agent
as a float deposit ("float-by-default"), so it *raised* both desks' float by the
amount they had just handed back. Financial Ops (Josh) cleared both by hand with
evidenced write-downs at 20:31 and 20:32 UTC. Both desks are at 0. The same
pattern recurred on 3, 11, 14, 15, 16, 17 and 21 September.

Commit `31c5483ee5` (cherry-picked as `8eb3d073a6`, migration `20260926090000`)
stopped the wrong credit, but it only raised an alert for Financial Ops to post
the write-down. The CEO then asked for the system to handle it: *"If they send
back the system should automatically detect that and do reactive changes."*
The scope is merchant agents only.

## What happens now

When an inbound MTN/Airtel receipt resolves to an **active merchant desk**
(`is_merchant_agent`, i.e. `cashout_agents.is_active`):

1. No deposit is created.
2. `auto_record_merchant_float_return(gmail_id, agent_id, match_method)` does the following:
   - reduces the desk's float by the amount returned, **capped at the float on the books** (float never goes negative);
   - writes an evidence row in `merchant_float_returns`, which is unique per Gmail row and per TID;
   - puts the TID in `ledger_reconciled_tids`, so a later deposit request with the same TID is refused rather than re-credited;
   - calls `sync_merchant_desk_float_cache` and writes an `audit_logs` row (`merchant_float_return_auto_recorded`, user_id NULL = system).
3. It raises a high-severity `merchant_float_return` alert for Financial Ops instead of posting, or as well as posting, when:
   - the return is larger than the float on the books (`partial`): the capped part posts and the excess is alerted;
   - the desk has no float on the books (`no_float`);
   - the TID was already filed as a deposit, or was already credited;
   - the edge path matched the sender **by name only**. Only a phone match may move a desk's float;
   - the posting raised an error. The database path wraps each receipt in a subtransaction, so one failure doesn't abort the batch.

Both creation paths are covered: `auto_create_deposits_from_gmail_impl` (DB,
phone-only match) and `_tryAutoCreditOperationalFloat` in
`gmail-poll-transactions` (after the late-link step, so a deposit the desk filed
itself still goes through as before).

## Ledger shape

The shape is identical to `post_merchant_evidenced_writedown`, the route Financial Ops used by hand,
so manual and automatic returns are accounted the same way:

| scope | bucket | direction | category |
|---|---|---|---|
| wallet (desk) | float | cash_out | `merchant_float_correction_writedown` |
| platform | — | cash_in | `merchant_float_correction_writedown` |

`classification = admin_correction`, `source_table = merchant_float_returns`,
`reference_id = TID`, idempotency key `merchant_float_return:<gmail_id>`.
The category is already allowlisted and routed to the float bucket.

**Rule 2** (`enforce_no_merchant_agent_auto_debit`) permanently blocks the old
*outbound* "Auto-debit (phone match)" against merchant floats. This is a
different event: money that actually arrived on a company line from the desk's
own phone. The legs don't carry that description. The CEO's instruction on
2026-09-26 is the authority for automatically reducing a merchant's float on an
inbound receipt.

## Known gaps / follow-ups

- **Suspense removed (migration `20260926110000`, NOT yet applied).** On the CEO's
  instruction ("Remove suspense account. Actual should be actual."), the platform leg
  of `merchant_float_correction_writedown` now maps to A8 (DR when cash_in), which mirrors
  the CR A8 posted when float is sent to a merchant agent. The 9M from 2026-09-25 leaves A9, and
  the wrong deposits and their write-downs cancel in A8. The same migration posts
  automatic returns as `production` rather than `admin_correction`, because the resolver drops
  admin_correction legs that aren't from `merchant_float_reconciliations`.
- **Mercy's Equity → merchant agent now credits MAF (migration `20260926120000`, NOT yet applied).**
  `equity_outgoing_to_account` rules get `auto_credit_from = now()` at apply time;
  every later send is credited through `record_merchant_float_delivery` (same legs as
  MTN/Airtel, TID `EQ<gmail id>`) and the row goes to `confirmed`. Runs inside
  `suggest_merchant_desk_external_funding` (cron every 15 min).
  **The 54 earlier rows (UGX 581,263,706, 1–25 Sep) are NOT credited, on instruction**
  ("DON'T CREDIT THE 581M TO THAT FLOAT DESK"); they stay `suggested`.
  `mtn_to_equity` rows are not auto-credited, because the MTN SMS doesn't name the destination.
  The only live rule attributes Mercy → NABAGGALA CATHERINE …9292 to desk BAITA
  (IMMACULATE NAMULINDWA 1a88b1b8). That attribution was inferred from timing. **Confirmed by Josh 2026-09-26:** WELILE
  Technologies (Equity …5259) → Bayo Mercy (Equity …7542) → NABAGGALA CATHERINE (…9292)
  credits Immaculate's desk. On the FinOps Actual Float card (`WalletBucketsPanel`, which
  already includes Mercy's balance as "Money at Bank — Bayo Mercy account"), the first leg
  raises Actual, the second lowers Actual and now raises BAITA's MAF. Migrations
  `20260926110000` + `20260926120000` were applied and verified 2026-09-26 11:36 UTC.
- The Gmail row stays `linked_deposit_request_id IS NULL`, because
  `auto_match_method` has a CHECK constraint. Any unmatched-receipt report may
  still list it. `merchant_float_returns.gmail_transaction_id` is the link.
- Not yet checked: whether `get_merchant_desk_funding_tracker` (doc 135) counts
  these legs in `taken_back`.
- No UI lists `merchant_float_returns` yet (Gemini). The alerts appear wherever
  `deposit_match_alerts` are shown.
- Still open from the 2026-09-25 investigation: wrongly credited float was moved
  into Nankambo Sharimah's withdrawable balance. This fix doesn't touch that.

## Verify after applying

```sql
-- objects exist
select to_regclass('public.merchant_float_returns'),
       to_regprocedure('public.auto_record_merchant_float_return(uuid,uuid,text)'),
       pg_get_functiondef('public.auto_create_deposits_from_gmail_impl(integer)'::regprocedure)
         ilike '%auto_record_merchant_float_return%';
-- after the next desk return
select * from merchant_float_returns order by created_at desc limit 5;
select * from deposit_match_alerts where alert_type = 'merchant_float_return' order by updated_at desc;
```

Not type-checked or run: Deno and a test database aren't available locally,
and `query_database` DDL is blocked, so the functions were checked against the
live schema by hand (columns, constraints, triggers on `general_ledger`,
`wallet_route_for_category`). `npm run guard:all` passes.
