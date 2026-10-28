CREATE OR REPLACE FUNCTION public.get_cfo_paid_by_category_page(p_from date, p_to date, p_category text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_offset integer DEFAULT 0, p_limit integer DEFAULT 50)
 RETURNS TABLE(id uuid, transaction_date timestamp with time zone, created_at timestamp with time zone, category_key text, category_label text, ledger_category text, amount numeric, description text, reference_id text, counterparty text, counterparty_phone text, approved_by text, source_table text, transaction_group_id uuid, classification text, total_matched bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_from timestamptz; v_to timestamptz;
  v_search text := nullif(btrim(p_search), '');
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_from > p_to THEN
    RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023';
  END IF;
  v_from := (p_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   := ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');

  RETURN QUERY
  WITH cm AS MATERIALIZED (
    SELECT x.c, CASE WHEN x.c = 'agent_advance_disbursement' THEN 'agent' ELSE public._cfo_paid_category_for(x.c) END AS k
    FROM (SELECT DISTINCT g0.category AS c FROM public.general_ledger g0
          WHERE g0.direction = 'cash_out' AND g0.transaction_date >= v_from AND g0.transaction_date < v_to) x
  ), f AS (
    SELECT g.id AS gid, g.transaction_date AS tdate,
           CASE WHEN g.classification = 'admin_correction' THEN 'budget'
                WHEN g.ledger_scope = 'platform' AND g.reference_id IN (
                  SELECT sr.wallet_transaction_id::text FROM public.staff_requisitions sr WHERE sr.wallet_credit_status = 'credited' AND sr.wallet_transaction_id IS NOT NULL AND lower(btrim(sr.department_key)) = 'marketing'
                  UNION ALL
                  SELECT er.wallet_transaction_id::text FROM public.employee_requisitions er WHERE er.wallet_credit_status = 'credited' AND er.wallet_transaction_id IS NOT NULL AND lower(btrim(er.department)) IN ('marketing','marketing department')) THEN 'marketing'
                WHEN g.category = 'marketing_expense' AND g.ledger_scope = 'platform'
                     AND (g.description LIKE 'Marketing expense: Promissory partner top-up commission%'
                          OR g.description LIKE 'Marketing expense: Promissory partner portfolio commission%'
                          OR g.description LIKE 'Marketing expense: Verified promissory note bonus%'
                          OR g.description = 'Marketing expense: lead partner growth override'
                          OR g.description LIKE 'Marketing expense: Managed proxy portfolio activation commission%'
                          OR g.description LIKE 'Marketing expense: Managed proxy portfolio top-up commission%'
                          OR g.description LIKE 'Marketing expense: Partner first fund-in commission%'
                          OR g.description LIKE 'Marketing expense: Partner repeat fund-in commission%') THEN 'partner'
                WHEN g.category = 'marketing_expense' AND g.ledger_scope = 'platform'
                     AND (g.description LIKE 'Platform expense: instant house-listed reward%'
                          OR g.description LIKE 'Platform expense: listing reward%'
                          OR g.description LIKE '%recruiter override%'
                          OR g.description LIKE 'Marketing expense: Bonus:%'
                          OR g.description LIKE '%verified bonus%'
                          OR g.description LIKE '%verification bonus%'
                          OR g.description LIKE 'Marketing expense: listing bonus%'
                          OR g.description LIKE '%registration bonus%'
                          OR g.description LIKE '%registration verification bo%'
                          OR g.description LIKE 'Platform expense: instant LC%-registration reward%'
                          OR g.description LIKE 'Marketing expense: Weekly Collection Streak reward%'
                          OR g.description LIKE '%agent commission for landlord payout%'
                          OR g.description LIKE 'Commission restore offset%'
                          OR g.description LIKE 'Marketing expense: commission correction%'
                          OR g.description LIKE 'Marketing expense: agent commission backfill%'
                          OR g.description LIKE 'Marketing expense: Manager agent commission%'
                          OR g.description LIKE 'Marketing expense: Sub-agent tenant reward%'
                          OR g.description LIKE 'Merchant Agent Referral Bonus%'
                          OR (g.description LIKE 'Referral%'
                              AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = g.user_id AND ur.role = 'agent'))
                          OR (g.description LIKE 'Marketing expense: Invite reward%'
                              AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = g.user_id AND ur.role = 'agent'))) THEN 'agent'
                WHEN g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
                     AND g.description LIKE 'Agent advance%disbursed to wallet%' THEN 'agent'
                WHEN g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
                     AND g.description LIKE 'Partner self-managed funding released to agent landlord float%' THEN 'partner'
                WHEN g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
                     AND g.description LIKE 'Undo of double-reversal:%' THEN 'corrections'
                ELSE cm.k END AS ckey
    FROM public.general_ledger g
    LEFT JOIN public.profiles sp ON v_search IS NOT NULL AND sp.id = g.user_id
    LEFT JOIN cm ON cm.c = g.category
    WHERE g.direction = 'cash_out'
      AND (g.classification IN ('production', 'legacy_real')
           OR (g.classification = 'admin_correction' AND g.category = 'system_balance_correction'
               AND g.ledger_scope = 'platform' AND g.description ILIKE '%automated%lunch allowance%'
               AND public._cfo_paid_lunch_correction_ok(g.transaction_group_id)))
      AND g.transaction_date >= v_from AND g.transaction_date < v_to
      AND g.category <> 'listing_rejection_recovery'
      AND (v_search IS NULL OR g.description ILIKE '%' || v_search || '%'
           OR g.reference_id ILIKE '%' || v_search || '%'
           OR sp.full_name ILIKE '%' || v_search || '%')
  ), pg AS (
    SELECT f.gid, f.tdate, f.ckey, count(*) OVER () AS n
    FROM f
    WHERE (p_category IS NULL OR f.ckey = p_category)
    ORDER BY f.tdate DESC, f.gid
    OFFSET p_offset LIMIT p_limit
  )
  SELECT g.id, g.transaction_date, g.created_at, pg.ckey,
         CASE pg.ckey WHEN 'lunch' THEN 'Lunch Allowance'
                      WHEN 'agent' THEN 'Agent Products and Services'
                      WHEN 'landlord' THEN 'Landlord Products and Services'
                      WHEN 'tenant' THEN 'Tenant Products and Services'
                      WHEN 'partner' THEN 'Partnership Products and Services'
                      WHEN 'marketing' THEN 'Marketing Expenses'
                      WHEN 'operational' THEN 'Operational Expenses'
                      WHEN 'budget' THEN 'Budget Expenses'
                      WHEN 'rnd' THEN 'Product Research & Development'
                      WHEN 'corrections' THEN 'Corrections'
                      ELSE pg.ckey END,
         g.category, g.amount, g.description, g.reference_id,
         CASE WHEN cpl.user_id IS NOT NULL AND cpl.user_id IS DISTINCT FROM g.user_id THEN cp.full_name ELSE p.full_name END,
         CASE WHEN cpl.user_id IS NOT NULL AND cpl.user_id IS DISTINCT FROM g.user_id THEN cp.phone ELSE p.phone END,
         CASE WHEN cpl.user_id IS NOT NULL AND cpl.user_id IS DISTINCT FROM g.user_id THEN p.full_name END,
         g.source_table, g.transaction_group_id, g.classification, pg.n
  FROM pg JOIN public.general_ledger g ON g.id = pg.gid
  LEFT JOIN LATERAL (
    SELECT x.user_id FROM public.general_ledger x
    WHERE x.transaction_group_id = g.transaction_group_id
      AND x.ledger_scope = 'wallet' AND x.direction = 'cash_in' AND x.user_id IS NOT NULL
    ORDER BY x.amount DESC, x.id
    LIMIT 1
  ) cpl ON true
  LEFT JOIN public.profiles cp ON cp.id = cpl.user_id
  LEFT JOIN public.profiles p ON p.id = g.user_id
  ORDER BY pg.tdate DESC, pg.gid;
END
$function$;

CREATE OR REPLACE FUNCTION public.get_cfo_paid_by_category_totals(p_from date, p_to date)
 RETURNS TABLE(category_key text, category_label text, sort_order integer, amount numeric, tx_count bigint, pct numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_from timestamptz; v_to timestamptz;
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_from > p_to THEN
    RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023';
  END IF;
  v_from := (p_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   := ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');

  RETURN QUERY
  WITH cm AS MATERIALIZED (
    SELECT x.c, CASE WHEN x.c = 'agent_advance_disbursement' THEN 'agent' ELSE public._cfo_paid_category_for(x.c) END AS k
    FROM (SELECT DISTINCT g0.category AS c FROM public.general_ledger g0
          WHERE g0.direction = 'cash_out' AND g0.transaction_date >= v_from AND g0.transaction_date < v_to) x
  ), legs AS (
    SELECT CASE WHEN g.classification = 'admin_correction' THEN 'budget'
                WHEN g.ledger_scope = 'platform' AND g.reference_id IN (
                  SELECT sr.wallet_transaction_id::text FROM public.staff_requisitions sr WHERE sr.wallet_credit_status = 'credited' AND sr.wallet_transaction_id IS NOT NULL AND lower(btrim(sr.department_key)) = 'marketing'
                  UNION ALL
                  SELECT er.wallet_transaction_id::text FROM public.employee_requisitions er WHERE er.wallet_credit_status = 'credited' AND er.wallet_transaction_id IS NOT NULL AND lower(btrim(er.department)) IN ('marketing','marketing department')) THEN 'marketing'
                WHEN g.category = 'marketing_expense' AND g.ledger_scope = 'platform'
                     AND (g.description LIKE 'Marketing expense: Promissory partner top-up commission%'
                          OR g.description LIKE 'Marketing expense: Promissory partner portfolio commission%'
                          OR g.description LIKE 'Marketing expense: Verified promissory note bonus%'
                          OR g.description = 'Marketing expense: lead partner growth override'
                          OR g.description LIKE 'Marketing expense: Managed proxy portfolio activation commission%'
                          OR g.description LIKE 'Marketing expense: Managed proxy portfolio top-up commission%'
                          OR g.description LIKE 'Marketing expense: Partner first fund-in commission%'
                          OR g.description LIKE 'Marketing expense: Partner repeat fund-in commission%') THEN 'partner'
                WHEN g.category = 'marketing_expense' AND g.ledger_scope = 'platform'
                     AND (g.description LIKE 'Platform expense: instant house-listed reward%'
                          OR g.description LIKE 'Platform expense: listing reward%'
                          OR g.description LIKE '%recruiter override%'
                          OR g.description LIKE 'Marketing expense: Bonus:%'
                          OR g.description LIKE '%verified bonus%'
                          OR g.description LIKE '%verification bonus%'
                          OR g.description LIKE 'Marketing expense: listing bonus%'
                          OR g.description LIKE '%registration bonus%'
                          OR g.description LIKE '%registration verification bo%'
                          OR g.description LIKE 'Platform expense: instant LC%-registration reward%'
                          OR g.description LIKE 'Marketing expense: Weekly Collection Streak reward%'
                          OR g.description LIKE '%agent commission for landlord payout%'
                          OR g.description LIKE 'Commission restore offset%'
                          OR g.description LIKE 'Marketing expense: commission correction%'
                          OR g.description LIKE 'Marketing expense: agent commission backfill%'
                          OR g.description LIKE 'Marketing expense: Manager agent commission%'
                          OR g.description LIKE 'Marketing expense: Sub-agent tenant reward%'
                          OR g.description LIKE 'Merchant Agent Referral Bonus%'
                          OR (g.description LIKE 'Referral%'
                              AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = g.user_id AND ur.role = 'agent'))
                          OR (g.description LIKE 'Marketing expense: Invite reward%'
                              AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = g.user_id AND ur.role = 'agent'))) THEN 'agent'
                WHEN g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
                     AND g.description LIKE 'Agent advance%disbursed to wallet%' THEN 'agent'
                WHEN g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
                     AND g.description LIKE 'Partner self-managed funding released to agent landlord float%' THEN 'partner'
                WHEN g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
                     AND g.description LIKE 'Undo of double-reversal:%' THEN 'corrections'
                ELSE cm.k END AS cat_key, g.amount
    FROM public.general_ledger g
    LEFT JOIN cm ON cm.c = g.category
    WHERE g.direction = 'cash_out'
      AND (g.classification IN ('production', 'legacy_real')
           OR (g.classification = 'admin_correction' AND g.category = 'system_balance_correction'
               AND g.ledger_scope = 'platform' AND g.description ILIKE '%automated%lunch allowance%'
               AND public._cfo_paid_lunch_correction_ok(g.transaction_group_id)))
      AND g.transaction_date >= v_from AND g.transaction_date < v_to
      AND g.category <> 'listing_rejection_recovery'
  ), grand AS (SELECT coalesce(sum(l2.amount),0)::numeric AS total FROM legs l2)
  SELECT f.category_key, f.category_label, f.sort_order,
         coalesce(l.amount, 0)::numeric AS amount,
         coalesce(l.tx_count, 0)::bigint AS tx_count,
         CASE WHEN gr.total > 0 THEN round(coalesce(l.amount,0) * 100.0 / gr.total, 2) ELSE 0 END AS pct
  FROM (VALUES
    ('lunch', 'Lunch Allowance', 1),
    ('agent', 'Agent Products and Services', 2),
    ('landlord', 'Landlord Products and Services', 3),
    ('tenant', 'Tenant Products and Services', 4),
    ('partner', 'Partnership Products and Services', 5),
    ('operational', 'Operational Expenses', 6),
    ('marketing', 'Marketing Expenses', 7),
    ('rnd', 'Product Research & Development', 8),
    ('corrections', 'Corrections', 9)
  ) AS f(category_key, category_label, sort_order)
  LEFT JOIN (SELECT cl.cat_key, sum(cl.amount) AS amount, count(*) AS tx_count FROM legs cl WHERE cl.cat_key IS NOT NULL GROUP BY cl.cat_key) l
    ON l.cat_key = f.category_key
  CROSS JOIN grand gr
  ORDER BY f.sort_order;
END
$function$;