-- 2026-10-24: CFO Payables -> Partner Products and Services: Paid & Outstanding (CFO request). REPORTING ONLY.
--
-- Two read-only functions for the Partner page:
--   get_partner_paid_outstanding(p_from, p_to)        summary of the five components, paid and outstanding
--   get_partner_paid_outstanding_items(component, status, p_from, p_to, limit, offset)   the records behind a figure
--
-- PAID (in the date range, Kampala days; NULL = all time), from ledger evidence only:
--   Partner Returns paid in cash   wallet credits, category roi_wallet_credit (net of roi_wallet_credit wallet debits),
--                                  split by who received them: the partner's own wallet, or another wallet (a managing
--                                  Proxy Agent's, for managed accounts)
--   Partner Returns reinvested     roi_reinvestment entries (compounding). Reinvestment groups carry no wallet credit,
--                                  so cash and reinvested are never added together or counted twice.
--   UGX 1,500 registration bonus, 2% fulfilment, 1% top-up, UGX 1,000 lead override, historical recalculation top-ups:
--                                  taken unchanged from get_partner_promissory_commissions (already live, tested).
-- OUTSTANDING (as at now):
--   Partner Returns due            the Partner payables lines (v_payables_lines, product supporter_returns), split by
--                                  status (overdue / due in the range or next 30 days / later) and by cash payout vs
--                                  compounding. Confirmed-unpaid commissions come from the same payables lines.
--   Pending, not owed              the commission report's investigation items; never in any total.
-- RECONCILIATION: outstanding Returns + unpaid commissions = the Partner payables total; commission events vs wallet
--   credits; possible double Return credits (two credits for one portfolio within 3 days) are flagged, not removed.
--
-- No ledger entry, wallet, payout, balance or financial record is written or changed. Access: payables_guard() (the
-- same roles as the Payables page). New functions are closed by default; granted to authenticated and service_role.
-- TRANSACTION: run as ONE transaction (by hand: BEGIN; ... COMMIT;). The guard changes nothing when it refuses.
-- Rollback: supabase/rollbacks/20261024110000_partner_paid_outstanding.rollback.sql

SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF to_regprocedure('public.get_partner_paid_outstanding(date,date)') IS NOT NULL
     OR to_regprocedure('public.get_partner_paid_outstanding_items(text,text,date,date,integer,integer)') IS NOT NULL
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.get_partner_promissory_commissions(date,date)'::regprocedure)
          IS DISTINCT FROM '5a9dac229e6aef10d346ca8e5edb7939'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.payables_guard()'::regprocedure)
          IS DISTINCT FROM '9c689067513252c28fa5f61be3fde296'
     OR to_regclass('public.v_payables_lines') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: the functions already exist, or the commission report / payables guard changed since 2026-10-24; nothing was changed';
  END IF;
END
$pre$;

CREATE FUNCTION public.get_partner_paid_outstanding(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_lo timestamptz := CASE WHEN p_from IS NULL THEN NULL ELSE p_from::timestamp AT TIME ZONE 'Africa/Kampala' END;
  v_hi timestamptz := CASE WHEN p_to IS NULL THEN NULL ELSE (p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala' END;
  v_due_to date;
  v_comm jsonb;
  v_result jsonb;
BEGIN
  PERFORM payables_guard();
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
    RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023';
  END IF;
  v_due_to := COALESCE(p_to, v_today + 30);
  v_comm := get_partner_promissory_commissions(p_from, p_to);

  WITH cash AS MATERIALIZED (
    SELECT g.id, g.user_id, g.amount, g.direction, g.source_table, g.source_id, g.transaction_date, ip.investor_id
      FROM general_ledger g
      LEFT JOIN investor_portfolios ip ON g.source_table = 'investor_portfolios' AND ip.id = g.source_id
     WHERE g.category = 'roi_wallet_credit' AND g.ledger_scope = 'wallet'
       AND (v_lo IS NULL OR g.transaction_date >= v_lo) AND (v_hi IS NULL OR g.transaction_date < v_hi)
  ), reinv AS MATERIALIZED (
    SELECT g.id, g.user_id, g.amount, g.source_id
      FROM general_ledger g
     WHERE g.category = 'roi_reinvestment' AND g.direction = 'cash_in' AND g.ledger_scope = 'platform'
       AND (v_lo IS NULL OR g.transaction_date >= v_lo) AND (v_hi IS NULL OR g.transaction_date < v_hi)
  ), cin AS (SELECT * FROM cash WHERE direction = 'cash_in'),
  dbl AS (
    SELECT a.source_id, b.amount
      FROM cin a JOIN cin b ON a.source_id = b.source_id AND a.id < b.id
       AND abs(extract(epoch FROM b.transaction_date - a.transaction_date)) <= 3 * 86400
     WHERE a.source_table = 'investor_portfolios'
  ), lines AS MATERIALIZED (
    SELECT l.product_key, l.item_id, l.outstanding_amount, l.due_date, ip.roi_mode
      FROM v_payables_lines l
      LEFT JOIN investor_portfolios ip ON l.source_table = 'investor_portfolios' AND ip.id = l.item_id
     WHERE l.category_key = 'partner'
  ), ret AS (SELECT * FROM lines WHERE product_key = 'supporter_returns')
  SELECT jsonb_build_object(
    'as_at', now(),
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'outstanding_due_to', v_due_to),
    'paid', jsonb_build_object(
      'returns_cash', jsonb_build_object(
        'count', (SELECT count(*) FROM cin),
        'amount', (SELECT COALESCE(sum(amount), 0) FROM cin) - (SELECT COALESCE(sum(amount), 0) FROM cash WHERE direction = 'cash_out'),
        'reversed', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount), 0)) FROM cash WHERE direction = 'cash_out'),
        'payees', (SELECT count(DISTINCT user_id) FROM cin),
        'to_partner_wallet', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount), 0)) FROM cin WHERE investor_id IS NOT NULL AND user_id = investor_id),
        'to_other_wallet', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount), 0)) FROM cin WHERE investor_id IS NOT NULL AND user_id <> investor_id),
        'not_linked_to_portfolio', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount), 0)) FROM cin WHERE investor_id IS NULL)),
      'returns_reinvested', jsonb_build_object(
        'count', (SELECT count(*) FROM reinv), 'amount', (SELECT COALESCE(sum(amount), 0) FROM reinv),
        'portfolios', (SELECT count(DISTINCT source_id) FROM reinv)),
      'commissions', v_comm -> 'lines',
      'commission_totals', v_comm -> 'totals'),
    'outstanding', jsonb_build_object(
      'returns', jsonb_build_object(
        'count', (SELECT count(*) FROM ret), 'amount', (SELECT COALESCE(sum(outstanding_amount), 0) FROM ret),
        'by_status', jsonb_build_object(
          'overdue', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(outstanding_amount), 0)) FROM ret WHERE due_date < v_today),
          'due_in_period', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(outstanding_amount), 0)) FROM ret WHERE due_date >= v_today AND due_date <= v_due_to),
          'later', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(outstanding_amount), 0)) FROM ret WHERE due_date > v_due_to)),
        'by_mode', jsonb_build_object(
          'cash_payout', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(outstanding_amount), 0)) FROM ret WHERE COALESCE(roi_mode, '') NOT IN ('monthly_compounding', 'compound')),
          'compounding', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(outstanding_amount), 0)) FROM ret WHERE roi_mode IN ('monthly_compounding', 'compound')))),
      'commissions_unpaid', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(outstanding_amount), 0)) FROM lines WHERE product_key LIKE 'proxy\_%'),
      'pending_not_owed', v_comm -> 'investigation_items'),
    'reconciliation', jsonb_build_object(
      'partner_payables_total', (SELECT COALESCE(sum(outstanding_amount), 0) FROM lines),
      'returns_plus_unpaid_commissions', (SELECT COALESCE(sum(outstanding_amount), 0) FROM lines WHERE product_key = 'supporter_returns' OR product_key LIKE 'proxy\_%'),
      'other_partner_lines', (SELECT count(*) FROM lines WHERE product_key <> 'supporter_returns' AND product_key NOT LIKE 'proxy\_%'),
      'ties_out', (SELECT COALESCE(sum(outstanding_amount), 0) FROM lines) =
                  (SELECT COALESCE(sum(outstanding_amount), 0) FROM lines WHERE product_key = 'supporter_returns' OR product_key LIKE 'proxy\_%'),
      'commission_unpaid_matches_report', (SELECT COALESCE(sum(outstanding_amount), 0) FROM lines WHERE product_key LIKE 'proxy\_%') = COALESCE((v_comm -> 'totals' ->> 'unpaid_in_payables')::numeric, 0),
      'possible_double_return_credits', (SELECT jsonb_build_object('pairs', count(*), 'second_credit_amount', COALESCE(sum(amount), 0)) FROM dbl)),
    'basis', jsonb_build_object(
      'paid', 'Paid = credited to a wallet (ledger wallet credit) or reinvested (ledger reinvestment entry), in the selected Kampala dates. Reinvested Returns are not cash and are never added to cash Returns.',
      'outstanding', 'Outstanding = the Partner payables lines as at now (the same lines as this page). Pending items are not owed until confirmed and are in no total.'))
  INTO v_result;
  RETURN v_result;
END
$function$;

CREATE FUNCTION public.get_partner_paid_outstanding_items(p_component text, p_status text DEFAULT 'all'::text,
  p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_lo timestamptz := CASE WHEN p_from IS NULL THEN NULL ELSE p_from::timestamp AT TIME ZONE 'Africa/Kampala' END;
  v_hi timestamptz := CASE WHEN p_to IS NULL THEN NULL ELSE (p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala' END;
  v_due_to date := COALESCE(p_to, (now() AT TIME ZONE 'Africa/Kampala')::date + 30);
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_rows jsonb;
  v_count bigint;
BEGIN
  PERFORM payables_guard();
  IF p_component IS NULL OR p_component NOT IN ('returns_cash', 'returns_reinvested', 'returns_outstanding', 'registration_bonus',
       'lead_override', 'fulfilment_commission', 'topup_commission', 'recalculation_topup', 'commissions_unpaid') THEN
    RAISE EXCEPTION 'unknown component %', p_component USING ERRCODE = '22023';
  END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
    RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023';
  END IF;

  IF p_component IN ('returns_cash', 'returns_reinvested') THEN
    WITH r AS (
      SELECT g.id, g.transaction_date, g.amount, g.direction, g.user_id, g.source_id, g.transaction_group_id, g.description
        FROM general_ledger g
       WHERE ((p_component = 'returns_cash' AND g.category = 'roi_wallet_credit' AND g.ledger_scope = 'wallet')
           OR (p_component = 'returns_reinvested' AND g.category = 'roi_reinvestment' AND g.ledger_scope = 'platform' AND g.direction = 'cash_in'))
         AND (v_lo IS NULL OR g.transaction_date >= v_lo) AND (v_hi IS NULL OR g.transaction_date < v_hi))
    SELECT (SELECT count(*) FROM r),
           COALESCE((SELECT jsonb_agg(x ORDER BY x->>'date' DESC, x->>'ledger_id') FROM (
             SELECT jsonb_build_object('ledger_id', r.id, 'group_id', r.transaction_group_id, 'date', r.transaction_date,
                      'amount', CASE WHEN r.direction = 'cash_out' THEN -r.amount ELSE r.amount END,
                      'paid_to', COALESCE(pw.full_name, 'Unknown'), 'paid_to_id', r.user_id,
                      'partner', COALESCE(pp.full_name, 'Unknown'), 'portfolio', ip.portfolio_code,
                      'to_partner_wallet', ip.investor_id IS NOT NULL AND ip.investor_id = r.user_id,
                      'status', CASE WHEN r.direction = 'cash_out' THEN 'reversed' WHEN p_component = 'returns_cash' THEN 'credited' ELSE 'reinvested' END,
                      'description', left(r.description, 160)) x
               FROM r
               LEFT JOIN investor_portfolios ip ON ip.id = r.source_id
               LEFT JOIN profiles pw ON pw.id = r.user_id
               LEFT JOIN profiles pp ON pp.id = ip.investor_id
              ORDER BY r.transaction_date DESC, r.id LIMIT v_limit OFFSET v_offset) s), '[]'::jsonb)
      INTO v_count, v_rows;

  ELSIF p_component = 'returns_outstanding' THEN
    WITH r AS (
      SELECT l.*, ip.roi_mode, ip.portfolio_code
        FROM v_payables_lines l LEFT JOIN investor_portfolios ip ON ip.id = l.item_id
       WHERE l.category_key = 'partner' AND l.product_key = 'supporter_returns'
         AND (COALESCE(p_status, 'all') = 'all'
           OR (p_status = 'overdue' AND l.due_date < v_today)
           OR (p_status = 'due_in_period' AND l.due_date >= v_today AND l.due_date <= v_due_to)
           OR (p_status = 'later' AND l.due_date > v_due_to)
           OR (p_status = 'compounding' AND ip.roi_mode IN ('monthly_compounding', 'compound'))
           OR (p_status = 'cash_payout' AND COALESCE(ip.roi_mode, '') NOT IN ('monthly_compounding', 'compound'))))
    SELECT (SELECT count(*) FROM r),
           COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'due_date') NULLS LAST, x->>'item_id') FROM (
             SELECT jsonb_build_object('item_id', r.item_id, 'portfolio', r.portfolio_code, 'partner', r.counterparty_name,
                      'partner_id', r.counterparty_id, 'amount', r.outstanding_amount, 'due_date', r.due_date, 'mode', r.roi_mode,
                      'status', CASE WHEN r.due_date < v_today THEN 'overdue' WHEN r.due_date <= v_due_to THEN 'due_in_period' ELSE 'later' END) x
               FROM r ORDER BY r.due_date NULLS LAST, r.item_id LIMIT v_limit OFFSET v_offset) s), '[]'::jsonb)
      INTO v_count, v_rows;

  ELSIF p_component IN ('registration_bonus', 'lead_override') THEN
    WITH r AS (
      SELECT g.id, g.transaction_date, g.amount, g.direction, g.user_id, g.source_id, g.transaction_group_id, g.idempotency_key
        FROM general_ledger g
       WHERE g.source_table = 'promissory_notes' AND g.ledger_scope = 'wallet'
         AND ((p_component = 'registration_bonus' AND g.idempotency_key IN ('promissory_note_verified:' || g.source_id::text, 'promissory_note_reversed:' || g.source_id::text || ':agent'))
           OR (p_component = 'lead_override' AND g.idempotency_key IN ('promissory_note_lead:' || g.source_id::text, 'promissory_note_reversed:' || g.source_id::text || ':lead')))
         AND (v_lo IS NULL OR g.transaction_date >= v_lo) AND (v_hi IS NULL OR g.transaction_date < v_hi))
    SELECT (SELECT count(*) FROM r),
           COALESCE((SELECT jsonb_agg(x ORDER BY x->>'date' DESC, x->>'ledger_id') FROM (
             SELECT jsonb_build_object('ledger_id', r.id, 'group_id', r.transaction_group_id, 'date', r.transaction_date,
                      'amount', CASE WHEN r.direction = 'cash_out' THEN -r.amount ELSE r.amount END,
                      'paid_to', COALESCE(p.full_name, 'Unknown'), 'paid_to_id', r.user_id, 'note_id', r.source_id,
                      'note_partner', n.partner_name, 'note_exists', n.id IS NOT NULL,
                      'status', CASE WHEN r.direction = 'cash_out' THEN 'reversed' ELSE 'credited' END) x
               FROM r LEFT JOIN profiles p ON p.id = r.user_id LEFT JOIN promissory_notes n ON n.id = r.source_id
              ORDER BY r.transaction_date DESC, r.id LIMIT v_limit OFFSET v_offset) s), '[]'::jsonb)
      INTO v_count, v_rows;

  ELSIF p_component IN ('fulfilment_commission', 'topup_commission', 'recalculation_topup') THEN
    WITH r AS (
      SELECT pe.*, g.transaction_date AS credited_at, g.id AS ledger_id
        FROM promissory_commission_events pe
        CROSS JOIN LATERAL (SELECT g.id, g.transaction_date FROM general_ledger g
                             WHERE g.transaction_group_id = pe.ledger_group_id AND g.ledger_scope = 'wallet' AND g.direction = 'cash_in'
                               AND g.user_id = pe.agent_id AND g.amount = pe.amount ORDER BY g.transaction_date LIMIT 1) g
       WHERE pe.status = 'paid'
         AND pe.kind = CASE p_component WHEN 'fulfilment_commission' THEN 'portfolio_creation' WHEN 'topup_commission' THEN 'portfolio_topup' ELSE 'recompute_adjustment' END
         AND (v_lo IS NULL OR g.transaction_date >= v_lo) AND (v_hi IS NULL OR g.transaction_date < v_hi))
    SELECT (SELECT count(*) FROM r),
           COALESCE((SELECT jsonb_agg(x ORDER BY x->>'date' DESC, x->>'event_id') FROM (
             SELECT jsonb_build_object('event_id', r.id, 'ledger_id', r.ledger_id, 'group_id', r.ledger_group_id, 'date', r.credited_at,
                      'amount', r.amount, 'base_amount', r.base_amount, 'rate', r.rate,
                      'paid_to', COALESCE(a.full_name, 'Unknown'), 'paid_to_id', r.agent_id,
                      'partner', COALESCE(pp.full_name, 'Unknown'), 'partner_id', r.partner_id, 'note_id', r.note_id, 'status', 'credited') x
               FROM r LEFT JOIN profiles a ON a.id = r.agent_id LEFT JOIN profiles pp ON pp.id = r.partner_id
              ORDER BY r.credited_at DESC, r.id LIMIT v_limit OFFSET v_offset) s), '[]'::jsonb)
      INTO v_count, v_rows;

  ELSE -- commissions_unpaid
    WITH r AS (SELECT * FROM v_payables_lines WHERE category_key = 'partner' AND product_key LIKE 'proxy\_%')
    SELECT (SELECT count(*) FROM r),
           COALESCE((SELECT jsonb_agg(x ORDER BY x->>'due_date', x->>'item_id') FROM (
             SELECT jsonb_build_object('item_id', r.item_id, 'component', r.product_key, 'label', r.product_label, 'payee', r.counterparty_name,
                      'payee_id', r.counterparty_id, 'amount', r.outstanding_amount, 'due_date', r.due_date, 'status', r.status, 'source', r.source_table) x
               FROM r ORDER BY r.due_date, r.item_id LIMIT v_limit OFFSET v_offset) s), '[]'::jsonb)
      INTO v_count, v_rows;
  END IF;

  RETURN jsonb_build_object('component', p_component, 'status', COALESCE(p_status, 'all'), 'from', p_from, 'to', p_to,
                            'total_count', v_count, 'limit', v_limit, 'offset', v_offset, 'items', v_rows);
END
$function$;

REVOKE ALL ON FUNCTION public.get_partner_paid_outstanding(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_partner_paid_outstanding(date, date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_partner_paid_outstanding_items(text, text, date, date, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_partner_paid_outstanding_items(text, text, date, date, integer, integer) TO authenticated, service_role;

RESET lock_timeout;
