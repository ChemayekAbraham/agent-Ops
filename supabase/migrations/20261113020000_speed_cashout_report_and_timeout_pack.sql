-- Speed the merchant cashout daily report and raise the statement timeout on the
-- midnight edge-job and promissory staff reports (finance-pack precedent).
--
-- generate_merchant_cashout_daily_report scanned idx_gl_wallet_commission_created
-- once per candidate and discarded rows that were not a cashout source. Restricting
-- those source_id lookups to gl.source_table IN ('withdrawal_requests', 'ledger_transaction')
-- lets them use idx_general_ledger_source. Measured on 10 Nov 2026 (Africa/Kampala),
-- 99 candidates: 13,096 ms / 10.4M buffer hits -> 29 ms / 4.5k hits.
-- Historical rows: two telecom legs and two merchant legs are source_table
-- 'ledger_transaction'; every other cashout leg is 'withdrawal_requests'.
-- Classification and the jsonb shape are unchanged.
--
-- promissory_fuzzy_arrival_suggestions keeps the same matching rule (shared words >= 2,
-- then similarity), confidence buckets, jsonb keys and the NULL -> 1970-01-01 default.
-- It only gains statement_timeout = 120s and work_mem = 256MB (same work_mem as
-- sofp_ledger_legs). No rare-token filter.
--
-- get_promissory_ops_report, get_cto_daily_report and get_board_tech_memo are unchanged
-- except statement_timeout = 120s. get_cto_daily_report still writes db_stat_snapshots.
-- get_board_tech_memo still builds temp table _bm_sms. Both stay VOLATILE.
--
-- Each body is the live pg_get_functiondef, and each ends with $function$;.
-- Grants are the live EXECUTE list only (PUBLIC revoked; anon is not granted;
-- cashout and the CTO report are not granted to authenticated).
-- Not applied to production from this branch.

CREATE OR REPLACE FUNCTION public.generate_merchant_cashout_daily_report(p_date date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
WITH day_bounds AS (
  SELECT
    p_date::timestamp AT TIME ZONE 'Africa/Kampala' AS start_at,
    (p_date::timestamp + interval '1 day') AT TIME ZONE 'Africa/Kampala' AS end_at
),
-- Customer wallet debit legs posted inside the day
posted_wallet_payouts AS (
  SELECT
    gl.source_id AS withdrawal_id,
    SUM(gl.amount)::numeric AS principal,
    MIN(gl.transaction_date) AS ts
  FROM public.general_ledger gl
  CROSS JOIN day_bounds b
  WHERE gl.source_table = 'withdrawal_requests'
    AND gl.source_id IS NOT NULL
    AND gl.classification = 'production'
    AND gl.ledger_scope = 'wallet'
    AND gl.direction = 'cash_out'
    AND gl.category = 'wallet_withdrawal'
    AND gl.transaction_date >= b.start_at
    AND gl.transaction_date < b.end_at
  GROUP BY gl.source_id
),
-- Payout requests that BELONG to the day regardless of whether ledger legs exist
day_requests AS (
  SELECT wr.id AS withdrawal_id
  FROM public.withdrawal_requests wr
  CROSS JOIN day_bounds b
  WHERE wr.status IN ('paid','completed','disbursed','processing','failed','held','re_approved_for_recovery')
    AND COALESCE(wr.processed_at, wr.settlement_checked_at, wr.dispatch_claimed_at, wr.fin_ops_approved_at, wr.created_at) >= b.start_at
    AND COALESCE(wr.processed_at, wr.settlement_checked_at, wr.dispatch_claimed_at, wr.fin_ops_approved_at, wr.created_at) < b.end_at
),
candidates AS (
  SELECT withdrawal_id FROM posted_wallet_payouts
  UNION
  SELECT withdrawal_id FROM day_requests
),
comm AS (
  SELECT gl.source_id AS withdrawal_id, SUM(gl.amount)::numeric AS commission
  FROM public.general_ledger gl
  WHERE gl.source_id IN (SELECT withdrawal_id FROM candidates)
    AND gl.source_table IN ('withdrawal_requests', 'ledger_transaction')
    AND gl.reference_id LIKE '%-cashout-commission'
    AND gl.ledger_scope = 'wallet'
    AND gl.direction = 'cash_in'
    AND gl.category = 'agent_commission_earned'
  GROUP BY gl.source_id
),
telecom AS (
  SELECT gl.source_id AS withdrawal_id, SUM(gl.amount)::numeric AS telecom_charge
  FROM public.general_ledger gl
  WHERE gl.source_id IN (SELECT withdrawal_id FROM candidates)
    AND gl.source_table IN ('withdrawal_requests', 'ledger_transaction')
    AND gl.reference_id LIKE '%-merchant-telecom-charge'
    AND gl.ledger_scope = 'wallet'
    AND gl.direction = 'cash_out'
  GROUP BY gl.source_id
),
merchant_legs AS (
  SELECT gl.source_id AS withdrawal_id, SUM(gl.amount)::numeric AS merchant_principal
  FROM public.general_ledger gl
  WHERE gl.source_id IN (SELECT withdrawal_id FROM candidates)
    AND gl.source_table IN ('withdrawal_requests', 'ledger_transaction')
    AND (gl.reference_id LIKE '%-merchant-float-consume'
      OR gl.reference_id LIKE '%-merchant-reimbursement')
    AND gl.ledger_scope = 'wallet'
    AND gl.direction = 'cash_out'
  GROUP BY gl.source_id
),
-- Customer wallet debit ANY time (not only inside the day) -> settlement truth
customer_debit_any AS (
  SELECT gl.source_id AS withdrawal_id, SUM(gl.amount)::numeric AS principal, MIN(gl.transaction_date) AS ts
  FROM public.general_ledger gl
  WHERE gl.source_id IN (SELECT withdrawal_id FROM candidates)
    AND gl.source_table = 'withdrawal_requests'
    AND gl.ledger_scope = 'wallet'
    AND gl.direction = 'cash_out'
    AND gl.category = 'wallet_withdrawal'
  GROUP BY gl.source_id
),
replayed AS (
  SELECT DISTINCT withdrawal_id
  FROM public.withdrawal_settlement_replay_audit
  WHERE dry_run IS NOT TRUE AND ok IS TRUE
),
payouts AS (
  SELECT
    COALESCE(
      ca.agent_id,
      wr.assigned_cashout_agent_id,
      wr.dispatch_claimed_by,
      wr.fin_ops_approved_by,
      wr.processed_by,
      merchant_comm_agent.agent_id,
      merchant_float_agent.agent_id
    ) AS agent_id,
    k.withdrawal_id,
    COALESCE(pwp.ts, cda.ts, wr.processed_at, wr.created_at) AS ts,
    COALESCE(pwp.principal, cda.principal, ml.merchant_principal, wr.amount, 0)::numeric AS principal,
    COALESCE(c.commission, 0)::numeric AS commission,
    COALESCE(t.telecom_charge, 0)::numeric AS telecom_charge,
    wr.user_id AS customer_id,
    wr.payout_method,
    wr.reason AS wr_reason,
    wr.landlord_payout_id,
    wr.proxy_partner_id,
    wr.status AS wr_status,
    COALESCE(wr.settlement_state, 'pending') AS settlement_state,
    COALESCE(wr.settlement_missing_legs, '[]'::jsonb) AS missing_legs,
    (cda.withdrawal_id IS NOT NULL) AS has_customer_debit,
    (wr.id IS NULL) AS orphan_ledger,
    (r.withdrawal_id IS NOT NULL) AS was_replayed
  FROM candidates k
  LEFT JOIN posted_wallet_payouts pwp ON pwp.withdrawal_id = k.withdrawal_id
  LEFT JOIN public.withdrawal_requests wr ON wr.id = k.withdrawal_id
  LEFT JOIN public.cashout_agents ca ON ca.id = wr.assigned_cashout_agent_id
  LEFT JOIN comm c ON c.withdrawal_id = k.withdrawal_id
  LEFT JOIN telecom t ON t.withdrawal_id = k.withdrawal_id
  LEFT JOIN merchant_legs ml ON ml.withdrawal_id = k.withdrawal_id
  LEFT JOIN customer_debit_any cda ON cda.withdrawal_id = k.withdrawal_id
  LEFT JOIN replayed r ON r.withdrawal_id = k.withdrawal_id
  LEFT JOIN LATERAL (
    SELECT gl.user_id AS agent_id
    FROM public.general_ledger gl
    WHERE gl.source_id = k.withdrawal_id
      AND gl.source_table IN ('withdrawal_requests', 'ledger_transaction')
      AND gl.reference_id LIKE '%-cashout-commission'
      AND gl.ledger_scope = 'wallet'
      AND gl.direction = 'cash_in'
      AND gl.category = 'agent_commission_earned'
      AND gl.user_id IS NOT NULL
    ORDER BY gl.transaction_date ASC
    LIMIT 1
  ) merchant_comm_agent ON true
  LEFT JOIN LATERAL (
    SELECT gl.user_id AS agent_id
    FROM public.general_ledger gl
    WHERE gl.source_id = k.withdrawal_id
      AND gl.source_table IN ('withdrawal_requests', 'ledger_transaction')
      AND (gl.reference_id LIKE '%-merchant-float-consume'
        OR gl.reference_id LIKE '%-merchant-reimbursement'
        OR gl.reference_id LIKE '%-merchant-telecom-charge')
      AND gl.ledger_scope = 'wallet'
      AND gl.direction = 'cash_out'
      AND gl.user_id IS NOT NULL
    ORDER BY gl.transaction_date ASC
    LIMIT 1
  ) merchant_float_agent ON true
),
classified AS (
  SELECT
    po.*,
    CASE
      WHEN po.orphan_ledger THEN 'exception'
      WHEN po.wr_status IN ('failed','held')
        OR (po.wr_status = 'processing' AND po.settlement_state = 'unsettled')
        THEN 'failed'
      WHEN po.settlement_state = 'settled' AND po.was_replayed THEN 'reconciled'
      WHEN po.settlement_state = 'settled'
        AND jsonb_array_length(po.missing_legs) = 0
        AND po.has_customer_debit
        THEN 'fully_settled'
      WHEN po.wr_status IN ('paid','completed','disbursed') AND NOT po.has_customer_debit
        THEN 'unsettled'
      WHEN po.settlement_state = 'unsettled'
        AND jsonb_array_length(po.missing_legs) >= 3
        THEN 'unsettled'
      WHEN po.has_customer_debit
        AND (po.settlement_state <> 'settled' OR jsonb_array_length(po.missing_legs) > 0)
        THEN 'partially_settled'
      WHEN po.wr_status = 'processing' THEN 'failed'
      ELSE 'exception'
    END AS settlement_status
  FROM payouts po
),
enriched AS (
  SELECT
    cl.*,
    (cl.principal + cl.telecom_charge) AS float_consumed,
    (cl.settlement_status IN ('fully_settled','reconciled')) AS is_clean,
    COALESCE(mp.full_name, mp2.full_name, ca2.label, 'Unknown agent') AS merchant_name,
    COALESCE(mp.phone, mp2.phone) AS merchant_phone,
    cp.full_name AS customer_name,
    CASE
      WHEN cl.proxy_partner_id IS NOT NULL
        OR cl.wr_reason ILIKE '%Portfolio:%'
        OR LOWER(COALESCE(cl.wr_reason,'')) ~ '(proxy|roi|return)'
        THEN 'proxy_partner_withdrawal'
      WHEN cl.landlord_payout_id IS NOT NULL
        OR LOWER(COALESCE(cl.wr_reason,'')) LIKE 'landlord float payout%'
        THEN 'landlord_payouts'
      WHEN LOWER(COALESCE(cl.wr_reason,'')) ~ '(salary|payroll)'
        THEN 'payroll_payments'
      WHEN LOWER(COALESCE(cl.wr_reason,'')) LIKE '%commission%'
        THEN 'agent_commissions'
      ELSE 'wallet_withdrawals'
    END AS category_id
  FROM classified cl
  LEFT JOIN public.profiles mp ON mp.id = cl.agent_id
  LEFT JOIN public.cashout_agents ca2 ON ca2.id = cl.agent_id
  LEFT JOIN public.profiles mp2 ON mp2.id = ca2.agent_id
  LEFT JOIN public.profiles cp ON cp.id = cl.customer_id
),
summary AS (
  SELECT
    agent_id,
    COALESCE(MAX(merchant_name), 'Unknown agent') AS merchant_name,
    MAX(merchant_phone) AS merchant_phone,
    COUNT(*) FILTER (WHERE is_clean) AS payouts,
    SUM(principal) FILTER (WHERE is_clean) AS total_paid,
    SUM(commission) FILTER (WHERE is_clean) AS total_commission,
    SUM(telecom_charge) FILTER (WHERE is_clean) AS total_telecom,
    SUM(principal + telecom_charge) FILTER (WHERE is_clean) AS total_float_consumed,
    COUNT(*) FILTER (WHERE NOT is_clean) AS unresolved_payouts,
    SUM(principal) FILTER (WHERE NOT is_clean) AS unresolved_amount
  FROM enriched
  GROUP BY agent_id
),
by_cat AS (
  SELECT
    category_id,
    COUNT(DISTINCT agent_id) AS merchant_count,
    COUNT(*) FILTER (WHERE is_clean) AS payouts,
    SUM(principal) FILTER (WHERE is_clean) AS total_paid,
    SUM(commission) FILTER (WHERE is_clean) AS total_commission,
    SUM(telecom_charge) FILTER (WHERE is_clean) AS total_telecom,
    SUM(principal + telecom_charge) FILTER (WHERE is_clean) AS total_float_consumed,
    COUNT(*) FILTER (WHERE NOT is_clean) AS unresolved_payouts,
    SUM(principal) FILTER (WHERE NOT is_clean) AS unresolved_amount
  FROM enriched
  GROUP BY category_id
),
cat_labeled AS (
  SELECT
    category_id,
    CASE category_id
      WHEN 'proxy_partner_withdrawal' THEN 'Partner Withdrawal (Proxy Initiated)'
      WHEN 'landlord_payouts' THEN 'Landlord Payouts'
      WHEN 'payroll_payments' THEN 'Payroll Payments'
      WHEN 'agent_commissions' THEN 'Agent Commissions'
      WHEN 'wallet_withdrawals' THEN 'Wallet Withdrawals'
      ELSE category_id
    END AS category_label,
    merchant_count, payouts, total_paid, total_commission, total_telecom,
    total_float_consumed, unresolved_payouts, unresolved_amount
  FROM by_cat
),
by_status AS (
  SELECT
    settlement_status,
    CASE settlement_status
      WHEN 'fully_settled' THEN 'Fully settled'
      WHEN 'partially_settled' THEN 'Partially settled'
      WHEN 'unsettled' THEN 'Unsettled'
      WHEN 'failed' THEN 'Failed'
      WHEN 'reconciled' THEN 'Reconciled'
      ELSE 'Exception'
    END AS status_label,
    COUNT(*) AS payouts,
    SUM(principal) AS total_amount,
    SUM(commission) AS total_commission,
    SUM(telecom_charge) AS total_telecom
  FROM enriched
  GROUP BY settlement_status
)
SELECT jsonb_build_object(
  'date', p_date,
  'merchant_count', (SELECT COUNT(*) FROM summary WHERE payouts > 0),
  'total_payouts', (SELECT COALESCE(SUM(payouts), 0) FROM summary),
  'total_paid', (SELECT COALESCE(SUM(total_paid), 0) FROM summary),
  'total_commission', (SELECT COALESCE(SUM(total_commission), 0) FROM summary),
  'total_telecom', (SELECT COALESCE(SUM(total_telecom), 0) FROM summary),
  'total_float_consumed', (SELECT COALESCE(SUM(total_float_consumed), 0) FROM summary),
  'total_candidates', (SELECT COUNT(*) FROM enriched),
  'unresolved_payouts', (SELECT COUNT(*) FROM enriched WHERE NOT is_clean),
  'unresolved_amount', (SELECT COALESCE(SUM(principal), 0) FROM enriched WHERE NOT is_clean),
  'settlement_totals', (
    SELECT jsonb_object_agg(settlement_status, jsonb_build_object(
      'label', status_label,
      'payouts', payouts,
      'total_amount', total_amount
    ))
    FROM by_status
  ),
  'by_settlement_status', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'settlement_status', settlement_status,
      'status_label', status_label,
      'payouts', payouts,
      'total_amount', total_amount,
      'total_commission', total_commission,
      'total_telecom', total_telecom
    ) ORDER BY payouts DESC)
    FROM by_status
  ), '[]'::jsonb),
  'summary', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'agent_id', agent_id,
      'merchant_name', merchant_name,
      'merchant_phone', merchant_phone,
      'payouts', payouts,
      'total_paid', total_paid,
      'total_commission', total_commission,
      'total_telecom', total_telecom,
      'total_float_consumed', total_float_consumed,
      'unresolved_payouts', unresolved_payouts,
      'unresolved_amount', unresolved_amount
    ) ORDER BY total_paid DESC NULLS LAST)
    FROM summary
  ), '[]'::jsonb),
  'by_category', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'category_id', category_id,
      'category_label', category_label,
      'merchant_count', merchant_count,
      'payouts', payouts,
      'total_paid', total_paid,
      'total_commission', total_commission,
      'total_telecom', total_telecom,
      'total_float_consumed', total_float_consumed,
      'unresolved_payouts', unresolved_payouts,
      'unresolved_amount', unresolved_amount
    ) ORDER BY total_paid DESC NULLS LAST)
    FROM cat_labeled
  ), '[]'::jsonb),
  'detail', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'time', to_char(ts AT TIME ZONE 'Africa/Kampala', 'HH24:MI'),
      'merchant_name', merchant_name,
      'merchant_phone', merchant_phone,
      'customer_name', customer_name,
      'amount', principal,
      'commission', commission,
      'telecom_charge', telecom_charge,
      'float_consumed', float_consumed,
      'payout_method', payout_method,
      'category_id', category_id,
      'withdrawal_id', withdrawal_id,
      'settlement_status', settlement_status,
      'request_status', wr_status,
      'settlement_state', settlement_state,
      'missing_legs', missing_legs,
      'has_customer_debit', has_customer_debit
    ) ORDER BY ts ASC, withdrawal_id ASC)
    FROM enriched
  ), '[]'::jsonb),
  'exceptions', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'withdrawal_id', withdrawal_id,
      'merchant_name', merchant_name,
      'customer_name', customer_name,
      'amount', principal,
      'settlement_status', settlement_status,
      'request_status', wr_status,
      'settlement_state', settlement_state,
      'missing_legs', missing_legs,
      'has_customer_debit', has_customer_debit
    ) ORDER BY principal DESC NULLS LAST)
    FROM enriched
    WHERE NOT is_clean
  ), '[]'::jsonb)
)
$function$;

REVOKE ALL ON FUNCTION public.generate_merchant_cashout_daily_report(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_merchant_cashout_daily_report(date) TO postgres, service_role;

CREATE OR REPLACE FUNCTION public.promissory_fuzzy_arrival_suggestions(p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp', 'extensions'
 SET statement_timeout TO '120s'
 SET work_mem TO '256MB'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_from timestamptz := coalesce(p_from, '1970-01-01'::timestamptz);
  v_to timestamptz := coalesce(p_to, now() + interval '1 day');
  v_rate_creation numeric := public.promissory_commission_rate('portfolio_creation');
  v_result jsonb;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not (
    public.is_ops_role(v_uid)
    or public.has_role(v_uid, 'ceo') or public.has_role(v_uid, 'coo')
    or public.has_role(v_uid, 'cfo') or public.has_role(v_uid, 'manager')
    or public.has_role(v_uid, 'super_admin') or public.has_role(v_uid, 'partner_ops')
  ) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  with pf as materialized (
    select p.id, p.full_name, p.phone, p.created_at,
           lower(regexp_replace(btrim(p.full_name), '\s+', ' ', 'g')) as nmk,
           nullif(right(regexp_replace(coalesce(p.phone,''), '\D', '', 'g'), 9), '') as pk,
           nullif(lower(btrim(coalesce(p.email,''))), '') as em
    from public.profiles p
    where p.full_name is not null and length(btrim(p.full_name)) >= 5
  ),
  notes as materialized (
    select n.id, n.partner_name, n.created_at,
           nullif(right(regexp_replace(coalesce(n.whatsapp_number,''), '\D', '', 'g'), 9), '') as k1,
           nullif(right(regexp_replace(coalesce(n.phone_number,''), '\D', '', 'g'), 9), '') as k2,
           nullif(lower(btrim(coalesce(n.email,''))), '') as em,
           lower(regexp_replace(btrim(coalesce(n.partner_name,'')), '\s+', ' ', 'g')) as nmk
    from public.promissory_notes n
    where n.created_at >= v_from and n.created_at < v_to
      and (
        n.partner_user_id is null
        or not exists (select 1 from public.profiles pr where pr.id = n.partner_user_id)
      )
      and length(btrim(coalesce(n.partner_name,''))) >= 5
  ),
  resolved as materialized (
    select distinct nt.id from notes nt join pf p on p.pk = nt.k1 where nt.k1 is not null
    union
    select distinct nt.id from notes nt join pf p on p.pk = nt.k2 where nt.k2 is not null
    union
    select distinct nt.id from notes nt join pf p on p.em = nt.em where nt.em is not null
    union
    select distinct nt.id from notes nt join pf p on p.nmk = nt.nmk
  ),
  unresolved as materialized (
    select nt.* from notes nt
    where not exists (select 1 from resolved r where r.id = nt.id)
  ),
  ntok as materialized (
    select u.id as note_id, t from unresolved u, lateral unnest(string_to_array(u.nmk, ' ')) t
    where length(t) >= 3
  ),
  ptok as materialized (
    select p.id, t from pf p, lateral unnest(string_to_array(p.nmk, ' ')) t
    where length(t) >= 3
  ),
  pairs as materialized (
    select nt.note_id, pt.id as cand, count(distinct nt.t) as shared
    from ntok nt join ptok pt on pt.t = nt.t
    group by 1, 2
    having count(distinct nt.t) >= 2
  ),
  scored as materialized (
    select pr.note_id, pr.shared,
           u.partner_name, u.nmk as note_nmk, u.created_at as note_created_at,
           p.id as candidate_user_id, p.full_name as candidate_name,
           p.phone as candidate_phone, p.em as candidate_email, p.created_at as candidate_created_at,
           similarity(p.nmk, u.nmk) as score
    from pairs pr
    join unresolved u on u.id = pr.note_id
    join pf p on p.id = pr.cand
  ),
  prin as materialized (
    select ip.investor_id,
           count(*)::int as portfolio_count,
           coalesce(sum(ip.investment_amount), 0) as portfolio_amount,
           coalesce(sum(ip.investment_amount) filter (where ip.status = 'active'), 0) as active_amount
    from public.investor_portfolios ip
    where ip.investor_id in (select distinct candidate_user_id from scored)
    group by ip.investor_id
  ),
  ranked as (
    select s.*,
           coalesce(pn.portfolio_count, 0) as portfolio_count,
           coalesce(pn.portfolio_amount, 0) as portfolio_amount,
           coalesce(pn.active_amount, 0) as portfolio_active_amount,
           row_number() over (partition by s.note_id order by s.shared desc, s.score desc, s.candidate_created_at asc) as rn,
           count(*) over (partition by s.note_id) as candidate_count
    from scored s
    left join prin pn on pn.investor_id = s.candidate_user_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'note_id', r.note_id,
           'partner_name', r.partner_name,
           'note_created_at', r.note_created_at,
           'candidate_user_id', r.candidate_user_id,
           'candidate_name', r.candidate_name,
           'candidate_phone', r.candidate_phone,
           'candidate_email', r.candidate_email,
           'candidate_created_at', r.candidate_created_at,
           'shared_words', r.shared,
           'similarity', round(r.score::numeric, 3),
           'candidate_count', r.candidate_count,
           'rank', r.rn,
           'candidate_portfolio_count', r.portfolio_count,
           'candidate_principal', r.portfolio_amount,
           'candidate_principal_active', r.portfolio_active_amount,
           'commission_rate', v_rate_creation,
           'commission_due', round(r.portfolio_amount * v_rate_creation),
           'confidence', case
                           when r.shared >= 3 or r.score >= 0.8 then 'high'
                           when r.score >= 0.6 then 'medium'
                           else 'low'
                         end
         ) order by r.shared desc, r.score desc), '[]'::jsonb)
    into v_result
  from ranked r
  where r.rn <= 3;

  return jsonb_build_object('suggestions', v_result, 'rate_creation', v_rate_creation, 'generated_at', now());
end;
$function$;

REVOKE ALL ON FUNCTION public.promissory_fuzzy_arrival_suggestions(timestamp with time zone, timestamp with time zone) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.promissory_fuzzy_arrival_suggestions(timestamp with time zone, timestamp with time zone) TO authenticated, postgres, service_role;

CREATE OR REPLACE FUNCTION public.get_promissory_ops_report(p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_from timestamptz := COALESCE(p_from, '1970-01-01'::timestamptz);
  v_to timestamptz := COALESCE(p_to, now() + interval '1 day');
  v_result jsonb;
  v_rate_creation numeric := public.promissory_commission_rate('portfolio_creation');
  v_rate_topup numeric := public.promissory_commission_rate('portfolio_topup');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT (
    public.is_ops_role(v_uid)
    OR public.has_role(v_uid, 'ceo') OR public.has_role(v_uid, 'coo')
    OR public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'manager')
    OR public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'partner_ops')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  WITH nb AS MATERIALIZED (
    SELECT n.*,
      right(regexp_replace(coalesce(n.whatsapp_number,''), '\D', '', 'g'), 9) AS k1,
      right(regexp_replace(coalesce(n.phone_number,''), '\D', '', 'g'), 9) AS k2,
      nullif(lower(trim(coalesce(n.email,''))), '') AS em,
      nullif(lower(regexp_replace(trim(coalesce(n.partner_name,'')), '\s+', ' ', 'g')), '') AS nmk
    FROM promissory_notes n
    WHERE n.created_at >= v_from AND n.created_at < v_to
  ),
  keys AS MATERIALIZED (
    SELECT DISTINCT k FROM (
      SELECT k1 AS k FROM nb UNION SELECT k2 FROM nb
    ) s WHERE length(k) = 9
  ),
  emails AS MATERIALIZED (
    SELECT DISTINCT em FROM nb WHERE em IS NOT NULL
  ),
  names AS MATERIALIZED (
    SELECT DISTINCT nmk FROM nb WHERE nmk IS NOT NULL AND length(nmk) >= 5
  ),
  ids AS MATERIALIZED (
    SELECT DISTINCT partner_user_id AS id FROM nb WHERE partner_user_id IS NOT NULL
  ),
  cand_phone AS MATERIALIZED (
    SELECT p.id, p.full_name, p.created_at,
           right(regexp_replace(p.phone, '\D', '', 'g'), 9) AS pk
    FROM profiles p
    WHERE right(regexp_replace(p.phone, '\D', '', 'g'), 9) IN (SELECT k FROM keys)
  ),
  cand_email AS MATERIALIZED (
    SELECT p.id, p.full_name, p.created_at, lower(trim(p.email)) AS pem
    FROM profiles p
    WHERE lower(trim(p.email)) IN (SELECT em FROM emails)
  ),
  cand_id AS MATERIALIZED (
    SELECT p.id, p.full_name, p.created_at
    FROM profiles p
    WHERE p.id IN (SELECT id FROM ids)
  ),
  by_phone AS (
    SELECT DISTINCT ON (pk) pk, id, full_name, created_at
    FROM cand_phone ORDER BY pk, created_at ASC
  ),
  cand_name AS MATERIALIZED (
    SELECT p.id, p.full_name, p.created_at,
           lower(regexp_replace(trim(p.full_name), '\s+', ' ', 'g')) AS pnm
    FROM profiles p
    WHERE p.full_name IS NOT NULL
      AND lower(regexp_replace(trim(p.full_name), '\s+', ' ', 'g')) IN (SELECT nmk FROM names)
  ),
  by_name AS (
    SELECT pnm,
           (array_agg(id ORDER BY created_at ASC))[1] AS id,
           (array_agg(full_name ORDER BY created_at ASC))[1] AS full_name,
           min(created_at) AS created_at
    FROM cand_name
    GROUP BY pnm
    HAVING count(*) = 1
  ),
  by_email AS (
    SELECT DISTINCT ON (pem) pem, id, full_name, created_at
    FROM cand_email ORDER BY pem, created_at ASC
  ),
  lead_map AS (
    SELECT DISTINCT ON (pla.agent_id) pla.agent_id, pr.full_name
    FROM partner_lead_assignments pla
    JOIN profiles pr ON pr.id = pla.lead_user_id
    WHERE pla.detached_at IS NULL
    ORDER BY pla.agent_id, pla.attached_at DESC
  ),
  matched AS MATERIALIZED (
    SELECT nb.*,
      ag.full_name AS agent_name, ag.phone AS agent_phone,
      COALESCE(bi.id, bk1.id, bk2.id, be.id, bn.id) AS came_in_user_id,
      CASE
        WHEN bi.id IS NOT NULL THEN bi.full_name
        WHEN bk1.id IS NOT NULL THEN bk1.full_name
        WHEN bk2.id IS NOT NULL THEN bk2.full_name
        WHEN be.id IS NOT NULL THEN be.full_name
        ELSE bn.full_name
      END AS came_in_name,
      CASE
        WHEN bi.id IS NOT NULL THEN bi.created_at
        WHEN bk1.id IS NOT NULL THEN bk1.created_at
        WHEN bk2.id IS NOT NULL THEN bk2.created_at
        WHEN be.id IS NOT NULL THEN be.created_at
        ELSE bn.created_at
      END AS came_in_at,
      CASE
        WHEN bk1.id IS NOT NULL THEN 'whatsapp_number'
        WHEN bk2.id IS NOT NULL THEN 'phone_number'
        WHEN be.id IS NOT NULL THEN 'email'
        WHEN bi.id IS NOT NULL THEN 'linked_account'
        WHEN bn.id IS NOT NULL THEN 'partner_name'
        ELSE NULL
      END AS came_in_match_basis,
      CASE
        WHEN bk1.id IS NOT NULL THEN nb.whatsapp_number
        WHEN bk2.id IS NOT NULL THEN nb.phone_number
        WHEN be.id IS NOT NULL THEN nb.email
        WHEN bi.id IS NOT NULL THEN nb.partner_user_id::text
        WHEN bn.id IS NOT NULL THEN nb.partner_name
        ELSE NULL
      END AS came_in_matched_value,
      lm.full_name AS lead_partner_name
    FROM nb
    LEFT JOIN profiles ag ON ag.id = nb.agent_id
    LEFT JOIN cand_id bi ON bi.id = nb.partner_user_id
    LEFT JOIN by_phone bk1 ON length(nb.k1) = 9 AND bk1.pk = nb.k1
    LEFT JOIN by_phone bk2 ON length(nb.k2) = 9 AND bk2.pk = nb.k2
    LEFT JOIN by_email be ON nb.em IS NOT NULL AND be.pem = nb.em
    LEFT JOIN by_name bn ON nb.nmk IS NOT NULL AND bn.pnm = nb.nmk
    LEFT JOIN lead_map lm ON lm.agent_id = nb.agent_id
  ),
  partner_ids AS MATERIALIZED (
    SELECT DISTINCT came_in_user_id AS id FROM matched WHERE came_in_user_id IS NOT NULL
  ),
  commission_rollup AS MATERIALIZED (
    SELECT e.note_id,
      COALESCE(sum(e.amount) FILTER (WHERE e.status = 'paid' AND e.kind = 'portfolio_creation'), 0) AS creation_commission_paid,
      COALESCE(sum(e.amount) FILTER (WHERE e.status = 'paid' AND e.kind = 'portfolio_topup'), 0) AS topup_commission_paid,
      COALESCE(sum(e.amount) FILTER (WHERE e.status = 'paid'), 0) AS commission_paid_total,
      count(*) FILTER (WHERE e.status = 'paid' AND e.kind = 'portfolio_topup')::int AS topup_commission_count,
      max(e.created_at) FILTER (WHERE e.status = 'paid') AS last_commission_at
    FROM promissory_commission_events e
    WHERE e.note_id IN (SELECT id FROM nb)
    GROUP BY e.note_id
  ),
  portfolio_rollup AS MATERIALIZED (
    SELECT ip.investor_id,
      count(*)::int AS portfolio_count,
      count(*) FILTER (WHERE ip.status = 'active')::int AS active_count,
      count(*) FILTER (WHERE ip.status <> 'active')::int AS pending_count,
      COALESCE(sum(ip.investment_amount), 0) AS portfolio_amount,
      COALESCE(sum(ip.investment_amount) FILTER (WHERE ip.status = 'active'), 0) AS active_amount,
      min(ip.created_at) AS first_portfolio_at
    FROM investor_portfolios ip
    WHERE ip.investor_id IN (SELECT id FROM partner_ids)
    GROUP BY ip.investor_id
  ),
  commitment_rollup AS MATERIALIZED (
    SELECT c.promissory_note_id AS note_id,
      c.partner_id,
      count(*)::int AS self_commitment_count,
      count(*) FILTER (WHERE c.status IN ('active','funded','completed'))::int AS self_commitment_active_count,
      count(*) FILTER (WHERE c.status NOT IN ('active','funded','completed','cancelled','rejected'))::int AS self_commitment_pending_count,
      COALESCE(sum(c.committed_amount), 0) AS self_commitment_amount,
      COALESCE(sum(c.committed_amount) FILTER (WHERE c.status IN ('active','funded','completed')), 0) AS self_commitment_active_amount,
      min(c.created_at) AS self_first_commitment_at,
      jsonb_agg(jsonb_build_object(
        'commitment_id', c.id,
        'status', c.status,
        'amount', c.committed_amount,
        'lines', c.lines_count,
        'created_at', c.created_at,
        'updated_at', c.updated_at
      ) ORDER BY c.created_at DESC) AS self_commitments
    FROM partner_self_commitments c
    WHERE c.promissory_note_id IN (SELECT id FROM nb)
      AND c.partner_id IN (SELECT id FROM partner_ids)
    GROUP BY c.promissory_note_id, c.partner_id
  ),
  reserved_rollup AS MATERIALIZED (
    SELECT i.note_id,
      count(*)::int AS reserved_plans,
      COALESCE(sum(i.amount), 0) AS reserved_amount
    FROM promissory_note_plan_intents i
    WHERE i.note_id IN (SELECT id FROM nb)
      AND i.status IN ('reserved','funded')
    GROUP BY i.note_id
  ),
  house_intent_rollup AS MATERIALIZED (
    SELECT h.note_id,
      count(*)::int AS house_intent_count
    FROM promissory_note_house_intents h
    WHERE h.note_id IN (SELECT id FROM nb)
    GROUP BY h.note_id
  ),
  plan_intent_rollup AS MATERIALIZED (
    SELECT i.note_id,
      count(*)::int AS plan_intent_count
    FROM promissory_note_plan_intents i
    WHERE i.note_id IN (SELECT id FROM nb)
    GROUP BY i.note_id
  ),
  notes AS MATERIALIZED (
    SELECT m.*,
      CASE WHEN COALESCE(m.support_mode, 'existing_support') = 'self_support'
           THEN COALESCE(cr.self_commitment_count, 0)
           ELSE COALESCE(pr.portfolio_count, 0)
      END AS portfolio_count,
      CASE WHEN COALESCE(m.support_mode, 'existing_support') = 'self_support'
           THEN COALESCE(cr.self_commitment_active_count, 0)
           ELSE COALESCE(pr.active_count, 0)
      END AS portfolio_active_count,
      CASE WHEN COALESCE(m.support_mode, 'existing_support') = 'self_support'
           THEN COALESCE(cr.self_commitment_pending_count, 0)
           ELSE COALESCE(pr.pending_count, 0)
      END AS portfolio_pending_count,
      CASE WHEN COALESCE(m.support_mode, 'existing_support') = 'self_support'
           THEN COALESCE(cr.self_commitment_amount, 0)
           ELSE COALESCE(pr.portfolio_amount, 0)
      END AS portfolio_amount,
      CASE WHEN COALESCE(m.support_mode, 'existing_support') = 'self_support'
           THEN COALESCE(cr.self_commitment_active_amount, 0)
           ELSE COALESCE(pr.active_amount, 0)
      END AS portfolio_active_amount,
      CASE WHEN COALESCE(m.support_mode, 'existing_support') = 'self_support'
           THEN cr.self_first_commitment_at
           ELSE pr.first_portfolio_at
      END AS first_portfolio_at,
      COALESCE(cr.self_commitment_count, 0) AS self_commitment_count,
      COALESCE(cr.self_commitment_pending_count, 0) AS self_commitment_pending_count,
      COALESCE(cr.self_commitment_active_count, 0) AS self_commitment_active_count,
      COALESCE(cr.self_commitment_amount, 0) AS self_commitment_amount,
      COALESCE(cr.self_commitment_active_amount, 0) AS self_commitment_active_amount,
      COALESCE(cr.self_commitments, '[]'::jsonb) AS self_commitments,
      COALESCE(rr.reserved_plans, 0) AS reserved_plans,
      COALESCE(rr.reserved_amount, 0) AS reserved_amount,
      COALESCE(hi.house_intent_count, 0) AS house_intent_count,
      COALESCE(pi.plan_intent_count, 0) AS plan_intent_count,
      COALESCE(comm.creation_commission_paid, 0) AS creation_commission_paid,
      COALESCE(comm.topup_commission_paid, 0) AS topup_commission_paid,
      COALESCE(comm.commission_paid_total, 0) AS commission_paid_total,
      COALESCE(comm.topup_commission_count, 0) AS topup_commission_count,
      comm.last_commission_at,
      CASE
        WHEN m.came_in_user_id IS NULL THEN 'not_registered'
        WHEN COALESCE(m.support_mode, 'existing_support') = 'self_support'
             AND COALESCE(cr.self_commitment_active_count, 0) > 0 THEN 'portfolio_active'
        WHEN COALESCE(m.support_mode, 'existing_support') = 'self_support'
             AND COALESCE(cr.self_commitment_pending_count, 0) > 0 THEN 'portfolio_pending'
        WHEN COALESCE(m.support_mode, 'existing_support') <> 'self_support'
             AND COALESCE(pr.active_count, 0) > 0 THEN 'portfolio_active'
        WHEN COALESCE(m.support_mode, 'existing_support') <> 'self_support'
             AND COALESCE(pr.pending_count, 0) > 0 THEN 'portfolio_pending'
        ELSE 'came_in'
      END AS journey_stage
    FROM matched m
    LEFT JOIN portfolio_rollup pr ON pr.investor_id = m.came_in_user_id
    LEFT JOIN commitment_rollup cr ON cr.note_id = m.id AND cr.partner_id = m.came_in_user_id
    LEFT JOIN reserved_rollup rr ON rr.note_id = m.id
    LEFT JOIN house_intent_rollup hi ON hi.note_id = m.id
    LEFT JOIN plan_intent_rollup pi ON pi.note_id = m.id
    LEFT JOIN commission_rollup comm ON comm.note_id = m.id
  ),
  agent_rollup AS (
    SELECT agent_id,
      count(*)::int AS notes_count,
      count(came_in_user_id)::int AS partners_count,
      COALESCE(sum(GREATEST(amount - total_collected, 0)) FILTER (WHERE status IN ('pending','activated')), 0) AS amount_expected,
      COALESCE(sum(total_collected), 0) AS amount_collected,
      max(lead_partner_name) AS lead_partner_name
    FROM notes GROUP BY agent_id
  ),
  proxies AS MATERIALIZED (
    SELECT pai.agent_user_id, pai.full_name, pai.phone, pai.status,
      COALESCE(pai.captured_at, pai.submitted_at) AS joined_at,
      pai.invite_code, pai.nin
    FROM proxy_agent_identity pai
  ),
  commission AS (
    SELECT
      COALESCE(sum(amount) FILTER (WHERE status = 'pending'), 0) AS pending_amount,
      count(*) FILTER (WHERE status = 'pending')::int AS pending_count,
      COALESCE(sum(amount) FILTER (WHERE status = 'approved'), 0) AS approved_amount,
      count(*) FILTER (WHERE status = 'approved')::int AS approved_count
    FROM agent_commission_payouts
    WHERE created_at >= v_from AND created_at < v_to
  ),
  self_support AS (
    SELECT
      count(*)::int AS tenant_lines,
      count(DISTINCT partner_id)::int AS partner_count,
      COALESCE(sum(principal), 0) AS committed_principal
    FROM partner_self_funding_lines
    WHERE status IN ('active','committed')
  )
  SELECT jsonb_build_object(
    'rates', jsonb_build_object(
      'portfolio_creation', v_rate_creation,
      'portfolio_topup', v_rate_topup
    ),
    'kpis', jsonb_build_object(
      'notes_count', (SELECT count(*) FROM notes),
      'partners_came_in', (SELECT count(came_in_user_id) FROM notes),
      'partners_with_portfolio', (SELECT count(*) FROM notes WHERE portfolio_count > 0),
      'partners_portfolio_pending', (SELECT count(*) FROM notes WHERE journey_stage = 'portfolio_pending'),
      'partners_portfolio_active', (SELECT count(*) FROM notes WHERE journey_stage = 'portfolio_active'),
      'receivable', (SELECT COALESCE(sum(GREATEST(amount - total_collected, 0)) FILTER (WHERE status IN ('pending','activated')), 0) FROM notes),
      'promised_total', (SELECT COALESCE(sum(amount), 0) FROM notes),
      'fulfilled_total', (SELECT COALESCE(sum(total_collected), 0) FROM notes),
      'approved_notes', (SELECT count(*) FROM notes WHERE approved_at IS NOT NULL),
      'proxy_agents', (SELECT count(*) FROM proxies),
      'proxies_approved', (SELECT count(*) FROM proxies WHERE status = 'approved'),
      'proxies_pending', (SELECT count(*) FROM proxies WHERE status <> 'approved'),
      'lead_attachments', (SELECT count(*) FROM partner_lead_assignments WHERE detached_at IS NULL),
      'pending_commission', (SELECT pending_amount FROM commission),
      'pending_commission_count', (SELECT pending_count FROM commission),
      'approved_commission', (SELECT approved_amount FROM commission),
      'approved_commission_count', (SELECT approved_count FROM commission),
      'promissory_creation_commission_paid', (SELECT COALESCE(sum(creation_commission_paid), 0) FROM notes),
      'promissory_topup_commission_paid', (SELECT COALESCE(sum(topup_commission_paid), 0) FROM notes),
      'promissory_commission_paid_total', (SELECT COALESCE(sum(commission_paid_total), 0) FROM notes),
      'self_supporting_tenants', (SELECT tenant_lines FROM self_support),
      'self_supporting_partners', (SELECT partner_count FROM self_support),
      'self_support_committed', (SELECT committed_principal FROM self_support)
    ),
    'notes', COALESCE((
      SELECT jsonb_agg((
        jsonb_build_object(
          'id', id,
          'agent_id', agent_id,
          'agent_name', COALESCE(agent_name, 'Unknown Agent'),
          'agent_phone', agent_phone,
          'partner_name', partner_name,
          'whatsapp_number', whatsapp_number,
          'phone_number', phone_number,
          'email', email,
          'amount', amount,
          'total_collected', total_collected,
          'outstanding', GREATEST(amount - total_collected, 0),
          'contribution_type', contribution_type,
          'deduction_day', deduction_day,
          'next_deduction_date', next_deduction_date,
          'status', status,
          'created_at', created_at,
          'approved_at', approved_at,
          'approval_bonus_paid', approval_bonus_paid,
          'partner_user_id', partner_user_id,
          'came_in', came_in_user_id IS NOT NULL,
          'came_in_user_id', came_in_user_id,
          'came_in_name', came_in_name,
          'came_in_at', came_in_at,
          'came_in_match_basis', came_in_match_basis,
          'came_in_matched_value', came_in_matched_value
        ) || jsonb_build_object(
          'lead_partner_name', lead_partner_name,
          'support_mode', COALESCE(support_mode, 'existing_support'),
          'reserved_plans', reserved_plans,
          'reserved_amount', reserved_amount,
          'plan_intent_count', plan_intent_count,
          'house_intent_count', house_intent_count,
          'journey_stage', journey_stage,
          'fulfilment_due_on', fulfilment_due_on,
          'portfolio_count', portfolio_count,
          'portfolio_active_count', portfolio_active_count,
          'portfolio_pending_count', portfolio_pending_count,
          'portfolio_amount', portfolio_amount,
          'portfolio_active_amount', portfolio_active_amount,
          'first_portfolio_at', first_portfolio_at,
          'self_commitment_count', self_commitment_count,
          'self_commitment_pending_count', self_commitment_pending_count,
          'self_commitment_active_count', self_commitment_active_count,
          'self_commitment_amount', self_commitment_amount,
          'self_commitment_active_amount', self_commitment_active_amount,
          'self_commitments', self_commitments,
          'commission_creation_rate', v_rate_creation,
          'commission_topup_rate', v_rate_topup,
          'creation_commission_paid', creation_commission_paid,
          'topup_commission_paid', topup_commission_paid,
          'commission_paid_total', commission_paid_total,
          'topup_commission_count', topup_commission_count,
          'last_commission_at', last_commission_at,
          'creation_commission_expected', ROUND(COALESCE(amount, 0) * v_rate_creation)
        )
      ) ORDER BY created_at DESC) FROM notes
    ), '[]'::jsonb),
    'proxy_agents', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'agent_user_id', pr.agent_user_id,
        'name', COALESCE(pf.full_name, pr.full_name, 'Unnamed agent'),
        'phone', COALESCE(pf.phone, pr.phone),
        'email', pf.email,
        'avatar_url', pf.avatar_url,
        'district', pf.district,
        'region', pf.region,
        'nin', pr.nin,
        'invite_code', pr.invite_code,
        'status', pr.status,
        'joined_at', pr.joined_at,
        'notes_count', COALESCE(ar.notes_count, 0),
        'partners_count', COALESCE(ar.partners_count, 0),
        'lead_partner_name', ar.lead_partner_name,
        'amount_expected', COALESCE(ar.amount_expected, 0),
        'amount_collected', COALESCE(ar.amount_collected, 0)
      ) ORDER BY COALESCE(ar.notes_count, 0) DESC, pr.joined_at DESC NULLS LAST)
      FROM proxies pr
      LEFT JOIN agent_rollup ar ON ar.agent_id = pr.agent_user_id
      LEFT JOIN profiles pf ON pf.id = pr.agent_user_id
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_promissory_ops_report(timestamp with time zone, timestamp with time zone) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_promissory_ops_report(timestamp with time zone, timestamp with time zone) TO authenticated, postgres, service_role;

CREATE OR REPLACE FUNCTION public.get_cto_daily_report(p_date date DEFAULT ((now() AT TIME ZONE 'Africa/Kampala'::text))::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_start timestamptz := (p_date::text || ' 00:00:00+03')::timestamptz;
  v_end   timestamptz := (p_date::text || ' 23:59:59.999+03')::timestamptz;
  v_prev_start timestamptz := v_start - interval '1 day';
  v_7d timestamptz := v_end - interval '7 days';
  v_30d timestamptz := v_end - interval '30 days';
  v jsonb;
  v_slow jsonb := '[]'::jsonb;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_snap_commit bigint;
  v_snap_rollback bigint;
  v_snap_deadlocks bigint;
  v_prev_commit bigint;
  v_prev_rollback bigint;
  v_prev_deadlocks bigint;
  v_prev_at timestamptz;
  v_prev_day date;
  v_day_commits bigint;
  v_day_rollbacks bigint;
  v_day_deadlocks bigint;
  v_infra_trustworthy boolean;
  v_roles jsonb := '{}'::jsonb;
  v_sms jsonb := '{}'::jsonb;
  v_otp jsonb := '{}'::jsonb;
  v_signin jsonb := '{}'::jsonb;
  v_email jsonb := '{}'::jsonb;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'manager')
    OR auth.role() = 'service_role' OR auth.uid() IS NULL
  ) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  BEGIN
    SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) INTO v_slow FROM (
      SELECT left(query, 110) AS query, round(mean_exec_time::numeric,1) AS mean_ms, calls
      FROM extensions.pg_stat_statements
      WHERE query NOT ILIKE '%pg_stat%' AND calls > 20
      ORDER BY mean_exec_time DESC LIMIT 6
    ) x;
  EXCEPTION WHEN OTHERS THEN
    v_slow := '[]'::jsonb;
  END;

  IF p_date = v_today THEN
    SELECT xact_commit, xact_rollback, deadlocks INTO v_snap_commit, v_snap_rollback, v_snap_deadlocks
    FROM pg_stat_database WHERE datname = current_database();

    INSERT INTO public.db_stat_snapshots (day, xact_commit, xact_rollback, deadlocks, captured_at)
    VALUES (p_date, v_snap_commit, v_snap_rollback, v_snap_deadlocks, now())
    ON CONFLICT (day) DO UPDATE
      SET xact_commit = EXCLUDED.xact_commit,
          xact_rollback = EXCLUDED.xact_rollback,
          deadlocks = EXCLUDED.deadlocks,
          captured_at = EXCLUDED.captured_at;
  ELSE
    SELECT xact_commit, xact_rollback, deadlocks INTO v_snap_commit, v_snap_rollback, v_snap_deadlocks
    FROM public.db_stat_snapshots WHERE day = p_date;
  END IF;

  SELECT xact_commit, xact_rollback, deadlocks, captured_at, day
    INTO v_prev_commit, v_prev_rollback, v_prev_deadlocks, v_prev_at, v_prev_day
  FROM public.db_stat_snapshots
  WHERE day < p_date
  ORDER BY day DESC LIMIT 1;

  v_infra_trustworthy := (
    v_snap_commit IS NOT NULL AND v_prev_commit IS NOT NULL
    AND v_prev_day = (p_date - 1)
    AND v_snap_commit >= v_prev_commit
    AND v_snap_rollback >= v_prev_rollback
  );

  IF v_infra_trustworthy THEN
    v_day_commits := v_snap_commit - v_prev_commit;
    v_day_rollbacks := v_snap_rollback - v_prev_rollback;
    v_day_deadlocks := GREATEST(COALESCE(v_snap_deadlocks,0) - COALESCE(v_prev_deadlocks,0), 0);
  ELSE
    v_day_commits := NULL;
    v_day_rollbacks := NULL;
    v_day_deadlocks := NULL;
  END IF;

  WITH agent_rr AS (
    SELECT DISTINCT agent_id FROM public.rent_requests
    WHERE agent_id IS NOT NULL
      AND status IN ('funded','repaying','completed','coo_approved','agent_ops_approved','tenant_ops_approved')
  ), agent_hl AS (
    SELECT DISTINCT agent_id FROM public.house_listings
    WHERE agent_id IS NOT NULL AND verified IS TRUE
  ), agent_col AS (
    SELECT DISTINCT agent_id FROM public.agent_collections WHERE agent_id IS NOT NULL
  ), agents AS (
    SELECT agent_id FROM agent_rr
    UNION SELECT agent_id FROM agent_hl
    UNION SELECT agent_id FROM agent_col
  )
  SELECT jsonb_build_object(
    'agents_active', (SELECT count(*) FROM agents),
    'agents_verified_listing', (SELECT count(*) FROM agent_hl),
    'agents_approved_rent_request', (SELECT count(*) FROM agent_rr),
    'agents_collecting_rent', (SELECT count(*) FROM agent_col),
    'agents_fully_productive', (
      SELECT count(*) FROM agent_hl h
      WHERE EXISTS (SELECT 1 FROM agent_rr r WHERE r.agent_id = h.agent_id)
        AND EXISTS (SELECT 1 FROM agent_col c WHERE c.agent_id = h.agent_id)
    ),
    'tenants_active', (
      SELECT count(DISTINCT tenant_id) FROM public.rent_requests
      WHERE tenant_id IS NOT NULL AND status IN ('funded','repaying','completed')
    ),
    'tenants_intake_queue', (
      SELECT count(DISTINCT tenant_id) FROM public.rent_requests
      WHERE tenant_id IS NOT NULL AND status = 'service_center_review'
    ),
    'funders_with_portfolio', (
      SELECT count(DISTINCT investor_id) FROM public.investor_portfolios WHERE investor_id IS NOT NULL
    ),
    'funders_agreement_accepted', (
      SELECT count(DISTINCT supporter_id) FROM public.supporter_agreement_acceptance WHERE supporter_id IS NOT NULL
    ),
    'landlords_engaged', (
      SELECT count(*) FROM (
        SELECT landlord_id FROM public.house_listings WHERE landlord_id IS NOT NULL
        UNION
        SELECT landlord_id FROM public.rent_requests WHERE landlord_id IS NOT NULL
      ) l
    ),
    'landlords_on_file', (SELECT count(*) FROM public.landlords),
    'landlords_are_users', false,
    'landlords_precision', 'approximate'
  ) INTO v_roles;

  WITH sms_dedup AS (
    SELECT *
    FROM public.sms_delivery_log
    WHERE created_at >= v_30d AND created_at <= v_end
      AND NOT public.sms_row_is_recovered(status, recipient_phone, created_at)
      AND NOT (
        provider_response ? 'total_attempts'
        AND (provider_response->>'attempt_sequence')::int < (provider_response->>'total_attempts')::int
      )
  )
  SELECT jsonb_build_object(
    'total_30d', count(*),
    'sent', count(*) FILTER (WHERE status = 'sent'),
    'accepted', count(*) FILTER (WHERE status = 'accepted'),
    'delivered_confirmed', count(*) FILTER (WHERE status = 'delivered'),
    'pending', count(*) FILTER (WHERE status = 'pending'),
    'queued', count(*) FILTER (WHERE status = 'queued'),
    'failed', count(*) FILTER (WHERE status = 'failed' AND NOT public.sms_row_invalid_destination(error)),
    'invalid_destination', count(*) FILTER (WHERE status = 'failed' AND public.sms_row_invalid_destination(error)),
    'failover_recovered_30d', (SELECT count(*) FROM public.sms_delivery_log r WHERE r.status IN ('failed', 'failover') AND r.created_at >= v_30d AND r.created_at <= v_end AND public.sms_row_is_recovered(r.status, r.recipient_phone, r.created_at)),
    'provider_accepted_rate', round(100.0 * count(*) FILTER (WHERE status IN ('sent','accepted','delivered')) / NULLIF(count(*),0), 1),
    'confirmed_rate', round(100.0 * count(*) FILTER (WHERE status = 'delivered') / NULLIF(count(*),0), 1),
    'failure_rate', round(100.0 * count(*) FILTER (WHERE status = 'failed' AND NOT public.sms_row_invalid_destination(error)) / NULLIF(count(*),0), 1),
    'unresolved_rate', round(100.0 * count(*) FILTER (WHERE status IN ('pending','queued')) / NULLIF(count(*),0), 1),
    'dlr_capable', count(*) FILTER (WHERE lower(COALESCE(provider,'')) LIKE '%yoola%'),
    'dlr_capable_rate', round(100.0 * count(*) FILTER (WHERE lower(COALESCE(provider,'')) LIKE '%yoola%') / NULLIF(count(*),0), 1)
  ) INTO v_sms
  FROM sms_dedup;

  WITH sms_otp_dedup AS (
    SELECT *
    FROM public.sms_delivery_log
    WHERE source = 'sms-otp' AND created_at >= v_30d AND created_at <= v_end
      AND NOT public.sms_row_is_recovered(status, recipient_phone, created_at)
      AND NOT (
        provider_response ? 'total_attempts'
        AND (provider_response->>'attempt_sequence')::int < (provider_response->>'total_attempts')::int
      )
  )
  SELECT jsonb_build_object(
    'sends_30d', (SELECT count(*) FROM sms_otp_dedup),
    'sends_accepted_30d', (SELECT count(*) FROM sms_otp_dedup WHERE status IN ('sent','accepted','delivered')),
    'sends_failed_30d', (SELECT count(*) FROM sms_otp_dedup WHERE status = 'failed' AND NOT public.sms_row_invalid_destination(error)),
    'sends_invalid_destination_30d', (SELECT count(*) FROM sms_otp_dedup WHERE status = 'failed' AND public.sms_row_invalid_destination(error)),
    'verify_total_30d', (SELECT count(*) FROM public.otp_login_audit WHERE created_at >= v_30d AND created_at <= v_end),
    'verify_success_30d', (SELECT count(*) FROM public.otp_login_audit WHERE outcome = 'success' AND created_at >= v_30d AND created_at <= v_end),
    'verify_failed_30d', (SELECT count(*) FROM public.otp_login_audit WHERE outcome = 'failed' AND created_at >= v_30d AND created_at <= v_end),
    'verify_no_account_30d', (SELECT count(*) FROM public.otp_login_audit WHERE outcome = 'no_account' AND created_at >= v_30d AND created_at <= v_end),
    'verify_error_30d', (SELECT count(*) FROM public.otp_login_audit WHERE outcome = 'error' AND created_at >= v_30d AND created_at <= v_end)
  ) INTO v_otp;

  v_otp := v_otp || jsonb_build_object(
    'send_accepted_rate', round(100.0 * (v_otp->>'sends_accepted_30d')::numeric / NULLIF((v_otp->>'sends_30d')::numeric,0), 1),
    'verify_success_rate', round(100.0 * (v_otp->>'verify_success_30d')::numeric / NULLIF((v_otp->>'verify_total_30d')::numeric,0), 1)
  );

  WITH latest_email AS (
    SELECT DISTINCT ON (message_id) message_id, status, created_at
    FROM public.email_send_log
    WHERE created_at >= v_30d AND created_at <= v_end
    ORDER BY message_id, created_at DESC
  )
  SELECT jsonb_build_object(
    'total_30d', count(*),
    'delivered_30d', count(*) FILTER (WHERE status = 'sent'),
    'pending_30d', count(*) FILTER (WHERE status IN ('pending','rate_limited')),
    'suppressed_30d', count(*) FILTER (WHERE status = 'suppressed'),
    'failed_30d', count(*) FILTER (WHERE status IN ('failed','dlq')),
    'delivery_rate_30d', round(100.0 * count(*) FILTER (WHERE status = 'sent') / NULLIF(count(*),0), 1),
    'pending_rate_30d', round(100.0 * count(*) FILTER (WHERE status IN ('pending','rate_limited')) / NULLIF(count(*),0), 1)
  ) INTO v_email
  FROM latest_email;

  WITH att AS (
    SELECT session_trace_id, status, detail, user_id, created_at
    FROM public.login_phase_events
    WHERE phase = 'auth.signin.attempt' AND created_at >= v_7d AND created_at <= v_end
  ), sessions_tried AS (
    SELECT DISTINCT session_trace_id FROM att WHERE session_trace_id IS NOT NULL
  ), sessions_succeeded AS (
    SELECT DISTINCT session_trace_id FROM att WHERE session_trace_id IS NOT NULL AND status = 'success'
  )
  SELECT jsonb_build_object(
    'attempts_7d', (SELECT count(*) FROM att),
    'success_7d', (SELECT count(*) FROM att WHERE status = 'success'),
    'error_7d', (SELECT count(*) FROM att WHERE status = 'error'),
    'rate_limited_7d', (SELECT count(*) FROM att WHERE status = 'rate_limited'),
    'unknown_account_7d', (SELECT count(*) FROM att WHERE status <> 'success' AND detail->>'accountExists' = 'false'),
    'wrong_credentials_7d', (SELECT count(*) FROM att WHERE status = 'error' AND detail->>'accountExists' = 'true'),
    'platform_failures_7d', (SELECT count(*) FROM att
       WHERE status = 'rate_limited'
          OR (status = 'error' AND detail->>'accountExists' IS NULL)),
    'success_rate', (SELECT round(100.0 * count(*) FILTER (WHERE status = 'success') / NULLIF(count(*),0), 1) FROM att),
    'platform_failure_rate', (SELECT round(100.0 * count(*) FILTER (
          WHERE status = 'rate_limited' OR (status = 'error' AND detail->>'accountExists' IS NULL)
        ) / NULLIF(count(*),0), 2) FROM att),
    'users_tried_7d', (SELECT count(*) FROM sessions_tried),
    'users_eventually_signed_in_7d', (SELECT count(*) FROM sessions_succeeded),
    'eventual_success_rate', (SELECT round(100.0 * (SELECT count(*) FROM sessions_succeeded) / NULLIF((SELECT count(*) FROM sessions_tried),0), 1))
  ) INTO v_signin;

  SELECT jsonb_build_object(
    'date', p_date,
    'generated_at', now(),

    'platform', jsonb_build_object(
      'total_users', (SELECT count(*) FROM profiles),
      'new_users_today', (SELECT count(*) FROM profiles WHERE created_at BETWEEN v_start AND v_end),
      'active_24h', (SELECT count(*) FROM profiles WHERE last_active_at >= v_end - interval '24 hours'),
      'active_7d', (SELECT count(*) FROM profiles WHERE last_active_at >= v_7d),
      'active_30d', (SELECT count(*) FROM profiles WHERE last_active_at >= v_30d),
      'events_today', (SELECT count(*) FROM system_events WHERE created_at BETWEEN v_start AND v_end),
      'events_prev_day', (SELECT count(*) FROM system_events WHERE created_at BETWEEN v_prev_start AND v_start),
      'events_7d', (SELECT count(*) FROM system_events WHERE created_at >= v_7d AND created_at <= v_end),
      'txn_today', (SELECT count(*) FROM general_ledger WHERE created_at BETWEEN v_start AND v_end)
    ),

    'roles', v_roles,
    'sms', v_sms,
    'otp', v_otp,
    'signin', v_signin,

    'errors', jsonb_build_object(
      'today', (SELECT count(*) FROM client_error_reports WHERE created_at BETWEEN v_start AND v_end),
      'prev_day', (SELECT count(*) FROM client_error_reports WHERE created_at BETWEEN v_prev_start AND v_start),
      'last_7d', (SELECT count(*) FROM client_error_reports WHERE created_at >= v_7d AND created_at <= v_end),
      'affected_users_today', (SELECT count(DISTINCT user_id) FROM client_error_reports WHERE created_at BETWEEN v_start AND v_end),
      'top_routes', COALESCE((
        SELECT jsonb_agg(x) FROM (
          SELECT COALESCE(route,'unknown') AS route, count(*) AS n
          FROM client_error_reports WHERE created_at >= v_7d AND created_at <= v_end
          GROUP BY 1 ORDER BY n DESC LIMIT 6
        ) x), '[]'::jsonb),
      'top_messages', COALESCE((
        SELECT jsonb_agg(x) FROM (
          SELECT left(COALESCE(message,'unknown'),120) AS message, count(*) AS n
          FROM client_error_reports WHERE created_at >= v_7d AND created_at <= v_end
          GROUP BY 1 ORDER BY n DESC LIMIT 6
        ) x), '[]'::jsonb),
      'daily_trend', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('d', t.d, 'n', t.n) ORDER BY t.d) FROM (
          SELECT (created_at AT TIME ZONE 'Africa/Kampala')::date AS d, count(*) AS n
          FROM client_error_reports WHERE created_at >= v_end - interval '14 days' AND created_at <= v_end
          GROUP BY 1
        ) t), '[]'::jsonb),
      'compat_events_7d', (SELECT count(*) FROM browser_compat_events WHERE created_at >= v_7d AND created_at <= v_end)
    ),

    'auth', jsonb_build_object(
      'login_events_today', (SELECT count(*) FROM login_phase_events WHERE created_at BETWEEN v_start AND v_end AND phase = 'auth.signin.attempt'),
      'login_success_today', (SELECT count(*) FROM login_phase_events WHERE created_at BETWEEN v_start AND v_end AND phase = 'auth.signin.attempt' AND status = 'success'),
      'login_failures_today', (SELECT count(*) FROM login_phase_events WHERE created_at BETWEEN v_start AND v_end AND phase = 'auth.signin.attempt' AND status <> 'success'),
      'login_failures_7d', (SELECT count(*) FROM login_phase_events WHERE created_at >= v_7d AND created_at <= v_end AND phase = 'auth.signin.attempt' AND status <> 'success'),
      'login_events_7d', (SELECT count(*) FROM login_phase_events WHERE created_at >= v_7d AND created_at <= v_end AND phase = 'auth.signin.attempt'),
      'login_rate_limited_today', (SELECT count(*) FROM login_phase_events WHERE created_at BETWEEN v_start AND v_end AND phase = 'auth.signin.attempt' AND status = 'rate_limited'),
      'avg_login_ms_today', (SELECT round(avg((detail->>'totalMs')::numeric)) FROM login_phase_events WHERE created_at BETWEEN v_start AND v_end AND phase = 'auth.signin.attempt' AND (detail->>'totalMs') ~ '^[0-9]+$'),
      'avg_phase_ms_today', (SELECT round(avg(duration_ms)) FROM login_phase_events WHERE created_at BETWEEN v_start AND v_end AND duration_ms IS NOT NULL),
      'otp_attempts_today', (SELECT count(*) FROM otp_login_audit WHERE created_at BETWEEN v_start AND v_end),
      'otp_failures_today', (SELECT count(*) FROM otp_login_audit WHERE created_at BETWEEN v_start AND v_end AND outcome <> 'success')
    ),

    'security', jsonb_build_object(
      'signup_attempts_today', (SELECT count(*) FROM signup_attempts WHERE created_at BETWEEN v_start AND v_end),
      'signup_blocked_today', (SELECT count(*) FROM signup_attempts
        WHERE created_at BETWEEN v_start AND v_end AND status <> 'allowed' AND status <> 'abandoned'),
      'signup_allowed_today', (SELECT count(*) FROM signup_attempts
        WHERE created_at BETWEEN v_start AND v_end AND status = 'allowed'),
      'signup_abandoned_today', (SELECT count(*) FROM signup_attempts
        WHERE created_at BETWEEN v_start AND v_end AND status = 'abandoned'),
      'blocked_ips_total', (SELECT count(*) FROM blocked_signup_ips),
      'fraud_blocks_active', (SELECT count(*) FROM fraud_identity_blocks WHERE status = 'active'),
      'fraud_blocks_today', (SELECT count(*) FROM fraud_identity_blocks WHERE created_at BETWEEN v_start AND v_end),
      'privileged_accounts', (SELECT count(DISTINCT user_id) FROM user_roles WHERE role IN ('super_admin','manager','cto','ceo','cfo','coo','access_admin')),
      'audit_writes_today', (SELECT count(*) FROM audit_logs WHERE created_at BETWEEN v_start AND v_end),
      'rls_tables', (SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relrowsecurity),
      'public_tables', (SELECT count(*) FROM pg_tables WHERE schemaname='public')
    ),

    'infra', jsonb_build_object(
      'db_size_bytes', pg_database_size(current_database()),
      'connections', (SELECT count(*) FROM pg_stat_activity),
      'max_connections', (SELECT setting::int FROM pg_settings WHERE name='max_connections'),
      'deadlocks', (SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()),
      'deadlocks_today', v_day_deadlocks,
      'rollbacks', v_day_rollbacks,
      'commits', v_day_commits,
      'rollback_baseline_at', v_prev_at,
      'rollback_trustworthy', v_infra_trustworthy,
      'rollbacks_cumulative_lifetime', v_snap_rollback,
      'commits_cumulative_lifetime', v_snap_commit,
      'cache_hit_pct', (SELECT round(100.0 * blks_hit / NULLIF(blks_hit + blks_read,0), 2) FROM pg_stat_database WHERE datname = current_database()),
      'uptime_hours', (SELECT round((EXTRACT(epoch FROM (now() - pg_postmaster_start_time()))/3600.0)::numeric, 1)),
      'largest_tables', COALESCE((
        SELECT jsonb_agg(x) FROM (
          SELECT relname AS table_name, pg_total_relation_size(c.oid) AS bytes
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind='r'
          ORDER BY 2 DESC LIMIT 8
        ) x), '[]'::jsonb)
    ),

    'backups', jsonb_build_object(
      'runs_7d', (SELECT count(*) FROM backup_runs WHERE created_at >= v_7d),
      'failures_7d', (SELECT count(*) FROM backup_runs WHERE created_at >= v_7d AND status <> 'success'),
      'latest', (SELECT to_jsonb(b) FROM (SELECT status, created_at, size_bytes, table_count, row_count FROM backup_runs ORDER BY created_at DESC LIMIT 1) b)
    ),

    'jobs', jsonb_build_object(
      'total_scheduled', (SELECT count(*) FROM cron.job),
      'runs_24h', (SELECT count(*) FROM public.cto_cron_run_details WHERE start_time >= v_end - interval '24 hours' AND start_time <= v_end),
      'failed_24h', (SELECT count(*) FROM public.cto_cron_run_details WHERE start_time >= v_end - interval '24 hours' AND start_time <= v_end AND status <> 'succeeded'),
      'failing', COALESCE((
        SELECT jsonb_agg(x) FROM (
          SELECT COALESCE(j.jobname, '(unscheduled) ' || COALESCE(substring(d.command from 'public\.([a-zA-Z_0-9]+)'), 'unknown')) AS jobname,
                 count(*) AS n, max(left(COALESCE(d.return_message,''),140)) AS last_error,
                 (j.jobid IS NULL) AS unscheduled
          FROM public.cto_cron_run_details d LEFT JOIN cron.job j USING (jobid)
          WHERE d.start_time >= v_end - interval '24 hours' AND d.start_time <= v_end AND d.status <> 'succeeded'
          GROUP BY j.jobid, j.jobname, d.command ORDER BY n DESC LIMIT 8
        ) x), '[]'::jsonb)
    ),

    'email', jsonb_build_object(
      'sent_today', (SELECT count(*) FROM email_send_log WHERE created_at BETWEEN v_start AND v_end),
      'delivered_today', (SELECT count(*) FROM email_send_log WHERE created_at BETWEEN v_start AND v_end AND status = 'sent'),
      'failed_today', (SELECT count(*) FROM email_send_log WHERE created_at BETWEEN v_start AND v_end AND status IN ('failed','dlq')),
      'pending_today', (SELECT count(*) FROM email_send_log WHERE created_at BETWEEN v_start AND v_end AND status IN ('pending','rate_limited')),
      'suppressed_today', (SELECT count(*) FROM email_send_log WHERE created_at BETWEEN v_start AND v_end AND status = 'suppressed'),
      'failed_7d', (SELECT count(*) FROM email_send_log WHERE created_at >= v_7d AND created_at <= v_end AND status IN ('failed','dlq')),
      'sent_7d', (SELECT count(*) FROM email_send_log WHERE created_at >= v_7d AND created_at <= v_end)
    ) || v_email,

    'slow_queries', v_slow
  ) INTO v;

  RETURN v;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_cto_daily_report(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_cto_daily_report(date) TO postgres, service_role;

CREATE OR REPLACE FUNCTION public.get_board_tech_memo(p_date date DEFAULT ((now() AT TIME ZONE 'Africa/Kampala'::text))::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_today   date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_from    timestamptz := ((p_date - 6)::text || ' 00:00:00+03')::timestamptz;
  v_to      timestamptz := LEAST(now(), ((p_date + 1)::text || ' 00:00:00+03')::timestamptz);
  v_30d     timestamptz;
  v_partial boolean;
  v_live_commit bigint;
  v_live_rollback bigint;
  v_live_deadlocks bigint;
  v_pm_start timestamptz := pg_postmaster_start_time();
  v_sms jsonb; v_sms_days jsonb; v_sms_streams jsonb; v_email jsonb;
  v_signin jsonb; v_otp jsonb; v_otp_login jsonb; v_signups jsonb;
  v_errors jsonb; v_db jsonb; v_jobs jsonb; v_sec jsonb; v_backups jsonb;
  v_slow jsonb;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'manager')
    OR auth.role() = 'service_role' OR auth.uid() IS NULL
  ) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  v_30d := v_to - interval '30 days';
  v_partial := (p_date >= v_today);

  -- ---------------------------------------------------------------- SMS
  -- One row per logical message: drop intermediate retry attempts.
  CREATE TEMP TABLE IF NOT EXISTS _bm_sms (LIKE public.sms_delivery_log) ON COMMIT DROP;
  TRUNCATE _bm_sms;
  INSERT INTO _bm_sms
  SELECT * FROM public.sms_delivery_log
  WHERE created_at >= v_from AND created_at < v_to
    AND NOT (provider_response ? 'total_attempts'
             AND (provider_response->>'attempt_sequence')::int < (provider_response->>'total_attempts')::int);

  WITH c AS (
    SELECT s.*,
      CASE
        WHEN s.status IN ('sent','accepted','delivered') THEN 'reached'
        WHEN s.status IN ('queued','pending') THEN 'queued'
        WHEN s.status = 'failed' THEN
          CASE
            WHEN coalesce(s.error,'') ~* 'authorization with key failed' THEN 'backup_key'
            WHEN coalesce(s.error,'') ~* '429|rate_limit|rate limit' THEN 'rate'
            WHEN coalesce(s.error,'') ~* '402|insufficient|credit' THEN 'credit'
            WHEN coalesce(s.error,'') ~* 'invalid|422|no valid|non-ugandan|no phone' THEN 'invalid'
            WHEN coalesce(s.error,'') ~* 'accepted but did not confirm' THEN 'unconfirmed'
            ELSE 'other'
          END
        ELSE 'other'
      END AS outcome
    FROM _bm_sms s
  )
  SELECT jsonb_build_object(
    'total', count(*),
    'phones', count(DISTINCT recipient_phone),
    'reached', count(*) FILTER (WHERE outcome = 'reached'),
    'confirmed', count(*) FILTER (WHERE status = 'delivered'),
    'confirmed_latest', max(created_at) FILTER (WHERE status = 'delivered'),
    'queued', count(*) FILTER (WHERE outcome = 'queued'),
    'failed', count(*) FILTER (WHERE status = 'failed'),
    'credit', count(*) FILTER (WHERE outcome = 'credit'),
    'rate', count(*) FILTER (WHERE outcome = 'rate'),
    'backup_key', count(*) FILTER (WHERE outcome = 'backup_key'),
    'invalid', count(*) FILTER (WHERE outcome = 'invalid'),
    'unconfirmed', count(*) FILTER (WHERE outcome = 'unconfirmed'),
    'other', count(*) FILTER (WHERE outcome = 'other'),
    'otp_total', count(*) FILTER (WHERE source IN ('sms-otp','password-reset-sms')),
    'otp_failed', count(*) FILTER (WHERE source IN ('sms-otp','password-reset-sms') AND status = 'failed'),
    'credit_by_day', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('d', d, 'n', n) ORDER BY d)
      FROM (SELECT (created_at AT TIME ZONE 'Africa/Kampala')::date AS d, count(*) AS n
            FROM c c2 WHERE c2.outcome = 'credit' GROUP BY 1) x), '[]'::jsonb),
    'rate_by_day', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('d', d, 'n', n) ORDER BY d)
      FROM (SELECT (created_at AT TIME ZONE 'Africa/Kampala')::date AS d, count(*) AS n
            FROM c c2 WHERE c2.outcome = 'rate' GROUP BY 1) x), '[]'::jsonb)
  ) INTO v_sms FROM c;

  -- Handset confirmation can only be judged against the 30-day provider mix
  -- (a window this short can legitimately hold zero confirmations).
  v_sms := v_sms || jsonb_build_object(
    'confirmed_30d', (SELECT count(*) FROM public.sms_delivery_log WHERE created_at >= v_30d AND created_at < v_to AND status = 'delivered'),
    'total_30d', (SELECT count(*) FROM public.sms_delivery_log WHERE created_at >= v_30d AND created_at < v_to),
    'confirmed_latest_30d', (SELECT max(created_at) FROM public.sms_delivery_log WHERE created_at >= v_30d AND created_at < v_to AND status = 'delivered')
  );

  SELECT COALESCE(jsonb_agg(jsonb_build_object('d', d, 'total', t, 'reached', r, 'failed', f, 'queued', q) ORDER BY d), '[]'::jsonb)
  INTO v_sms_days
  FROM (
    SELECT (created_at AT TIME ZONE 'Africa/Kampala')::date AS d, count(*) t,
           count(*) FILTER (WHERE status IN ('sent','accepted','delivered')) r,
           count(*) FILTER (WHERE status = 'failed') f,
           count(*) FILTER (WHERE status IN ('queued','pending')) q
    FROM _bm_sms GROUP BY 1
  ) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('source', source, 'total', t, 'failed', f) ORDER BY f DESC), '[]'::jsonb)
  INTO v_sms_streams
  FROM (
    SELECT source, count(*) t, count(*) FILTER (WHERE status = 'failed') f
    FROM _bm_sms GROUP BY 1 HAVING count(*) FILTER (WHERE status = 'failed') > 0
    ORDER BY f DESC LIMIT 5
  ) x;

  -- -------------------------------------------------------------- E-mail
  WITH latest AS (
    SELECT DISTINCT ON (message_id) message_id, status, error_message, created_at
    FROM public.email_send_log
    WHERE created_at >= v_from AND created_at < v_to
    ORDER BY message_id, created_at DESC
  ), l30 AS (
    SELECT DISTINCT ON (message_id) message_id, status
    FROM public.email_send_log
    WHERE created_at >= v_30d AND created_at < v_to
    ORDER BY message_id, created_at DESC
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM latest),
    'sent', (SELECT count(*) FROM latest WHERE status = 'sent'),
    'suppressed', (SELECT count(*) FROM latest WHERE status = 'suppressed'),
    'failed', (SELECT count(*) FROM latest WHERE status IN ('failed','dlq')),
    'pending', (SELECT count(*) FROM latest WHERE status IN ('pending','rate_limited')),
    'total_30d', (SELECT count(*) FROM l30),
    'sent_30d', (SELECT count(*) FROM l30 WHERE status = 'sent')
  ) INTO v_email;

  -- ------------------------------------------------------------- Sign-in
  WITH att AS (
    SELECT session_trace_id, status, user_id,
           (detail->>'accountExists') AS acct,
           CASE WHEN (detail->>'totalMs') ~ '^[0-9]+$' THEN (detail->>'totalMs')::int END AS ms
    FROM public.login_phase_events
    WHERE phase = 'auth.signin.attempt' AND created_at >= v_from AND created_at < v_to
  ), cls AS (
    SELECT *,
      CASE
        WHEN status = 'success' THEN 'ok'
        WHEN acct = 'false' THEN 'no_account'
        WHEN status = 'rate_limited' THEN 'platform'
        WHEN status = 'error' AND acct = 'true' AND coalesce(ms, 0) < 5000 THEN 'fast_reject'
        WHEN status = 'error' AND acct = 'true' THEN 'slow_reject'
        ELSE 'platform'
      END AS k
    FROM att
  ), tried AS (SELECT DISTINCT session_trace_id FROM att WHERE session_trace_id IS NOT NULL),
     got_in AS (SELECT DISTINCT session_trace_id FROM att WHERE session_trace_id IS NOT NULL AND status = 'success')
  SELECT jsonb_build_object(
    'attempts', (SELECT count(*) FROM cls),
    'ok', (SELECT count(*) FROM cls WHERE k = 'ok'),
    'fast_reject', (SELECT count(*) FROM cls WHERE k = 'fast_reject'),
    'slow_reject', (SELECT count(*) FROM cls WHERE k = 'slow_reject'),
    'no_account', (SELECT count(*) FROM cls WHERE k = 'no_account'),
    'platform', (SELECT count(*) FROM cls WHERE k = 'platform'),
    'people_tried', (SELECT count(*) FROM tried),
    'people_in', (SELECT count(*) FROM got_in)
  ) INTO v_signin;

  v_signin := v_signin || (
    SELECT jsonb_build_object(
      'startup_timeouts', count(*),
      'startup_timeout_users', count(DISTINCT user_id),
      'startup_timeout_sessions', count(DISTINCT session_trace_id)
    ) FROM public.login_phase_events
    WHERE phase = 'auth.init.timeout_forced' AND created_at >= v_from AND created_at < v_to
  );
  v_signin := v_signin || jsonb_build_object('startup_timeouts_by_day', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('d', d, 'n', n) ORDER BY d)
    FROM (SELECT (created_at AT TIME ZONE 'Africa/Kampala')::date d, count(*) n
          FROM public.login_phase_events
          WHERE phase = 'auth.init.timeout_forced' AND created_at >= v_from AND created_at < v_to
          GROUP BY 1) x), '[]'::jsonb));

  -- Access-denied loop: group by user first. A handful of accounts bouncing
  -- off a guard is not thousands of separate failures.
  v_signin := v_signin || (
    WITH d AS (
      SELECT user_id, count(*) n FROM public.login_phase_events
      WHERE phase = 'guard.resolved' AND status = 'denied' AND created_at >= v_from AND created_at < v_to
      GROUP BY 1
    )
    SELECT jsonb_build_object(
      'denied_users', (SELECT count(*) FROM d),
      'denied_events', (SELECT COALESCE(sum(n),0) FROM d),
      'denied_top_user_events', (SELECT COALESCE(max(n),0) FROM d)
    )
  );
  v_signin := v_signin || (
    SELECT jsonb_build_object('frozen_users', count(DISTINCT user_id), 'frozen_events', count(*))
    FROM public.login_phase_events
    WHERE phase = 'gate.account_frozen.check' AND status = 'frozen'
      AND created_at >= v_from AND created_at < v_to
  );

  -- ----------------------------------------------------------------- OTP
  SELECT COALESCE(jsonb_agg(jsonb_build_object('category', category, 'sent', s, 'verified', v, 'failed', f) ORDER BY category), '[]'::jsonb)
  INTO v_otp
  FROM (
    SELECT category,
           count(*) FILTER (WHERE event_type = 'sent') s,
           count(*) FILTER (WHERE event_type = 'verify_success') v,
           count(*) FILTER (WHERE event_type = 'verify_failed') f
    FROM public.otp_usage_events
    WHERE created_at >= v_from AND created_at < v_to
    GROUP BY 1
  ) x;

  SELECT jsonb_build_object(
    'total', count(*),
    'success', count(*) FILTER (WHERE outcome = 'success'),
    'failed', count(*) FILTER (WHERE outcome = 'failed'),
    'no_account', count(*) FILTER (WHERE outcome = 'no_account'),
    'error', count(*) FILTER (WHERE outcome = 'error')
  ) INTO v_otp_login
  FROM public.otp_login_audit WHERE created_at >= v_from AND created_at < v_to;

  -- ------------------------------------------------------------- Sign-ups
  SELECT jsonb_build_object(
    'created', (SELECT count(*) FROM public.profiles WHERE created_at >= v_from AND created_at < v_to),
    'by_day', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('d', d, 'n', n) ORDER BY d)
      FROM (SELECT (created_at AT TIME ZONE 'Africa/Kampala')::date d, count(*) n
            FROM public.profiles WHERE created_at >= v_from AND created_at < v_to GROUP BY 1) x), '[]'::jsonb),
    'opened_by_staff', (SELECT count(*) FROM public.signup_attempts
                        WHERE created_at >= v_from AND created_at < v_to AND status = 'allowed'
                          AND actor_user_id IS NOT NULL AND actor_user_id IS DISTINCT FROM user_id),
    'blocked', (SELECT count(*) FROM public.signup_attempts
                WHERE created_at >= v_from AND created_at < v_to AND status NOT IN ('allowed','abandoned')),
    'blocked_actors', (SELECT count(DISTINCT actor_user_id) FROM public.signup_attempts
                WHERE created_at >= v_from AND created_at < v_to AND status NOT IN ('allowed','abandoned')),
    'blocked_ips', (SELECT count(DISTINCT ip) FROM public.signup_attempts
                WHERE created_at >= v_from AND created_at < v_to AND status NOT IN ('allowed','abandoned'))
  ) INTO v_signups;

  -- ----------------------------------------------------------- App errors
  WITH e AS (
    SELECT user_id, message FROM public.client_error_reports
    WHERE created_at >= v_from AND created_at < v_to
  ), active AS (
    SELECT user_id FROM public.login_phase_events WHERE created_at >= v_from AND created_at < v_to AND user_id IS NOT NULL
    UNION SELECT user_id FROM e WHERE user_id IS NOT NULL
    UNION SELECT id FROM public.profiles WHERE last_active_at >= v_from AND last_active_at < v_to
  )
  SELECT jsonb_build_object(
    'errors', (SELECT count(*) FROM e),
    'affected_users', (SELECT count(DISTINCT user_id) FROM e),
    'active_users', (SELECT count(*) FROM active),
    'offline_storage', (SELECT count(*) FROM e WHERE message ILIKE '%IDBDatabase%' OR message ILIKE '%indexeddb%'),
    'map_crash', (SELECT count(*) FROM e WHERE message ILIKE '%M_ID%'),
    'top_messages', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('message', m, 'n', n) ORDER BY n DESC)
      FROM (SELECT left(coalesce(message,'unknown'),100) m, count(*) n FROM e GROUP BY 1 ORDER BY 2 DESC LIMIT 5) x), '[]'::jsonb),
    'top_routes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('route', r, 'n', n) ORDER BY n DESC)
      FROM (SELECT coalesce(route,'unknown') r, count(*) n FROM public.client_error_reports
            WHERE created_at >= v_from AND created_at < v_to GROUP BY 1 ORDER BY 2 DESC LIMIT 5) x), '[]'::jsonb)
  ) INTO v_errors FROM (SELECT 1) one;

  -- ------------------------------------------------------ Database / uptime
  -- Per-day rollback deltas from db_stat_snapshots (taken ~23:55 EAT). A day is
  -- measurable only if the previous day's snapshot exists AND the counters did
  -- not go backwards (a restart resets them). Unmeasurable days are reported as
  -- such, never silently dropped.
  SELECT xact_commit, xact_rollback, deadlocks INTO v_live_commit, v_live_rollback, v_live_deadlocks
  FROM pg_stat_database WHERE datname = current_database();

  WITH days AS (
    SELECT g::date AS d FROM generate_series(p_date - 6, p_date, interval '1 day') g
  ), snap AS (
    SELECT d.d,
      CASE WHEN d.d = v_today THEN v_live_commit   ELSE s.xact_commit   END AS c,
      CASE WHEN d.d = v_today THEN v_live_rollback ELSE s.xact_rollback END AS r,
      CASE WHEN d.d = v_today THEN v_live_deadlocks ELSE s.deadlocks    END AS dl,
      p.xact_commit AS pc, p.xact_rollback AS pr, p.deadlocks AS pdl
    FROM days d
    LEFT JOIN public.db_stat_snapshots s ON s.day = d.d
    LEFT JOIN public.db_stat_snapshots p ON p.day = d.d - 1
  ), calc AS (
    SELECT d,
      (c IS NOT NULL AND pc IS NOT NULL AND c >= pc AND r >= pr) AS ok,
      (c IS NOT NULL AND pc IS NOT NULL AND (c < pc OR r < pr)) AS reset,
      c - pc AS dc, r - pr AS dr, GREATEST(dl - pdl, 0) AS ddl
    FROM snap
  )
  SELECT jsonb_build_object(
    'days', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'd', d, 'ok', ok, 'reset', reset,
        'commits', CASE WHEN ok THEN dc END, 'rollbacks', CASE WHEN ok THEN dr END,
        'rate', CASE WHEN ok THEN round(100.0 * dr / NULLIF(dc + dr, 0), 1) END,
        'deadlocks', CASE WHEN ok THEN ddl END) ORDER BY d) FROM calc), '[]'::jsonb),
    'measured_days', (SELECT count(*) FROM calc WHERE ok),
    'commits', (SELECT COALESCE(sum(dc),0) FROM calc WHERE ok),
    'rollbacks', (SELECT COALESCE(sum(dr),0) FROM calc WHERE ok),
    'deadlocks', (SELECT COALESCE(sum(ddl),0) FROM calc WHERE ok),
    'postmaster_start', v_pm_start,
    'restarted_in_window', (v_pm_start >= v_from AND v_pm_start < v_to),
    'uptime_hours', round((EXTRACT(epoch FROM (now() - v_pm_start)) / 3600.0)::numeric, 1),
    'lifetime_rollback_pct', round(100.0 * v_live_rollback / NULLIF(v_live_commit + v_live_rollback, 0), 1),
    'cache_hit_pct', (SELECT round(100.0 * blks_hit / NULLIF(blks_hit + blks_read, 0), 2) FROM pg_stat_database WHERE datname = current_database()),
    'connections', (SELECT count(*) FROM pg_stat_activity),
    'max_connections', (SELECT setting::int FROM pg_settings WHERE name = 'max_connections')
  ) INTO v_db;

  BEGIN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('name', fn, 'mean_s', round(mean_ms / 1000.0, 0), 'calls', calls) ORDER BY mean_ms DESC), '[]'::jsonb)
    INTO v_slow
    FROM (
      SELECT substring(query from 'public\.([a-z_0-9]+)\(') AS fn, mean_exec_time AS mean_ms, calls
      FROM extensions.pg_stat_statements
      WHERE query ILIKE 'select public.%' AND calls > 20 AND mean_exec_time > 5000
      ORDER BY mean_exec_time DESC LIMIT 5
    ) x WHERE fn IS NOT NULL;
  EXCEPTION WHEN OTHERS THEN
    v_slow := '[]'::jsonb;
  END;

  -- ----------------------------------------------------- Jobs and security
  SELECT jsonb_build_object(
    'scheduled', (SELECT count(*) FROM cron.job),
    'runs', (SELECT count(*) FROM public.cto_cron_run_details WHERE start_time >= v_from AND start_time < v_to),
    'failed', (SELECT count(*) FROM public.cto_cron_run_details WHERE start_time >= v_from AND start_time < v_to AND status <> 'succeeded'),
    'failed_24h', (SELECT count(*) FROM public.cto_cron_run_details WHERE start_time >= v_to - interval '24 hours' AND start_time < v_to AND status <> 'succeeded'),
    'failing', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('job', jobname, 'n', n, 'error', last_error) ORDER BY n DESC)
      FROM (
        SELECT COALESCE(j.jobname, '(unscheduled) ' || COALESCE(substring(d.command from 'public\.([a-zA-Z_0-9]+)'), 'unknown')) AS jobname,
               count(*) n, max(left(COALESCE(d.return_message,''), 140)) AS last_error
        FROM public.cto_cron_run_details d LEFT JOIN cron.job j USING (jobid)
        WHERE d.start_time >= v_from AND d.start_time < v_to AND d.status <> 'succeeded'
        GROUP BY j.jobid, j.jobname, d.command ORDER BY n DESC LIMIT 5
      ) f), '[]'::jsonb)
  ) INTO v_jobs;

  SELECT jsonb_build_object(
    'rls_tables', (SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relrowsecurity),
    'public_tables', (SELECT count(*) FROM pg_tables WHERE schemaname = 'public'),
    'fraud_blocks_active', (SELECT count(*) FROM public.fraud_identity_blocks WHERE status = 'active'),
    'privileged_accounts', (SELECT count(DISTINCT user_id) FROM public.user_roles
                            WHERE role IN ('super_admin','manager','cto','ceo','cfo','coo','access_admin'))
  ) INTO v_sec;

  SELECT jsonb_build_object(
    'runs', count(*),
    'failures', count(*) FILTER (WHERE status <> 'success'),
    'latest', max(created_at) FILTER (WHERE status = 'success'),
    'full', count(*) FILTER (WHERE backup_kind IS DISTINCT FROM 'ledger' AND status = 'success')
  ) INTO v_backups
  FROM public.backup_runs WHERE created_at >= v_from AND created_at < v_to;

  RETURN jsonb_build_object(
    'closing_date', p_date,
    'window_from', v_from,
    'window_to', v_to,
    'partial_day', v_partial,
    'generated_at', now(),
    'sms', v_sms,
    'sms_days', v_sms_days,
    'sms_streams', v_sms_streams,
    'email', v_email,
    'signin', v_signin,
    'otp', v_otp,
    'otp_login', v_otp_login,
    'signups', v_signups,
    'errors', v_errors,
    'db', v_db,
    'slow_jobs', v_slow,
    'jobs', v_jobs,
    'security', v_sec,
    'backups', v_backups
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_board_tech_memo(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_board_tech_memo(date) TO authenticated, postgres, service_role;

