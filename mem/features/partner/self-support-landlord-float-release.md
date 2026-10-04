---
name: Partner self-support releases landlord float on Ops approval
description: Partner Ops approval of a self-managed partner commitment/top-up disburses principal directly to the tenant's agent landlord float, with partner-stamped ledger legs and an agent SMS that never names the partner
type: feature
---
# Partner self-support → agent landlord float (2026-08-19)

- `psm_disburse_landlord_float(commitment_id, topup_id, rent_request_ids)` is the
  single disbursement path. SECURITY DEFINER, service_role-only EXECUTE, internal
  `psm_is_topup_reviewer` gate. Called INSIDE
  `approve_pending_portfolio` (self_managed branch) and
  `partner_ops_approve_self_topup`.
- Per funding line: insert `agent_landlord_float_allocations`
  (`source='partner_self_funding'`, `funded_by_partner_id`, `funding_reference`
  `PSF-XXXXXXXX`) — the allocation trigger derives `agent_landlord_float.balance`.
  Money lands on the tenant's agent (`assigned_agent_id`/`agent_id`) for that
  landlord, NEVER a general float pool.
- Ledger: platform `rent_disbursement` cash_out + bridge
  `rent_receivable_created` cash_in, `linked_party = partner_id`,
  idempotency `psm-float-<line_id>`. Rent request flips to `funded`.
- Skips (never double-funds): any live allocation on the plan, or no assigned
  agent (audited as `float_disbursement_skipped`).
- Agent SMS: DB queue `partner_float_agent_notices` (one row per agent+landlord,
  unique per approval scope), drained by edge fn
  `notify-partner-float-agents` reading `v_partner_float_notice_queue`
  (agent name+phone joined — no N+1). Yoola (`sender: "WELILE"`) → Africa's
  Talking, logged to `sms_delivery_log`. Copy must NOT disclose the partner.
- CFO tracking: `v_partner_funded_landlord_float`.
