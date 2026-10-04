---
name: Recipient-type authoritative routing
description: Wallet ledger legs stamp wallet_bucket from recipient_type at INSERT, so float allocations route correctly regardless of user roles
type: constraint
---
BEFORE INSERT trigger `trg_set_wallet_bucket_from_recipient_type` on `general_ledger` stamps `wallet_bucket` from `recipient_type` when `wallet_bucket IS NULL` and `ledger_scope='wallet'`:
- `recipient_type='user'` → `wallet_bucket='withdrawable'`
- `recipient_type='operational_wallet'` → `wallet_bucket='float'`
- `routing_source` set to `recipient_type_v2` (or `recipient_type_v2_backfill` for historical correction).

Why: `wallet_route_for_category` only routed `rent_payment_for_tenant` (and similar agent-only categories) to `float` if the user had the literal `'agent'` role enabled. Users acting as agents through other roles (manager, super_admin, dual-roled testers like Benjamin Muhanguzi) had float allocations silently routed to `withdrawable` — their float never decremented and their withdrawable was inflated. With the new trigger, `v_user_wallet_strict.routed_explicit` path always wins for recipient-tagged legs, so routing is role-independent and matches Wallet Routing v2 intent.

One-time backfill (2026-05-24) corrected 12 legacy rows for 1 user.
