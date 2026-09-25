-- Correct plans whose declared start date preceded the landlord being paid
--
-- Companion to 20260925220000, which stopped the daily bill charging plans that
-- had not started and removed 18,422,547 of days that were never owed.
--
-- That fixed the BILL. This fixes the PLAN. 212 plans across 63 agents still
-- carried a repayment_starts_on earlier than the day after their landlord was
-- actually paid, which made their term_end wrong too — the tenant was being
-- given a shorter calendar window than they had paid for.
--
-- Two shapes, both real:
--
--   * 93 plans off by exactly ONE day — stamped with the landlord payment date
--     itself rather than the day after it. Small, but it is a whole day of rent
--     billed before it was owed, on every plan that route touched.
--
--   * 119 plans badly stale, up to 125 days. Mostly plans whose payout
--     completed days after funding, and plans re-funded after an allocation
--     return which kept the FIRST cycle's start date. BABIRYE MIRIA's plan said
--     16 September while her landlord was not paid until the 24th.
--
-- Each plan keeps its full term, counted from when its landlord had the money.
-- Nothing owed changes: total_repayment, daily_repayment and amount_repaid are
-- untouched. Only the calendar moves, and it moves in the tenant's favour.
--
-- WHAT IS DELIBERATELY NOT CORRECTED
--
-- Six plans are left alone, and the reason matters. Their payout record was
-- created and marked paid on the SAME DAY, months after funding — while the
-- tenant had already been collecting since May. A tenant does not start repaying
-- four months before their landlord is paid. Those payout rows are back-entries
-- from a reconciliation exercise, so their finops_disbursed_at is a RECORDING
-- date, not a payment date. Moving mawanda Dennis by 146 days would have reset a
-- plan that is 385,500 of 485,500 repaid.
--
-- The discriminator is clean and is applied below: a collection existing BEFORE
-- the payout record was created means the record is a back-entry. Having no
-- collections at all is not that signal — a first pass used a bare comparison
-- and NULL silently skipped 20 legitimate plans.
--
-- THE BOOKS
--
-- Nothing posts. The five AFTER UPDATE triggers on rent_requests were read
-- first: trg_auto_log_default fires only on status becoming 'defaulted',
-- trg_auto_log_fee_revenue only on status becoming 'funded', and
-- log_rent_amount_change only records rent_amount, duration_days, access_fee,
-- request_fee, total_repayment and daily_repayment. repayment_starts_on is in
-- none of them.
--
-- Verified after the run: zero ledger legs from this change, 17/17 money-path
-- invariants passing, total repaying obligation unchanged.
--
-- Every correction is recorded in audit_logs with the tenant, the agent, the old
-- and new dates, the old and new term end, and the reason.
--
-- This migration is idempotent: re-running finds nothing to correct.

WITH target AS (
  SELECT rr.id, tp.full_name AS tenant, rr.repayment_starts_on AS old_start,
         public.rent_plan_billable_from(rr.id) AS new_start, rr.duration_days,
         COALESCE(ap.full_name,'—') AS agent
  FROM public.rent_requests rr
  JOIN public.profiles tp ON tp.id = rr.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = COALESCE(rr.assigned_agent_id, rr.agent_id)
  WHERE rr.status IN ('funded','repaying')
    AND rr.repayment_starts_on IS NOT NULL
    AND public.rent_plan_billable_from(rr.id) > rr.repayment_starts_on
    -- COALESCE(..., TRUE) is load-bearing: a plan with no collections has a
    -- NULL first-collection date, and a bare comparison drops the row.
    AND COALESCE(
      (SELECT min(c.created_at)::date FROM public.agent_collections c
        WHERE c.rent_request_id = rr.id AND c.reversed_at IS NULL)
      >= (SELECT min(x.created_at)::date FROM public.landlord_payouts x
           WHERE x.rent_request_id = rr.id
             AND x.status IN ('awaiting_agent_receipt','disbursed','completed')),
      TRUE)
),
upd AS (
  UPDATE public.rent_requests rr
     SET repayment_starts_on = t.new_start, updated_at = now()
    FROM target t WHERE rr.id = t.id
  RETURNING rr.id, t.tenant, t.agent, t.old_start, t.new_start, t.duration_days
)
INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
SELECT NULL, 'correct_repayment_starts_on', 'rent_requests', u.id,
       jsonb_build_object(
         'tenant', u.tenant, 'agent', u.agent,
         'old_repayment_starts_on', u.old_start,
         'new_repayment_starts_on', u.new_start,
         'days_moved', u.new_start - u.old_start,
         'old_term_end', u.old_start + u.duration_days - 1,
         'new_term_end', u.new_start + u.duration_days - 1,
         'reason', 'Start date preceded the day after the landlord was actually paid. Tenant keeps the full term, counted from when their landlord had the money.',
         'batch', 'migration:20260925230000')
FROM upd u;
