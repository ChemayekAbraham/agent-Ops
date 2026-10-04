---
name: Welile Homes agent-collection model
description: Agent-managed monthly rent collection + landlord payout engine (10% fee split 2% agent / 8% Welile / 90% landlord), receivable×12, fixed-day payouts, deposit auto-collect
type: feature
---

# Welile Homes — Agent-Managed Rent Collection

Operational model (distinct from the older Welile Homes *savings* product where 10%
grows into tenant savings at 5%/mo). Agents enroll tenants; monthly rent is collected
through the Welile wallet (or allocated by the agent for phone-less tenants); Welile
takes 10% and pays the landlord 90% on a fixed day.

## Locked economics
- Landlord charged **10%** → receives **90%**.
- Agent **2%** comes **out of Welile's 10%** → Welile net **8%**, agent **2%**, landlord **90%**.
- At enrollment, one month's rent is booked as **receivable × 12**, one due per month.
- 10% charged **the moment** rent lands: tenant wallet deposit OR agent allocation.
- Landlord paid on a **fixed day-of-month** (`payout_day`, 1–28) per enrollment.

## Schema
- `welile_homes_subscriptions` extended: `agent_id`, `enrolled_by`, `has_smartphone`,
  `landlord_uses_wallet`, `payout_day`, `monthly_landlord_fee`, `receivable_total`,
  `outstanding_balance`, `next_due_date`, `mode` (`'agent_collection'` vs default
  `'savings'`), `landlord_name`, `landlord_phone`. Landlord without an account →
  `landlord_id` NULL, name/phone stored, paid via agent float.
- `welile_homes_monthly_dues` — 12-month schedule per enrollment, UNIQUE
  `(subscription_id, period_month)`: amounts due/collected, `landlord_fee` (10%),
  `agent_commission` (2%), `welile_net` (8%), `landlord_net` (90%),
  `collection_status` (pending/partial/collected), `payout_status`
  (unpaid/paid_wallet/paid_float). RLS: agent/tenant see own, ops see all.

## RPCs (SECURITY DEFINER)
- `enroll_welile_home_tenant(tenant, agent, monthly_rent, payout_day, has_smartphone,
  landlord_uses_wallet, landlord_id, landlord_name, landlord_phone, notes)` — upserts
  subscription + generates 12 dues idempotently.
- `welile_home_record_collection(subscription_id, amount, source, notes)` —
  `source` = `tenant_wallet` (debit tenant withdrawable) or `agent_allocation`
  (debit agent float via `rent_payment_for_tenant`). Pays agent 2% instantly
  (`agent_commission_earned`), platform receives the rest. FIFO applies to dues.
- `welile_home_run_landlord_payouts(as_of)` — pays each collected+matured due:
  landlord wallet (`landlord_rent_payment` → withdrawable) if `landlord_uses_wallet`,
  else agent landlord-float (`agent_landlord_payout` → float) + opens an
  `agent_landlord_float_allocations` row (source `welile_homes_payout`) for the agent
  to withdraw and hand over. Idempotent (payout_status gate).

## Automation & hooks
- Cron `welile-homes-landlord-payouts` daily 07:15 UTC → `welile_home_run_landlord_payouts(current_date)`.
- Trigger `trg_welile_home_auto_collect` on `system_events` (AFTER INSERT,
  `deposit_approved`/`funds_added`) best-effort auto-collects up to outstanding from
  the tenant's just-topped-up wallet. Wrapped in EXCEPTION → never blocks deposits.

## Ledger conventions
- Mirrors `agent_allocate_tenant_payment`: build legs → `create_ledger_transaction(legs, key, true)`.
  Wallet-scope legs auto-route via `wallet_route_for_category`; platform legs `ledger_scope='platform'`.
  Only allowlisted categories used (rent_repayment, agent_commission_earned/payable,
  rent_payment_for_tenant, rent_disbursement, landlord_rent_payment, agent_landlord_payout).

## UI
- Agent: Agent Dashboard → My Tenants → **Welile Homes** button →
  `AgentWelileHomesSheet` (stats, enroll dialog, per-tenant allocate, 2% earnings).
- Admin: Tenant Ops hub → **Welile Homes** button → `WelileHomesAdminPanel`
  (enrolled tenants, receivable, outstanding, Welile 8%, pending payouts, manual payout run).
- The legacy savings manager (`WelileHomesSubscriptionsManager`, mode `savings`) is untouched.
## SMS receipts
- Edge fn `welile-homes-sms-dispatch` scans recent `system_events` and sends
  receipts: tenant on each collection (`payment_made` / action `collection`),
  landlord on each payout (`rent_disbursed` / action `landlord_payout`).
- Idempotent per event via `sms_delivery_log` idempotency keys
  (`welile_collect_sms:<event_id>`, `welile_payout_sms:<event_id>`) — never double-sends.
- Multi-provider send (`_shared/sendSmsMultiProvider.ts`): Yoola → AfricasTalking → Lana.
- Landlord phone: wallet payout → landlord profile phone; float payout → stored `landlord_phone`.
- Runs on cron `welile-homes-sms-dispatch` every 5 min (covers deposit auto-collect +
  daily payout cron) AND is invoked fire-and-forget from the agent allocate and admin
  manual-payout actions for immediacy.

## New-tenant OTP verification (enrollment gate)
- When an agent enrolls a phone with NO existing profile, `AgentWelileHomesSheet`
  EnrollDialog first sends an OTP (`sms-otp` action `send`) to the tenant's phone
  and shows a 6-digit entry step. Only after `sms-otp` action `verify` succeeds does
  it call `register-tenant` → `enroll_welile_home_tenant` (which books receivable×12
  and schedules the 12 monthly dues). So no due is scheduled until the phone is verified.
- Matched/existing tenants skip OTP entirely and enroll immediately (unchanged).
- Reuses the shared `sms-otp` edge fn (no backend change). 60s resend cooldown; on
  finalize error the dialog returns to the form. Onboarding SMS still fires for new tenants.

## Edit enrollment
- RPC `edit_welile_home_enrollment(p_subscription_id, p_agent_id, p_monthly_rent, p_payout_day, p_has_smartphone)`
  (SECURITY DEFINER, agent-owner or ops only). Recomputes amount_due + 10% split
  (2% agent / 8% Welile) + 90% landlord_net ONLY on months with amount_collected=0
  and collection_status='pending'; shifts payout_date on all payout_status='unpaid'
  months to the new payout day; recomputes receivable_total, outstanding_balance,
  next_due_date. Collected/paid months are never touched. Emits system_event action 'edit'.
- UI: `AgentWelileHomesSheet` per-tenant card now has an **Edit** button (next to Allocate)
  opening `EditDialog` (monthly rent, payout day, smartphone toggle). Toast reports how
  many upcoming months were adjusted.

## Edit audit trail
- Table `welile_homes_enrollment_audit` (subscription_id, tenant_id, agent_id owner,
  edited_by, changes jsonb [{field,old,new}], months_adjusted, created_at). RLS: owner
  agent or editor sees own; ops sees all. Rows written by `edit_welile_home_enrollment`
  (SECURITY DEFINER) only when a field actually changed (monthly_rent/payout_day/has_smartphone).
- UI: `EditDialog` shows an "Edit history" section (editor name + timestamp + per-field
  old→new), fetched on open and refreshed after save.
