# 250 — Learned payer routes: the next deposit from a payer follows the first manual route (2026-10-26)

**Status: MIGRATION WRITTEN, NOT APPLIED (Josh applies by hand).** `20261026100000_learned_payer_routes.sql`, rollback beside it.

## The problem

Tenants of agents (Ian, Martin) pay through Airtel / MoMo agents whose numbers are not registered. Phone match (payer phone = a profile's phone, the wallet number) and
name match both fail, so the payment waits for Financial Ops to route it by hand (Email Transactions > Route). Boss does not want money left waiting.

## What it does

1. `email_routing_history` AFTER INSERT trigger `trg_learn_payer_route` remembers payer phone key (last 9 digits) and payer name key (words sorted, so order does not matter)
   -> target wallet -> route (`operational_float` or `personal_deposit`; `withdrawable_debit` is not learned) in `learned_payer_routes`.
2. `auto_create_deposits_from_gmail_impl` (new SMS trigger + 2-minute cron) asks `learned_payer_target()` when no profile owns the SMS phone. If it answers, the SAME
   pending deposit request the phone match creates is created for that wallet, so approval, ledger, duplicate-TID guard and notifications are unchanged. Nothing new moves money.
3. `auto_match_email_deposits` name signal now also matches when every word of the depositor's name is present in any order.

## Guardrails (each leaves the payment for staff)

- Over `learned_payer_route_settings.max_amount` (UGX 1,000,000): not auto-routed. `get_learned_payer_suggestions()` lists them with the wallet they would have gone to.
- A key routed to **2+ different wallets** is a shop / money-agent number: never auto-routed (a phone key decides first; a shared phone key does not fall back to name).
- Only SMS ingested after the payer was learned. Never one that already has an `email_routing_history` row. Duplicate TIDs are refused by the existing guard.
- Never to an active merchant desk (`is_merchant_agent`), and never an agent's `personal_deposit` (needs the agent's own confirmation stamp).
- A failed auto-route is skipped with a warning; it never aborts the sweep. Other paths behave as before.
- `learned_payer_route_settings.enabled = false` switches it off. Every auto-route is in `learned_payer_auto_routes`; undo with the existing "Reverse auto-credit" in Financial Ops.

## Things that will bite

- The first deposit from a new payer still needs one manual route (or the payer / agent submitting the TID).
- Learning is forward only. A commented backfill at the bottom of the migration learns from the last 60 days of routes; run it deliberately.
- About 46% of routes in the last 90 days had no usable payer phone or name in the SMS (the counterparty was not parsed), so they teach nothing. Better SMS parsing in `gmail-poll-transactions` raises coverage.
- A money-agent shop number only becomes "shared" after staff route it to a second wallet. The UGX 1M limit and the undo cover that first mistake.
- Changing the limit: `UPDATE learned_payer_route_settings SET max_amount = ...` (service role / SQL editor only; authenticated users can read, not write).
