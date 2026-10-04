# 125 — Gmail poller silently dropped same-second messages (tenant direct rent payment lost)

**Status (2026-09-25): RESOLVED.** Fix confirmed deployed (rescan response carries a `rescan`
object) and Martha's payment recovered via handover 127's selective rescan — see 127 "Recovery log".

## Report

Agent **Mwaka Isaac** (`8853f6f4-df95-4659-9d3e-35294f0a83a2`): tenant **Martha Namigadde**
(`41383cef-a13c-456e-861d-01aa797f192c`, +256752251576, rent request
`660d8178-3657-44b1-981f-7234feb109e3`, UGX 200,000, `repaying`) paid her Rent Plan directly by
Airtel on 2026-09-23 14:02 EAT, TID **157162005754**, **UGX 21,445**. It never reflected.

## What happened

- The Airtel SMS **did** reach `weliletenants@gmail.com` via IFTTT: message `1a0cdf18ac0479f7`,
  internalDate **2026-09-23 11:05:52 UTC**, body
  `RECEIVED. TID157162005754 UGX 21445 from 752251576 …`.
- It is in **no** table: not `gmail_transactions`, `gmail_dedup_audit`, `deposit_requests`,
  exclusions, manual marks, or ledger. The tenant never submitted a deposit request either (she
  didn't need to; the direct-payment path is automatic).
- The same Gmail thread held two sibling messages with the identical internalDate, both also
  missing: a duplicate IFTTT copy (`1a0cdf18b3a628aa`) and an unrelated **UGX 1,000,000 deposit,
  Trans ID 157162130828** (`1a0cdf18b57bb8f7`).

## Root cause

`gmail-poll-transactions` runs every minute and keeps a timestamp cutoff
(`gmail_poll_state.last_internal_date_ms`), skipping any message with
`internalMs <= lastMs` as `older_than_last_poll`.

1. The 11:06:00 tick ingested message `1a0cdf189e66bffd` (TID 157162184892, outbound 1M),
   internalDate **11:05:52**, and advanced the cutoff to 11:05:52.000.
2. The three thread messages, stamped the **same second**, were not yet listable in Gmail at that
   moment (list-index lag of a few seconds).
3. The next tick saw them with `internalMs == lastMs` → skipped. Forever.

That skip is only recorded in `debug` mode, so nothing in `deposit_decision_audit` or any alert
surface shows it. `backfill` / `reparse` only revisit rows already in `gmail_transactions`, so
there was no way to recover a message the cutoff dropped.

Had it been ingested, the existing path would have handled it correctly:
`_tryAutoCreditOperationalFloat` matches sender 752251576 → Martha's profile → auto-credited
deposit → on approval `settle_tenant_rent_from_deposit` applies it to her Rent Plan, books the
collection and commission to Isaac, and SMSes both (see handover 126).

## Fix (`supabase/functions/gmail-poll-transactions/index.ts`)

1. **Grace window**: skip only when `internalMs < lastMs − 10 min` (`CUTOFF_GRACE_MS`). The
   durable dedupe was already ID-based (`gmail_message_id`, then TID / `dedup_hash`), so the
   wider window cannot create duplicates.
2. **No audit spam from the window**: inside the grace window (or a rescan), a message already
   present in `gmail_dedup_audit` is skipped quietly (`already_judged_duplicate`) instead of
   re-writing an audit row every minute for 10 minutes. Outside the window the lookup is not run,
   so the normal tick cost is unchanged.
3. **Rescan mode** for recovery: `rescan_from` / `rescan_to` (ISO, query string or JSON body)
   re-lists Gmail with `after:`/`before:` (up to 5×100 messages) and runs each through the
   normal path with the time cutoff bypassed. Bounded to a ≤48h window within the last 8 days
   because the endpoint is reachable with the anon key (same exposure as `backfill`). Never moves
   the stored cutoff backwards. Combine with `debug=1` for a dry run.

No migration. `deno check` reports the same 52 pre-existing type errors before and after;
`guard:all` passes.

## Recovery (after deploy)

1. Dry run: `POST …/gmail-poll-transactions?debug=1&rescan_from=2026-09-23T00:00:00Z&rescan_to=2026-09-24T12:00:00Z`
   → expect `1a0cdf18ac0479f7` and `1a0cdf18b57bb8f7` as `would_insert_parsed` (the second IFTTT
   copy then dedupes on TID). Anything else listed as `would_insert_*` is another message this bug
   dropped. Note it before the live run.
2. Live run: same without `debug=1`. The response must include a `rescan` object (proves the new
   code is deployed).
3. Verify: a `gmail_transactions` row for TID157162005754 linked to an approved deposit request,
   a `tenant_self_repayment_attempts` row with `outcome = 'settled'` for tenant
   `41383cef-…`, and her rent request balance reduced by 21,445.
   The 7-day auto-credit gate means this must run **before 2026-09-30 11:05 UTC**, or the rows
   will ingest but not credit.

## Watch-outs

- The thank-you SMS path also fires on a rescan, so Martha may get a late "thanks" SMS. That's harmless.
- Long-term the timestamp cutoff should be replaced by a Gmail `historyId` watermark; the grace
  window is a mitigation, not that rewrite.
