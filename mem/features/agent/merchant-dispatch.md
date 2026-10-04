---
name: Merchant Withdrawal Dispatch (Uber-style)
description: Real-time broadcast/claim/redispatch of customer withdrawals to online merchant agents
type: feature
---
# Merchant Withdrawal Dispatch (Uber-style)

Real-time driver-dispatch model for customer cash-outs. Broadcasts each new
withdrawal to eligible ONLINE merchant (cash-out) agents; first to Accept
claims it atomically; unclaimed requests auto-redispatch then escalate.

## Flow
1. Customer submits `withdrawal_requests` (status `pending`). DB trigger
   `trg_notify_merchants_new_withdrawal` calls edge fn
   `notify-merchants-new-withdrawal` (round 1).
2. Shared engine `_shared/dispatchMerchants.ts` → `dispatchWithdrawal()`:
   - Eligibility: `cashout_agents.is_active AND is_online`, `wallets.float_balance >= amount`
     (skipped for `Landlord float payout` reason), and not already reserved on
     another open withdrawal (one active tx).
   - Sends in-app push ONLY (`send-push-notification`) to ALL eligible agents
     immediately. **SMS dispatch was removed 2026-07-14 — merchant claim
     broadcasts are push-only; do NOT re-add SMS to dispatchWithdrawal.**
   - Inserts one `withdrawal_notification_log` row per agent (`channel` push,
     `response` pending, `dispatch_round`).
   - Stamps `withdrawal_requests.dispatch_round`/`dispatch_expires_at`
     (`DISPATCH_TTL_SECONDS=60`), `auto_dispatched`, `dispatched_at`.
3. Client overlay `MerchantDispatchListener` (mounted globally in App
   `GlobalFloatingWidgets`, gated by `useIsMerchantAgent` + online) subscribes
   to `withdrawal_notification_log` INSERT `recipient_id=eq.me` (push rows),
   fetches context via `get_dispatch_context` RPC, and shows an Uber-style
   card anywhere in the app: amount, service area (customer city), distance
   (client haversine when agent GPS available), request time, ref, countdown,
   Accept / Ignore.
4. Accept → `accept_withdrawal_dispatch` RPC (atomic `FOR UPDATE`; sets
   `dispatch_claimed_by`, supersedes other pending log rows) → navigate to
   `/agent/cash-payouts` to settle via the existing `approve-withdrawal` flow.
   Ignore → `ignore_withdrawal_dispatch` RPC.
5. Realtime UPDATE on `withdrawal_requests` flips every other agent's card to
   "Already claimed".

## Redispatch / escalation
- Cron `redispatch-withdrawals-1min` (every minute) → edge fn
  `redispatch-withdrawals`: for expired, unclaimed, open requests it
  re-broadcasts rounds up to `MAX_DISPATCH_ROUNDS=3`, then escalates
  (sets `dispatch_escalated_at`, emits `withdrawal.dispatch.escalated`
  system_event, push to operations/cfo/coo/manager).

## Availability + history
- `merchant_set_online(boolean)` RPC + `useMerchantOnlineStatus` +
  `MerchantOnlineToggle`. Agents are ONLINE by default (`cashout_agents.is_online`).
- `MerchantDispatchHistory` shows the agent's own push log (audit trail).
- Realtime enabled on `withdrawal_notification_log` and `cashout_agents`.
