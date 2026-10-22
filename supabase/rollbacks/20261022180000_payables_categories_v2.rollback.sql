-- Rollback for 20261022160000_payables_categories_v2.sql: restores the exact production definitions of v_payables_lines and payables_category_frame,
-- and drops get_partner_promissory_commissions (a report; it holds no data).
-- Refuses, changing nothing, unless both are still the ones that migration created. Run as one transaction.
SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF position('dm(department_key, category_key' in pg_get_viewdef('public.v_payables_lines'::regclass)) = 0
     OR position('Partner Products and Services' in pg_get_viewdef('public.v_payables_lines'::regclass)) = 0
     OR position('proxy_note_registration_bonus' in pg_get_viewdef('public.v_payables_lines'::regclass)) = 0
     OR to_regprocedure('public.get_partner_promissory_commissions(date,date)') IS NULL
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.payables_category_frame()'::regprocedure) IS DISTINCT FROM 'd68d7533a2a3a955f06a66959be32246' THEN
    RAISE EXCEPTION 'precondition failed: the payables list or category frame is not the one 20261022160000_payables_categories_v2 created; nothing was changed. Reverse by hand';
  END IF;
END
$pre$;

DROP FUNCTION public.get_partner_promissory_commissions(date, date);

CREATE OR REPLACE FUNCTION public.payables_category_frame()
 RETURNS TABLE(category_key text, category_label text, sort_order integer)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT * FROM (VALUES
    ('partner','Supporter Returns & Capital',1),
    ('landlord','Landlord Float Payout Budget',2),
    ('agent','Agent Commissions',3),
    ('budget','Departmental Budgets',4),
    ('other','Unclassified / Other',5)
  ) f(category_key, category_label, sort_order)
$function$;

CREATE OR REPLACE VIEW public.v_payables_lines AS
SELECT 'partner'::text AS category_key,
    'Supporter Returns & Capital'::text AS category_label,
    'supporter_returns'::text AS product_key,
    'Supporter Returns Due'::text AS product_label,
    'investor_portfolios'::text AS source_table,
    ip.id AS item_id,
    ip.investor_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown supporter'::text) AS counterparty_name,
    GREATEST(round(COALESCE(ip.investment_amount, 0::numeric) * COALESCE(ip.roi_percentage, 0::numeric) / 100.0, 2), 0::numeric) AS outstanding_amount,
    ip.next_roi_date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    ip.status,
    ip.created_at
   FROM investor_portfolios ip
     LEFT JOIN profiles p ON p.id = ip.investor_id
  WHERE ip.status = 'active'::text AND ip.next_roi_date IS NOT NULL AND (COALESCE(ip.investment_amount, 0::numeric) * COALESCE(ip.roi_percentage, 0::numeric)) > 0::numeric
UNION ALL
 SELECT 'landlord'::text AS category_key,
    'Landlord Float Payout Budget'::text AS category_label,
        CASE
            WHEN f.overspent THEN 'landlord_float_overspent'::text
            ELSE 'landlord_float_budget'::text
        END AS product_key,
        CASE
            WHEN f.overspent THEN 'Landlord float — overspent (verified payouts above the float)'::text
            ELSE 'Weekly Landlord Float Budget'::text
        END AS product_label,
    'landlord_float_budgets'::text AS source_table,
    f.float_id AS item_id,
    NULL::uuid AS counterparty_id,
    'Landlord float, week of '::text || to_char(f.week_start::timestamp without time zone, 'DD Mon YYYY'::text) AS counterparty_name,
    f.outstanding_amount,
    f.week_end AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
        CASE
            WHEN f.overspent THEN 'overspent'::text
            WHEN f.week_ended THEN 'week_ended'::text
            WHEN f.unverified_count > 0 THEN 'receipts_pending'::text
            ELSE 'open'::text
        END AS status,
    f.created_at
   FROM v_landlord_float_payables f
  WHERE f.outstanding_amount > 0::numeric OR f.overspent
UNION ALL
 SELECT 'landlord'::text AS category_key,
    'Landlord Float Payout Budget'::text AS category_label,
    'landlord_approved_no_float'::text AS product_key,
    'Landlord payouts approved outside a weekly float'::text AS product_label,
    'landlord_payouts'::text AS source_table,
    s.payout_id AS item_id,
    s.landlord_id AS counterparty_id,
    COALESCE(s.landlord_name, 'Unknown landlord'::text) AS counterparty_name,
    s.amount AS outstanding_amount,
    (s.created_at AT TIME ZONE 'Africa/Kampala'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
        CASE
            WHEN s.no_float_basis = 'attempt_ended_unpaid'::text AND s.payout_status = 'failed'::text THEN 'payout_failed_unpaid'::text
            WHEN s.no_float_basis = 'attempt_ended_unpaid'::text THEN 'completed_without_payment'::text
            ELSE s.payout_status
        END AS status,
    s.created_at
   FROM v_landlord_payout_settlement s
  WHERE s.approved_no_float AND s.amount > 0::numeric
UNION ALL
 SELECT 'agent'::text AS category_key,
    'Agent Payables'::text AS category_label,
    'agent_commission_payout'::text AS product_key,
    'Agent Commission Payouts'::text AS product_label,
    'agent_commission_payouts'::text AS source_table,
    cp.id AS item_id,
    cp.agent_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown agent'::text) AS counterparty_name,
    GREATEST(COALESCE(cp.amount, 0::numeric), 0::numeric) AS outstanding_amount,
    (cp.requested_at AT TIME ZONE 'Africa/Nairobi'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    cp.status,
    cp.created_at
   FROM agent_commission_payouts cp
     LEFT JOIN profiles p ON p.id = cp.agent_id
  WHERE (cp.status = ANY (ARRAY['pending'::text, 'approved'::text])) AND COALESCE(cp.amount, 0::numeric) > 0::numeric
UNION ALL
 SELECT 'budget'::text AS category_key,
    'Departmental Budgets'::text AS category_label,
        CASE
            WHEN b.overspent THEN 'department_budget_overspent'::text
            ELSE 'department_budget'::text
        END AS product_key,
        CASE
            WHEN b.overspent THEN 'Departmental Budgets — overspent (credited above budget)'::text
            ELSE 'Departmental Weekly Budgets'::text
        END AS product_label,
    'budget_submission_lines'::text AS source_table,
    b.line_id AS item_id,
    b.department_id AS counterparty_id,
    COALESCE(b.department_name, 'Unknown department'::text) AS counterparty_name,
    b.outstanding_amount,
    b.period_end AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
        CASE
            WHEN b.overspent THEN 'overspent'::text
            WHEN b.unproven_credit_amount > 0::numeric THEN 'credit_unproven'::text
            ELSE b.submission_status
        END AS status,
    b.line_created_at AS created_at
   FROM v_budget_payables_lines b
  WHERE b.outstanding_amount > 0::numeric OR b.overspent;

RESET lock_timeout;
