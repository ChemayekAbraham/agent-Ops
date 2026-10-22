-- 2026-10-22: CFO Dashboard -> Payables categories, revised (CFO request 2026-10-22). CLASSIFICATION AND LABELS ONLY.
--
--   Renamed (same records, same keys, same amounts):
--     partner   Supporter Returns & Capital   -> Partner Products and Services
--     landlord  Landlord Float Payout Budget  -> Land Products and Services
--     budget    Departmental Budgets          -> Operational Expenses
--     agent     Agent Commissions             -> Agent Commissions (unchanged; the list rows said "Agent Payables")
--   Added:
--     agent_products  Agent Products and Services (kept separate from commissions; no record maps to it until a source is approved)
--     marketing       Marketing Expenses: departmental budget lines of the Marketing department
--     rnd             R&D (Research and Development): departmental budget lines of Product Research and Development
--   Every other departmental budget line stays Operational Expenses. The department -> category list is in one place
--   (dm, in the departmental branch of v_payables_lines).
--
-- Each record keeps one line, one amount and one category: totals are unchanged and every category total adds up to the
-- payables total (verified read-only against production before this file was written). Category keys of existing
-- records are kept, so payment history and the forecasts keep their identity; only their labels change.
--
-- REPORTING ONLY. No ledger entry, wallet, payout, budget, requisition or grant is written or changed. CREATE OR REPLACE
-- keeps every grant. Independent of 20261022130000_payables_single_read_speedup (different objects); either order works.
-- TRANSACTION: run the file as ONE transaction (the migration tool does; by hand, wrap it in BEGIN; ... COMMIT;). The
-- guard changes nothing when it refuses. Function checks ignore carriage returns (CRLF checkouts).
-- Rollback: supabase/rollbacks/20261022160000_payables_categories_v2.rollback.sql

SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF md5(pg_get_viewdef('public.v_payables_lines'::regclass)) IS DISTINCT FROM '756c153a1434a56ed1f45b4ba8c39d62'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.payables_category_frame()'::regprocedure) IS DISTINCT FROM '20aaa62fea88849a1f7c993810dea188'
     OR to_regclass('public.hr_departments') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'v_budget_payables_lines' AND column_name = 'department_id') THEN
    RAISE EXCEPTION 'precondition failed: v_payables_lines or payables_category_frame changed since 2026-10-22; nothing was changed. Regenerate this migration from the current definitions';
  END IF;
END
$pre$;

-- 1. The category list the payables reports group by.
CREATE OR REPLACE FUNCTION public.payables_category_frame()
 RETURNS TABLE(category_key text, category_label text, sort_order integer)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT * FROM (VALUES
    ('partner','Partner Products and Services',1),
    ('landlord','Land Products and Services',2),
    ('agent','Agent Commissions',3),
    ('agent_products','Agent Products and Services',4),
    ('budget','Operational Expenses',5),
    ('marketing','Marketing Expenses',6),
    ('rnd','R&D (Research and Development)',7),
    ('other','Unclassified / Other',8)
  ) f(category_key, category_label, sort_order)
$function$;

-- 2. The payables list: new labels; departmental budget lines classified by department.
CREATE OR REPLACE VIEW public.v_payables_lines AS
SELECT 'partner'::text AS category_key,
    'Partner Products and Services'::text AS category_label,
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
    'Land Products and Services'::text AS category_label,
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
    'Land Products and Services'::text AS category_label,
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
    'Agent Commissions'::text AS category_label,
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
 SELECT COALESCE(dm.category_key, 'budget'::text) AS category_key,
    COALESCE(dm.category_label, 'Operational Expenses'::text) AS category_label,
        CASE
            WHEN b.overspent THEN COALESCE(dm.product_key, 'department_budget'::text) || '_overspent'::text
            ELSE COALESCE(dm.product_key, 'department_budget'::text)
        END AS product_key,
        CASE
            WHEN b.overspent THEN COALESCE(dm.overspent_label, 'Departmental Budgets'::text) || ' — overspent (credited above budget)'::text
            ELSE COALESCE(dm.product_label, 'Departmental Weekly Budgets'::text)
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
     LEFT JOIN hr_departments hd ON hd.id = b.department_id
     LEFT JOIN ( VALUES ('marketing'::text, 'marketing'::text, 'Marketing Expenses'::text, 'marketing_budget'::text, 'Marketing Weekly Budgets'::text, 'Marketing Budgets'::text),
                ('product_research_and_development'::text, 'rnd'::text, 'R&D (Research and Development)'::text, 'rnd_budget'::text, 'R&D Weekly Budgets'::text, 'R&D Budgets'::text)) dm(department_key, category_key, category_label, product_key, product_label, overspent_label) ON dm.department_key = hd.key
  WHERE b.outstanding_amount > 0::numeric OR b.overspent;

RESET lock_timeout;
