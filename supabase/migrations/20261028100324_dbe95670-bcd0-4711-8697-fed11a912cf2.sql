-- 2026-10-28: CFO Dashboard -> "Paid by Category" report (CFO request 2026-10-28, Angwen Sarah).
-- REPORTING ONLY. No ledger entry, wallet, balance, payout, budget or payment execution is written or changed.

SET lock_timeout = '5s';

DO $pre$
BEGIN
  IF to_regprocedure('public._cfo_paid_category_for(text)') IS NOT NULL
     OR to_regprocedure('public.get_cfo_paid_by_category_totals(date,date)') IS NOT NULL
     OR to_regprocedure('public.get_cfo_paid_by_category_page(date,date,text,text,integer,integer)') IS NOT NULL
     OR to_regprocedure('public.has_role(uuid,app_role)') IS NULL
     OR to_regclass('public.general_ledger') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: paid-by-category functions already exist or guards are missing; nothing was changed';
  END IF;
END
$pre$;

-- 1. The single category map. Returns NULL for ledger categories that are not company payments
--    (custody movements, capital, corrections) so they never enter a total.
CREATE FUNCTION public._cfo_paid_category_for(p_category text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT CASE p_category
    WHEN 'general_admin_expense' THEN 'budget'
    WHEN 'payroll_expense' THEN 'budget'
    WHEN 'salary_payout' THEN 'budget'
    WHEN 'operational_expenses' THEN 'budget'
    WHEN 'platform_expense' THEN 'budget'
    WHEN 'platform_expense_disbursement' THEN 'budget'
    WHEN 'transaction_platform_expenses' THEN 'budget'
    WHEN 'tax_expense' THEN 'budget'
    WHEN 'interest_expense' THEN 'budget'
    WHEN 'equipment_expense' THEN 'budget'
    WHEN 'platform_loss_writeoff' THEN 'budget'
    WHEN 'merchant_oop_reimbursement' THEN 'budget'
    WHEN 'agent_requisition' THEN 'budget'
    WHEN 'rent_disbursement' THEN 'landlord_float'
    WHEN 'landlord_pool_deploy_company_managed' THEN 'landlord_float'
    WHEN 'landlord_pool_release_company_managed' THEN 'landlord_float'
    WHEN 'landlord_pool_release_self_support' THEN 'landlord_float'
    WHEN 'agent_commission_earned' THEN 'agent'
    WHEN 'agent_commission_payable' THEN 'agent'
    WHEN 'agent_commission_payout' THEN 'agent'
    WHEN 'agent_commission' THEN 'agent'
    WHEN 'agent_bonus' THEN 'agent'
    WHEN 'referral_bonus' THEN 'agent'
    WHEN 'roi_expense' THEN 'partner'
    WHEN 'roi_payout' THEN 'partner'
    WHEN 'supporter_platform_rewards' THEN 'partner'
    WHEN 'partner_commission' THEN 'partner'
    WHEN 'agent_landlord_payout' THEN 'landlord'
    WHEN 'landlord_receivable_obligation' THEN 'landlord'
    WHEN 'marketing_expense' THEN 'marketing'
    WHEN 'listing_rejection_penalty' THEN 'marketing'
    WHEN 'research_development_expense' THEN 'rnd'
    ELSE NULL
  END;
$function$;

-- 2. Per-category totals for the window: amount, transaction count and share of the grand total.
--    Every category is always returned (even at zero) so the CFO never silently loses a line.
CREATE FUNCTION public.get_cfo_paid_by_category_totals(p_from date, p_to date)
RETURNS TABLE(category_key text, category_label text, sort_order integer, amount numeric, tx_count bigint, pct numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_from > p_to THEN
    RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH legs AS (
    SELECT public._cfo_paid_category_for(g.category) AS cat_key, g.amount
    FROM public.general_ledger g
    WHERE g.direction = 'cash_out'
      AND g.classification IN ('production', 'legacy_real')
      AND (g.transaction_date AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
  ), grand AS (
    SELECT COALESCE(sum(amount), 0) AS total FROM legs WHERE cat_key IS NOT NULL
  )
  SELECT f.category_key, f.category_label, f.sort_order,
         round(COALESCE(l.amount, 0), 2) AS amount,
         COALESCE(l.tx_count, 0) AS tx_count,
         round(CASE WHEN gr.total > 0 THEN COALESCE(l.amount, 0) * 100 / gr.total ELSE 0 END, 2) AS pct
  FROM (VALUES
    ('budget',         'Operational Expenses',              1),
    ('landlord_float', 'Landlord Float',                    2),
    ('agent',          'Agent Commissions',                 3),
    ('partner',        'Partner Products and Services',     4),
    ('landlord',       'Land Products and Services',        5),
    ('marketing',      'Marketing Expenses',                6),
    ('rnd',            'Product Research & Development',    7)
  ) AS f(category_key, category_label, sort_order)
  LEFT JOIN (SELECT cat_key, sum(amount) AS amount, count(*) AS tx_count FROM legs WHERE cat_key IS NOT NULL GROUP BY cat_key) l
         ON l.cat_key = f.category_key
  CROSS JOIN grand gr
  ORDER BY f.sort_order;
END
$function$;

-- 3. Paginated transaction drill-down for the window (optionally one category, optionally searched).
--    total_matched is computed over the whole filtered set, so paging never changes the count.
CREATE FUNCTION public.get_cfo_paid_by_category_page(
  p_from date, p_to date,
  p_category text DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 50
)
RETURNS TABLE(
  id uuid, transaction_date timestamptz, created_at timestamptz,
  category_key text, category_label text, ledger_category text,
  amount numeric, description text, reference_id text,
  counterparty text, counterparty_phone text,
  source_table text, transaction_group_id uuid, classification text,
  total_matched bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_from > p_to THEN
    RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT g.id, g.transaction_date, g.created_at,
         m.cat_key, m.cat_label, g.category,
         round(g.amount, 2), g.description, g.reference_id,
         p.full_name, p.phone,
         g.source_table, g.transaction_group_id, g.classification,
         count(*) OVER () AS total_matched
  FROM public.general_ledger g
  LEFT JOIN public.profiles p ON p.id = g.user_id
  CROSS JOIN LATERAL (
    SELECT k.category_key AS cat_key, k.category_label AS cat_label
    FROM (VALUES
      ('budget',         'Operational Expenses'),
      ('landlord_float', 'Landlord Float'),
      ('agent',          'Agent Commissions'),
      ('partner',        'Partner Products and Services'),
      ('landlord',       'Land Products and Services'),
      ('marketing',      'Marketing Expenses'),
      ('rnd',            'Product Research & Development')
    ) AS k(category_key, category_label)
    WHERE k.category_key = public._cfo_paid_category_for(g.category)
  ) m
  WHERE g.direction = 'cash_out'
    AND g.classification IN ('production', 'legacy_real')
    AND (g.transaction_date AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
    AND (p_category IS NULL OR m.cat_key = p_category)
    AND (p_search IS NULL OR COALESCE(g.description, '') ILIKE '%' || p_search || '%'
         OR COALESCE(g.reference_id, '') ILIKE '%' || p_search || '%'
         OR COALESCE(g.linked_party, '') ILIKE '%' || p_search || '%'
         OR COALESCE(p.full_name, '') ILIKE '%' || p_search || '%'
         OR COALESCE(p.phone, '') ILIKE '%' || p_search || '%')
  ORDER BY g.transaction_date DESC, g.id
  LIMIT least(greatest(COALESCE(p_limit, 50), 1), 1000)
  OFFSET greatest(COALESCE(p_offset, 0), 0);
END
$function$;

REVOKE ALL ON FUNCTION public._cfo_paid_category_for(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_cfo_paid_by_category_totals(date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_cfo_paid_by_category_page(date, date, text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cfo_paid_by_category_totals(date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_cfo_paid_by_category_page(date, date, text, text, integer, integer) TO authenticated, service_role;

RESET lock_timeout;