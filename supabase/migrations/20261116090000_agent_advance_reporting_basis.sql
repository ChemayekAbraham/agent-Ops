-- Agent advances: reporting and reconciliation basis (CFO, 11 Nov 2026). REPORTING ONLY: no ledger posting, no
-- balance, wallet, mapping or operational-record change; nothing here moves money or triggers any financial operation.
--
-- Verified 11 Nov 2026 against production (read-only):
--   * disburse_agent_advance_request sets outstanding_balance = principal + access_fee + registration_fee at issue;
--     repayments reduce it; arrears are computed as expected-to-date less paid, so arrears are a PART of outstanding
--     (331 open advances: arrears 47,698,694, never above outstanding).
--   * access_fee_collected is collected pro rata with repayments, so access_fee - access_fee_collected is the unpaid fee
--     INSIDE outstanding (21,495,676, never above outstanding).
-- Defects corrected:
--   1. fin_balance_sheet tie 'agent_advances' added arrears_balance to outstanding_balance (47.7M counted twice).
--      It now compares A10+A11+A20 with outstanding only and carries basis 'outstanding_only_v2'. The remaining
--      difference (2,370,285 on 11 Nov) stays visible as an unresolved exception.
--   2. v_receivables_lines listed the full outstanding as 'Agent Advances' AND the unpaid access fee as
--      'Agent Advance Access Fees' (21.5M counted twice in every receivables total built on the view).
--      The advance line now shows outstanding less the unpaid access fee (the A10/A20 part) and the fee line the unpaid
--      fee (the A11 part), capped at outstanding: the two lines add up to outstanding exactly, nothing is hidden.
--   3. fin_run_daily_tieout records, for each moved tie, the previous and current comparison basis and why it moved,
--      so the first night after this change reads 'comparison basis changed', not a new difference. Earlier nightly
--      rows are not touched.
-- Rollback: supabase/rollbacks/20261116090000_agent_advance_reporting_basis.rollback.sql (restores the 11 Nov bodies).

CREATE OR REPLACE FUNCTION public.fin_balance_sheet(p_as_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_sofp jsonb;
  v_val  jsonb;
  v_ties jsonb;
BEGIN
  IF NOT public._fin_can_view() THEN
    RAISE EXCEPTION 'Not authorised to view the balance sheet';
  END IF;

  v_sofp := public.get_statement_of_financial_position(COALESCE(p_as_at, now()));

  -- account values by code, from the statement just produced
  SELECT jsonb_object_agg(substring(e->>'source' from 'account ([A-Z0-9]+)$'), (e->>'value')::numeric)
    INTO v_val
  FROM (
    SELECT jsonb_array_elements(COALESCE(v_sofp->'assets'->'current','[]'::jsonb) || COALESCE(v_sofp->'assets'->'non_current','[]'::jsonb)
                              || COALESCE(v_sofp->'liabilities'->'current','[]'::jsonb) || COALESCE(v_sofp->'liabilities'->'non_current','[]'::jsonb)) e
  ) z
  WHERE substring(e->>'source' from 'account ([A-Z0-9]+)$') IS NOT NULL;

  WITH w AS (
    SELECT COALESCE(SUM(withdrawable_balance),0) wd, COALESCE(SUM(locked_balance),0) lk,
           COALESCE(SUM(float_balance),0) fl, COALESCE(SUM(advance_balance),0) adv FROM public.wallets
  ), t AS (
    SELECT
      (SELECT COALESCE(SUM(COALESCE(total_repayment,0) - COALESCE(amount_repaid,0)),0) FROM public.rent_requests
        WHERE status IN ('funded','disbursed','repaying') AND created_at <= COALESCE(p_as_at, now())) AS rent_book,
      (SELECT COALESCE(SUM(COALESCE(outstanding_balance,0)),0) FROM public.agent_advances
        WHERE status IN ('active','overdue') AND created_at <= COALESCE(p_as_at, now())) AS advances,
      (SELECT COALESCE(SUM(investment_amount),0) FROM public.investor_portfolios
        WHERE status = 'active' AND created_at <= COALESCE(p_as_at, now())) AS portfolios,
      (SELECT COALESCE(SUM(v.outstanding),0) FROM public.v_partner_note_settlement v JOIN public.promissory_notes n ON n.id = v.note_id
        WHERE n.status = 'activated' AND n.created_at <= COALESCE(p_as_at, now())) AS notes
  )
  SELECT jsonb_build_array(
    jsonb_build_object('key','rent_plans','label','Rent Plan receivables (A3) vs Rent Plan book',
      'ledger', ROUND(COALESCE((v_val->>'A3')::numeric,0)), 'operational', ROUND(t.rent_book),
      'difference', ROUND(COALESCE((v_val->>'A3')::numeric,0) - t.rent_book)),
    jsonb_build_object('key','agent_advances','label','Agent advances (A10+A11+A20) vs open advances outstanding (fees and arrears included)',
      'basis','outstanding_only_v2',
      'ledger', ROUND(COALESCE((v_val->>'A10')::numeric,0) + COALESCE((v_val->>'A11')::numeric,0) + COALESCE((v_val->>'A20')::numeric,0)),
      'operational', ROUND(t.advances),
      'difference', ROUND(COALESCE((v_val->>'A10')::numeric,0) + COALESCE((v_val->>'A11')::numeric,0) + COALESCE((v_val->>'A20')::numeric,0) - t.advances)),
    jsonb_build_object('key','supporter_capital','label','Supporter capital (L2 less unpaid promissory notes A7) vs active portfolios',
      'ledger', ROUND(COALESCE((v_val->>'L2')::numeric,0) - COALESCE((v_val->>'A7')::numeric,0)), 'operational', ROUND(t.portfolios),
      'difference', ROUND(COALESCE((v_val->>'L2')::numeric,0) - COALESCE((v_val->>'A7')::numeric,0) - t.portfolios)),
    jsonb_build_object('key','promissory_notes','label','Promissory notes (A7) vs activated notes not yet settled',
      'ledger', ROUND(COALESCE((v_val->>'A7')::numeric,0)), 'operational', ROUND(t.notes),
      'difference', ROUND(COALESCE((v_val->>'A7')::numeric,0) - t.notes)),
    jsonb_build_object('key','wallet_custody','label','Wallet custody (L1) vs wallets withdrawable + locked',
      'ledger', ROUND(COALESCE((v_val->>'L1')::numeric,0)), 'operational', ROUND(w.wd + w.lk),
      'difference', ROUND(COALESCE((v_val->>'L1')::numeric,0) - (w.wd + w.lk))),
    jsonb_build_object('key','agent_float','label','Agent float (A2) vs wallets float',
      'ledger', ROUND(COALESCE((v_val->>'A2')::numeric,0)), 'operational', ROUND(w.fl),
      'difference', ROUND(COALESCE((v_val->>'A2')::numeric,0) - w.fl))
  ) INTO v_ties
  FROM w, t;

  -- Comparison lines corrected (CFO, 10 Nov 2026): merchandise counts issued orders only (receivable recognised
  -- when an order is issued, policy of 4 Nov 2026); promissory notes split into activated and not yet activated.
  WITH memo AS (
    SELECT e FROM jsonb_array_elements(COALESCE(v_sofp->'reconciliation'->'memo_sub_ledgers', '[]'::jsonb)) e
    WHERE e->>'label' NOT IN ('Merchandise sales outstanding', 'Promissory notes uncollected')
  ), extra AS (
    SELECT jsonb_build_array(
      jsonb_build_object('label', 'Merchandise sales outstanding — issued orders only',
        'value', (SELECT COALESCE(SUM(COALESCE(amount_outstanding,0)),0) FROM public.merchandise_sales
                  WHERE order_status IN ('issued','completed') AND created_at <= COALESCE(p_as_at, now())),
        'source', 'operational sub-ledger — orders marked issued or completed (receivable recognised on issue)'),
      jsonb_build_object('label', 'Merchandise orders not yet issued (not a receivable)',
        'value', (SELECT COALESCE(SUM(COALESCE(amount_outstanding,0)),0) FROM public.merchandise_sales
                  WHERE COALESCE(order_status,'') NOT IN ('issued','completed','rejected','failed','cancelled')
                    AND created_at <= COALESCE(p_as_at, now())),
        'source', 'operational sub-ledger — pending, approved or awaiting handover; information only'),
      jsonb_build_object('label', 'Promissory notes activated, not yet settled',
        'value', (SELECT COALESCE(SUM(v.outstanding),0) FROM public.v_partner_note_settlement v JOIN public.promissory_notes n ON n.id = v.note_id
                  WHERE n.status = 'activated' AND n.created_at <= COALESCE(p_as_at, now())),
        'source', 'operational sub-ledger — note amount less collections, fund-ins attributed to the note and CFO-confirmed funding; compare against ledger account A7'),
      jsonb_build_object('label', 'Promissory notes not yet activated (commitments only)',
        'value', (SELECT COALESCE(SUM(COALESCE(amount,0) - COALESCE(total_collected,0)),0) FROM public.promissory_notes
                  WHERE status = 'pending' AND created_at <= COALESCE(p_as_at, now())),
        'source', 'operational sub-ledger — not recognised in the ledger')
    ) j
  )
  SELECT jsonb_set(v_sofp, '{reconciliation,memo_sub_ledgers}',
                   COALESCE((SELECT jsonb_agg(e) FROM memo), '[]'::jsonb) || (SELECT j FROM extra))
    INTO v_sofp
  WHERE v_sofp ? 'reconciliation';

  RETURN v_sofp || jsonb_build_object(
    'engine', 'fin_balance_sheet',
    'subledger_ties', v_ties,
    'subledger_ties_basis', 'Ledger balances are as at the statement date; operational figures (wallets, Rent Plan balances, advances, portfolios, notes) are as they stand now, so ties for past dates are indicative only.',
    'disclosures', jsonb_build_array(
      'Partner Product Receivables (A7) are activated promissory notes not yet settled by Supporter capital; the same amount is included in Supporter capital (L2). A note settled by a funded portfolio is released, so the capital is counted once.',
      'Landlord Float Pool (A21/A22) is company cash earmarked to fund Rent Plans (Supporter capital and compounded Returns), not money owed to landlords.',
      'Cash and Bank (A1) is negative mainly because verified cash deposits remain in Cash in Transit (A5); the two should be read together.',
      'Landlord Rent Payable (L4) holds no landlord obligations; its balance comes from resolver counterpart legs.')
  );
END;
$function$;

CREATE OR REPLACE VIEW public.v_receivables_lines AS
SELECT 'agent'::text AS category_key,
    'Agent Products & Services'::text AS category_label,
    'agent_advance'::text AS product_key,
    'Agent Advances'::text AS product_label,
    'agent_advances'::text AS source_table,
    a.id AS item_id,
    a.agent_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown agent'::text) AS counterparty_name,
    GREATEST((GREATEST(COALESCE(a.outstanding_balance, (0)::numeric), (0)::numeric) - LEAST(GREATEST((COALESCE(a.access_fee, (0)::numeric) - COALESCE(a.access_fee_collected, (0)::numeric)), (0)::numeric), GREATEST(COALESCE(a.outstanding_balance, (0)::numeric), (0)::numeric))), (0)::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    COALESCE(NULLIF(a.daily_installment, (0)::numeric), NULLIF(a.installment_amount, (0)::numeric), (0)::numeric) AS daily_amount,
    a.status,
    a.created_at
   FROM (agent_advances a
     LEFT JOIN profiles p ON ((p.id = a.agent_id)))
  WHERE ((a.status = ANY (ARRAY['active'::text, 'overdue'::text])) AND (GREATEST((GREATEST(COALESCE(a.outstanding_balance, (0)::numeric), (0)::numeric) - LEAST(GREATEST((COALESCE(a.access_fee, (0)::numeric) - COALESCE(a.access_fee_collected, (0)::numeric)), (0)::numeric), GREATEST(COALESCE(a.outstanding_balance, (0)::numeric), (0)::numeric))), (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'agent'::text AS category_key,
    'Agent Products & Services'::text AS category_label,
    'agent_advance_access_fee'::text AS product_key,
    'Agent Advance Access Fees'::text AS product_label,
    'agent_advances.access_fee'::text AS source_table,
    a.id AS item_id,
    a.agent_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown agent'::text) AS counterparty_name,
    LEAST(GREATEST((COALESCE(a.access_fee, (0)::numeric) - COALESCE(a.access_fee_collected, (0)::numeric)), (0)::numeric), GREATEST(COALESCE(a.outstanding_balance, (0)::numeric), (0)::numeric)) AS outstanding_amount,
    (a.expires_at)::date AS due_date,
    'scheduled'::text AS due_kind,
    0 AS daily_amount,
    COALESCE(a.access_fee_status, a.status) AS status,
    a.created_at
   FROM (agent_advances a
     LEFT JOIN profiles p ON ((p.id = a.agent_id)))
  WHERE ((a.status = ANY (ARRAY['active'::text, 'overdue'::text])) AND (LEAST(GREATEST((COALESCE(a.access_fee, (0)::numeric) - COALESCE(a.access_fee_collected, (0)::numeric)), (0)::numeric), GREATEST(COALESCE(a.outstanding_balance, (0)::numeric), (0)::numeric)) > (0)::numeric))
UNION ALL
 SELECT 'agent'::text AS category_key,
    'Agent Products & Services'::text AS category_label,
    'credit_access_draw'::text AS product_key,
    'Credit Access Draws'::text AS product_label,
    'credit_access_draws'::text AS source_table,
    d.id AS item_id,
    COALESCE(d.agent_id, d.user_id) AS counterparty_id,
    COALESCE(p.full_name, 'Unknown borrower'::text) AS counterparty_name,
    GREATEST(COALESCE(d.outstanding_balance, (0)::numeric), (0)::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    COALESCE(NULLIF(d.daily_charge, (0)::numeric), (0)::numeric) AS daily_amount,
    d.status,
    d.created_at
   FROM (credit_access_draws d
     LEFT JOIN profiles p ON ((p.id = COALESCE(d.agent_id, d.user_id))))
  WHERE ((d.status = ANY (ARRAY['active'::text, 'overdue'::text])) AND (COALESCE(d.outstanding_balance, (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'agent'::text AS category_key,
    'Agent Products & Services'::text AS category_label,
    'bike_recovery'::text AS product_key,
    'Bike Recoveries'::text AS product_label,
    'merchandise_recovery_plans'::text AS source_table,
    r.id AS item_id,
    r.customer_id AS counterparty_id,
    COALESCE(NULLIF(r.customer_name, ''::text), p.full_name, 'Unknown customer'::text) AS counterparty_name,
    GREATEST(COALESCE(r.outstanding_balance, (0)::numeric), (0)::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    COALESCE(NULLIF(r.daily_deduction_amount, (0)::numeric), NULLIF(r.daily_rate, (0)::numeric), (0)::numeric) AS daily_amount,
    r.status,
    r.created_at
   FROM (merchandise_recovery_plans r
     LEFT JOIN profiles p ON ((p.id = r.customer_id)))
  WHERE ((r.status = 'active'::text) AND (COALESCE(r.outstanding_balance, (0)::numeric) > (0)::numeric) AND merchandise_plan_recovery_eligible(r.id) AND ((lower(r.item_name) ~~ '%spiro%'::text) OR (lower(r.item_name) ~~ '%bike%'::text)))
UNION ALL
 SELECT 'agent'::text AS category_key,
    'Agent Products & Services'::text AS category_label,
    'merchandise_recovery'::text AS product_key,
    'Merchandise & Smartphone Recovery'::text AS product_label,
    'merchandise_recovery_plans'::text AS source_table,
    r.id AS item_id,
    r.customer_id AS counterparty_id,
    COALESCE(NULLIF(r.customer_name, ''::text), p.full_name, 'Unknown customer'::text) AS counterparty_name,
    GREATEST(COALESCE(r.outstanding_balance, (0)::numeric), (0)::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    COALESCE(NULLIF(r.daily_deduction_amount, (0)::numeric), NULLIF(r.daily_rate, (0)::numeric), (0)::numeric) AS daily_amount,
    r.status,
    r.created_at
   FROM (merchandise_recovery_plans r
     LEFT JOIN profiles p ON ((p.id = r.customer_id)))
  WHERE ((r.status = 'active'::text) AND (COALESCE(r.outstanding_balance, (0)::numeric) > (0)::numeric) AND merchandise_plan_recovery_eligible(r.id) AND (NOT ((lower(r.item_name) ~~ '%spiro%'::text) OR (lower(r.item_name) ~~ '%bike%'::text))))
UNION ALL
 SELECT 'agent'::text AS category_key,
    'Agent Products & Services'::text AS category_label,
    'merchandise_credit_sale'::text AS product_key,
    'Merchandise Credit Sales'::text AS product_label,
    'merchandise_sales'::text AS source_table,
    s.id AS item_id,
    s.customer_id AS counterparty_id,
    COALESCE(NULLIF(s.client_name, ''::text), p.full_name, 'Unknown customer'::text) AS counterparty_name,
    GREATEST(COALESCE(s.amount_outstanding, (0)::numeric), (0)::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    COALESCE(NULLIF(s.access_daily_amount, (0)::numeric), (0)::numeric) AS daily_amount,
    s.payment_status AS status,
    s.created_at
   FROM (merchandise_sales s
     LEFT JOIN profiles p ON ((p.id = s.customer_id)))
  WHERE ((COALESCE(s.amount_outstanding, (0)::numeric) > (0)::numeric) AND merchandise_sale_recognition_eligible(s.id) AND (COALESCE(s.payment_status, ''::text) <> 'paid'::text) AND (NOT (EXISTS ( SELECT 1
           FROM merchandise_recovery_plans rp
          WHERE ((rp.sale_id = s.id) AND (rp.status = 'active'::text))))))
UNION ALL
 SELECT 'tenant'::text AS category_key,
    'Tenant Products & Services'::text AS category_label,
    'service_centre_advance'::text AS product_key,
    'Service Centre Advances'::text AS product_label,
    'service_centre_advances'::text AS source_table,
    sa.id AS item_id,
    sa.agent_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown agent'::text) AS counterparty_name,
    GREATEST((COALESCE(sa.principal_amount, (0)::numeric) - COALESCE(sa.amount_recovered, (0)::numeric)), (0)::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    COALESCE(NULLIF(sa.daily_deduction, (0)::numeric), (0)::numeric) AS daily_amount,
    sa.status,
    sa.created_at
   FROM (service_centre_advances sa
     LEFT JOIN profiles p ON ((p.id = sa.agent_id)))
  WHERE ((sa.status = 'active'::text) AND (GREATEST((COALESCE(sa.principal_amount, (0)::numeric) - COALESCE(sa.amount_recovered, (0)::numeric)), (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'tenant'::text AS category_key,
    'Tenant Products & Services'::text AS category_label,
    'service_centre_receivable'::text AS product_key,
    'Service Centre Receivables'::text AS product_label,
    'service_centre_receivables'::text AS source_table,
    r.id AS item_id,
    r.service_centre_id AS counterparty_id,
    COALESCE(NULLIF(s.location_name, ''::text), ('Service centre '::text || (r.service_centre_id)::text)) AS counterparty_name,
    GREATEST(COALESCE(r.recoverable_amount, (0)::numeric), (0)::numeric) AS outstanding_amount,
    r.start_date AS due_date,
    'scheduled'::text AS due_kind,
    COALESCE(NULLIF(r.daily_amount, (0)::numeric), (0)::numeric) AS daily_amount,
    r.status,
    r.created_at
   FROM (service_centre_receivables r
     LEFT JOIN service_centre_setups s ON ((s.id = r.service_centre_id)))
  WHERE ((r.status = 'active'::text) AND (GREATEST(COALESCE(r.recoverable_amount, (0)::numeric), (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'tenant'::text AS category_key,
    'Tenant Products & Services'::text AS category_label,
    'rent_plan'::text AS product_key,
    'Rent Access Plans'::text AS product_label,
    'rent_requests'::text AS source_table,
    rr.id AS item_id,
    rr.tenant_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown tenant'::text) AS counterparty_name,
    GREATEST((COALESCE(NULLIF(rr.total_repayment, (0)::numeric), ((COALESCE(rr.rent_amount, (0)::numeric) + COALESCE(rr.access_fee, (0)::numeric)) + COALESCE(rr.request_fee, (0)::numeric))) - COALESCE(rr.amount_repaid, (0)::numeric)), (0)::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    COALESCE(NULLIF(rr.daily_repayment, (0)::numeric), (0)::numeric) AS daily_amount,
    rr.status,
    rr.created_at
   FROM (rent_requests rr
     LEFT JOIN profiles p ON ((p.id = rr.tenant_id)))
  WHERE ((rr.status = ANY (ARRAY['funded'::text, 'disbursed'::text, 'repaying'::text])) AND (GREATEST((COALESCE(NULLIF(rr.total_repayment, (0)::numeric), ((COALESCE(rr.rent_amount, (0)::numeric) + COALESCE(rr.access_fee, (0)::numeric)) + COALESCE(rr.request_fee, (0)::numeric))) - COALESCE(rr.amount_repaid, (0)::numeric)), (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'tenant'::text AS category_key,
    'Tenant Products & Services'::text AS category_label,
    'tenant_service_charge'::text AS product_key,
    'Tenant Service Charges'::text AS product_label,
    'subscription_charges'::text AS source_table,
    sc.id AS item_id,
    sc.tenant_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown tenant'::text) AS counterparty_name,
    GREATEST(COALESCE(sc.accumulated_debt, (0)::numeric), (0)::numeric) AS outstanding_amount,
    sc.next_charge_date AS due_date,
    'scheduled'::text AS due_kind,
    0 AS daily_amount,
    sc.status,
    sc.created_at
   FROM (subscription_charges sc
     LEFT JOIN profiles p ON ((p.id = sc.tenant_id)))
  WHERE ((sc.status = 'active'::text) AND (COALESCE(sc.accumulated_debt, (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'tenant'::text AS category_key,
    'Tenant Products & Services'::text AS category_label,
    'business_advance'::text AS product_key,
    'Business Advances'::text AS product_label,
    'business_advances'::text AS source_table,
    ba.id AS item_id,
    ba.tenant_id AS counterparty_id,
    COALESCE(p.full_name, NULLIF(ba.business_name, ''::text), 'Unknown business'::text) AS counterparty_name,
    GREATEST(COALESCE(ba.outstanding_balance, (0)::numeric), (0)::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    round((GREATEST(COALESCE(ba.outstanding_balance, (0)::numeric), (0)::numeric) * COALESCE(ba.daily_rate, (0)::numeric)), 2) AS daily_amount,
    (ba.status)::text AS status,
    ba.created_at
   FROM (business_advances ba
     LEFT JOIN profiles p ON ((p.id = ba.tenant_id)))
  WHERE (((ba.status)::text = ANY (ARRAY['active'::text, 'defaulted'::text])) AND (COALESCE(ba.outstanding_balance, (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'landlord'::text AS category_key,
    'Landlord Products & Services'::text AS category_label,
    'welile_homes'::text AS product_key,
    'Welile Homes Subscriptions'::text AS product_label,
    'welile_homes_subscriptions'::text AS source_table,
    w.id AS item_id,
    w.landlord_id AS counterparty_id,
    COALESCE(NULLIF(w.landlord_name, ''::text), p.full_name, 'Unknown landlord'::text) AS counterparty_name,
    GREATEST(COALESCE(w.outstanding_balance, (0)::numeric), (0)::numeric) AS outstanding_amount,
    w.next_due_date AS due_date,
    'scheduled'::text AS due_kind,
    0 AS daily_amount,
    w.subscription_status AS status,
    w.created_at
   FROM (welile_homes_subscriptions w
     LEFT JOIN profiles p ON ((p.id = w.landlord_id)))
  WHERE (COALESCE(w.outstanding_balance, (0)::numeric) > (0)::numeric)
UNION ALL
 SELECT 'landlord'::text AS category_key,
    'Landlord Products & Services'::text AS category_label,
    'landlord_float_receivable'::text AS product_key,
    'Landlord Float Receivables'::text AS product_label,
    'landlord_float_receivables'::text AS source_table,
    lfr.id AS item_id,
    lfr.landlord_id AS counterparty_id,
    COALESCE(NULLIF(lfr.landlord_name, ''::text), p.full_name, 'Unknown landlord'::text) AS counterparty_name,
    GREATEST(COALESCE(lfr.amount, (0)::numeric), (0)::numeric) AS outstanding_amount,
    lfr.promised_deposit_date AS due_date,
    'scheduled'::text AS due_kind,
    0 AS daily_amount,
    lfr.status,
    lfr.created_at
   FROM (landlord_float_receivables lfr
     LEFT JOIN profiles p ON ((p.id = lfr.landlord_id)))
  WHERE ((COALESCE(lfr.amount, (0)::numeric) > (0)::numeric) AND (COALESCE(lfr.status, ''::text) <> ALL (ARRAY['settled'::text, 'cancelled'::text])))
UNION ALL
 SELECT 'partner'::text AS category_key,
    'Partner Products & Services'::text AS category_label,
    'promissory_note'::text AS product_key,
    'Promissory Notes'::text AS product_label,
    'promissory_notes'::text AS source_table,
    n.id AS item_id,
    COALESCE(n.partner_user_id, n.agent_id) AS counterparty_id,
    COALESCE(NULLIF(n.partner_name, ''::text), 'Unknown partner'::text) AS counterparty_name,
    GREATEST((COALESCE(n.amount, (0)::numeric) - COALESCE(n.total_collected, (0)::numeric)), (0)::numeric) AS outstanding_amount,
    n.next_deduction_date AS due_date,
    'scheduled'::text AS due_kind,
    0 AS daily_amount,
    n.status,
    n.created_at
   FROM promissory_notes n
  WHERE ((n.status = 'activated'::text) AND (GREATEST((COALESCE(n.amount, (0)::numeric) - COALESCE(n.total_collected, (0)::numeric)), (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'other'::text AS category_key,
    'Unclassified / Other'::text AS category_label,
    'field_collection_pending'::text AS product_key,
    'Unconfirmed Field Collections'::text AS product_label,
    'field_collections'::text AS source_table,
    fc.id AS item_id,
    fc.agent_id AS counterparty_id,
    COALESCE(NULLIF(fc.tenant_name, ''::text), p.full_name, 'Unknown agent'::text) AS counterparty_name,
    GREATEST(COALESCE(fc.amount, (0)::numeric), (0)::numeric) AS outstanding_amount,
    (fc.captured_at)::date AS due_date,
    'scheduled'::text AS due_kind,
    0 AS daily_amount,
    fc.status,
    fc.created_at
   FROM (field_collections fc
     LEFT JOIN profiles p ON ((p.id = fc.agent_id)))
  WHERE ((fc.status = 'pending'::text) AND (COALESCE(fc.amount, (0)::numeric) > (0)::numeric));

CREATE OR REPLACE FUNCTION public.fin_run_daily_tieout(p_trigger text DEFAULT 'cron'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '15min'
AS $function$
DECLARE
  v_caller      uuid := auth.uid();
  v_run_as      uuid;
  v_prev_sub    text := current_setting('request.jwt.claim.sub', true);
  v_prev_role   text := current_setting('request.jwt.claim.role', true);
  v_prev_claims text := current_setting('request.jwt.claims', true);
  v_as_at       timestamptz := now();
  v_day         date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_day_start   timestamptz := ((now() AT TIME ZONE 'Africa/Kampala')::date)::timestamp AT TIME ZONE 'Africa/Kampala';
  v_bs          jsonb;
  v_cf          jsonb;
  v_err         text;
  v_assets      jsonb := '{}'::jsonb;
  v_prev        record;
  v_changes     jsonb := '[]'::jsonb;
  v_status      text;
  v_id          uuid;
BEGIN
  IF v_caller IS NOT NULL THEN
    -- a signed-in finance user runs it as themselves
    IF NOT public._fin_can_view() THEN RAISE EXCEPTION 'Not authorised to run the tie-out'; END IF;
    v_run_as := v_caller;
  ELSE
    SELECT run_as INTO v_run_as FROM public.fin_daily_tieout_settings WHERE id = 1;
    IF v_run_as IS NULL THEN RAISE EXCEPTION 'fin_daily_tieout_settings.run_as is not set'; END IF;
    PERFORM set_config('request.jwt.claim.sub', v_run_as::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claims',
      jsonb_build_object('sub', v_run_as::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  END IF;

  BEGIN
    v_bs := public.fin_balance_sheet(v_as_at);
  EXCEPTION WHEN OTHERS THEN
    v_err := 'Balance Sheet: ' || SQLERRM;
  END;
  BEGIN
    v_cf := public.fin_cash_flow(v_day_start, v_as_at);
  EXCEPTION WHEN OTHERS THEN
    v_err := concat_ws(' | ', v_err, 'Cash flow: ' || SQLERRM);
  END;

  IF v_caller IS NULL THEN
    PERFORM set_config('request.jwt.claim.sub', COALESCE(v_prev_sub, ''), true);
    PERFORM set_config('request.jwt.claim.role', COALESCE(v_prev_role, ''), true);
    PERFORM set_config('request.jwt.claims', COALESCE(v_prev_claims, ''), true);
  END IF;

  IF v_bs IS NOT NULL THEN
    SELECT COALESCE(jsonb_object_agg(substring(e->>'source' from 'account\s+([A-Z][0-9]+)\s*$'), (e->>'value')::numeric), '{}'::jsonb)
      INTO v_assets
      FROM jsonb_array_elements(COALESCE(v_bs->'assets'->'current', '[]'::jsonb) || COALESCE(v_bs->'assets'->'non_current', '[]'::jsonb)) e
     WHERE substring(e->>'source' from 'account\s+([A-Z][0-9]+)\s*$') IS NOT NULL;
  END IF;

  -- ties whose difference moved since the previous run
  SELECT * INTO v_prev FROM public.fin_daily_tieout
   WHERE run_date < v_day AND status <> 'failed' ORDER BY run_date DESC LIMIT 1;
  IF v_bs IS NOT NULL AND v_prev.id IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'key', t->>'key', 'label', t->>'label',
             'previous', (p->>'difference')::numeric, 'current', (t->>'difference')::numeric,
             'moved_by', round((t->>'difference')::numeric - COALESCE((p->>'difference')::numeric, 0)),
             'basis_previous', p->>'basis', 'basis_current', t->>'basis',
             'reason', CASE WHEN (p->>'basis') IS DISTINCT FROM (t->>'basis') THEN 'comparison basis changed'
                            ELSE 'difference moved' END)), '[]'::jsonb)
      INTO v_changes
      FROM jsonb_array_elements(COALESCE(v_bs->'subledger_ties', '[]'::jsonb)) t
      LEFT JOIN jsonb_array_elements(v_prev.ties) p ON p->>'key' = t->>'key'
     WHERE abs(round((t->>'difference')::numeric) - round(COALESCE((p->>'difference')::numeric, 0))) >= 1;
  END IF;

  v_status := CASE
    WHEN v_bs IS NULL OR v_cf IS NULL THEN 'failed'
    WHEN abs(COALESCE((v_bs->'balance_check'->>'difference')::numeric, 0)) >= 1
      OR abs(COALESCE((v_bs->'trial_balance'->>'difference')::numeric, 0)) >= 1
      OR COALESCE((v_cf->>'ties_to_balance_sheet')::boolean, false) = false
      OR jsonb_array_length(v_changes) > 0 THEN 'attention'
    ELSE 'ok' END;

  INSERT INTO public.fin_daily_tieout AS d (run_date, as_at, finished_at, status, trigger, run_as, total_assets,
      bs_difference, tb_difference, assets, ties, cash_flow, changes, error)
  VALUES (v_day, v_as_at, clock_timestamp(), v_status, COALESCE(p_trigger, 'cron'), v_run_as,
      (v_bs->'assets'->>'total')::numeric,
      (v_bs->'balance_check'->>'difference')::numeric,
      (v_bs->'trial_balance'->>'difference')::numeric,
      v_assets, COALESCE(v_bs->'subledger_ties', '[]'::jsonb),
      CASE WHEN v_cf IS NULL THEN NULL ELSE jsonb_build_object(
        'from', v_day_start, 'opening', v_cf->'opening_cash', 'closing', v_cf->'closing_cash',
        'balance_sheet_cash', v_cf->'balance_sheet_cash', 'ties', v_cf->'ties_to_balance_sheet',
        'unexplained', v_cf->'unexplained_difference') END,
      v_changes, v_err)
  ON CONFLICT (run_date) DO UPDATE SET
      as_at = EXCLUDED.as_at, started_at = clock_timestamp(), finished_at = EXCLUDED.finished_at, status = EXCLUDED.status,
      trigger = EXCLUDED.trigger, run_as = EXCLUDED.run_as, total_assets = EXCLUDED.total_assets,
      bs_difference = EXCLUDED.bs_difference, tb_difference = EXCLUDED.tb_difference, assets = EXCLUDED.assets,
      ties = EXCLUDED.ties, cash_flow = EXCLUDED.cash_flow, changes = EXCLUDED.changes, error = EXCLUDED.error
  RETURNING d.id INTO v_id;
  RETURN v_id;
END;
$function$;
