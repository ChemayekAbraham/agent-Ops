-- Verbatim production copy (16 Nov 2026 after items 1-2, read-only export).
CREATE OR REPLACE FUNCTION public.fin_controls(p_as_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_at   timestamptz := COALESCE(p_as_at, now());
  v_bs   jsonb;
  v_cf   jsonb;
  v_out  jsonb := '[]'::jsonb;
  v_n    bigint; v_amt numeric; v_detail jsonb;
  v_month_start timestamptz := date_trunc('month', v_at AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala';
BEGIN
  IF NOT public._fin_can_view() THEN
    RAISE EXCEPTION 'Not authorised to view accounting controls';
  END IF;

  -- C01 Balance Sheet equality
  v_bs := public.fin_balance_sheet(v_at);
  v_amt := COALESCE((v_bs->'balance_check'->>'difference')::numeric, 0);
  v_out := v_out || jsonb_build_object('id','C01','name','Assets = Liabilities + Equity',
    'status', CASE WHEN abs(v_amt) < 1 THEN 'ok' ELSE 'fail' END, 'value', ROUND(v_amt),
    'detail', 'Difference on the Balance Sheet. Unbalanced groups are listed in control C02.');

  -- C02 Groups unbalanced after mapping, logged by the posting control in the last 30 days
  SELECT COUNT(*), COALESCE(SUM(abs(residual)),0),
         COALESCE(jsonb_agg(jsonb_build_object('group', transaction_group_id, 'residual', ROUND(residual), 'source', source_table, 'at', detected_at) ORDER BY detected_at DESC) FILTER (WHERE rn <= 10), '[]'::jsonb)
    INTO v_n, v_amt, v_detail
  FROM (SELECT v.*, row_number() OVER (ORDER BY detected_at DESC) rn FROM public.ledger_mapped_balance_violations v
        WHERE detected_at > v_at - interval '30 days') z;
  v_out := v_out || jsonb_build_object('id','C02','name','Entries unbalanced after account mapping (last 30 days)',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'fail' END, 'value', v_n, 'amount', ROUND(v_amt), 'detail', v_detail);

  -- C03 Suspense balances (A9 debit suspense and L9 credit suspense)
  v_amt := COALESCE((SELECT SUM(abs((e->>'value')::numeric)) FROM jsonb_array_elements(
             COALESCE(v_bs->'assets'->'current','[]'::jsonb) || COALESCE(v_bs->'liabilities'->'current','[]'::jsonb)) e
           WHERE e->>'source' LIKE '%account A9' OR e->>'source' LIKE '%account L9'), 0);
  v_out := v_out || jsonb_build_object('id','C03','name','Suspense (unmapped postings) balance',
    'status', CASE WHEN abs(v_amt) < 1 THEN 'ok' ELSE 'warn' END, 'value', ROUND(v_amt));

  -- C05 Cash Flow explained in full (current month)
  v_cf := public.fin_cash_flow(v_month_start, v_at);
  v_amt := COALESCE((v_cf->>'unexplained_difference')::numeric, 0);
  v_out := v_out || jsonb_build_object('id','C05','name','Cash Flow fully explained this month (no balancing line)',
    'status', CASE WHEN abs(v_amt) < 1 THEN 'ok' ELSE 'fail' END, 'value', ROUND(v_amt),
    'detail', v_cf->'unexplained_groups');

  -- C06 Mobile-money balances reported by provider SMS (freshness)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('channel', channel, 'balance', balance, 'at', at,
                     'hours_old', ROUND(EXTRACT(EPOCH FROM (v_at - at)) / 3600, 1))), '[]'::jsonb),
         COUNT(*) FILTER (WHERE at < v_at - interval '24 hours')
    INTO v_detail, v_n
  FROM (SELECT DISTINCT ON (channel) channel, balance, COALESCE(internal_date, created_at) at
        FROM public.gmail_transactions
        WHERE channel IN ('mtn_momo','airtel_money') AND balance IS NOT NULL AND from_email ILIKE '%ifttt%'
        ORDER BY channel, COALESCE(internal_date, created_at) DESC) z;
  v_out := v_out || jsonb_build_object('id','C06','name','Mobile-money line balances (provider SMS)',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'warn' END, 'value', v_n, 'detail', v_detail);

  -- C08 Deposits marked "banked" without a matching Equity credit email (same amount, ±3 days)
  WITH latest AS (
    SELECT DISTINCT ON (v.deposit_request_id) v.deposit_request_id, v.amount, v.status, COALESCE(v.verified_at, v.created_at) at
    FROM public.cash_deposit_verifications v ORDER BY v.deposit_request_id, v.created_at DESC
  ), banked AS (
    SELECT l.* FROM latest l JOIN public.deposit_requests dr ON dr.id = l.deposit_request_id
    WHERE l.status = 'verified' AND COALESCE(dr.purpose_audit->>'cash_location','cash_at_hand') = 'bank'
  ), unmatched AS (
    SELECT b.* FROM banked b
    WHERE NOT EXISTS (SELECT 1 FROM public.gmail_transactions g
                      WHERE g.from_email ILIKE '%equitybank%' AND g.direction = 'in' AND g.amount = b.amount
                        AND COALESCE(g.internal_date, g.created_at) BETWEEN b.at - interval '3 days' AND b.at + interval '3 days')
  )
  SELECT COUNT(*), COALESCE(SUM(amount),0) INTO v_n, v_amt FROM unmatched;
  v_out := v_out || jsonb_build_object('id','C08','name','Deposits marked banked with no matching Equity credit',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'warn' END, 'value', v_n, 'amount', ROUND(v_amt),
    'detail', 'Bulk banking (several deposits in one credit) also appears here; review against bank statements.');

  -- C09 / C10 / C11 sub-ledger ties from the Balance Sheet
  SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) INTO v_detail FROM jsonb_array_elements(v_bs->'subledger_ties') e;
  v_out := v_out || jsonb_build_object('id','C09','name','Ledger vs operational records (wallets, portfolios, Rent Plans, advances, notes)',
    'status', CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_bs->'subledger_ties') e WHERE abs((e->>'difference')::numeric) >= 1)
                   THEN 'warn' ELSE 'ok' END,
    'value', (SELECT COUNT(*) FROM jsonb_array_elements(v_bs->'subledger_ties') e WHERE abs((e->>'difference')::numeric) >= 1),
    'detail', v_detail);

  -- C11 Rent Plans marked completed while still owing, measured by collections actually received
  --     (a stored balance can be typed to zero, so it cannot be the test; review 9 Nov 2026)
  WITH col AS (
    SELECT rent_request_id rr, SUM(amount) collected
    FROM public.agent_collections WHERE reversed_at IS NULL AND rent_request_id IS NOT NULL GROUP BY 1
  )
  SELECT COUNT(*), COALESCE(SUM(COALESCE(r.total_repayment,0) - COALESCE(col.collected,0)),0) INTO v_n, v_amt
  FROM public.rent_requests r LEFT JOIN col ON col.rr = r.id
  WHERE r.status = 'completed' AND COALESCE(r.total_repayment,0) - COALESCE(col.collected,0) > 0.5;
  v_out := v_out || jsonb_build_object('id','C11','name','Rent Plans completed while still owing (by collections actually received)',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'warn' END, 'value', v_n, 'amount', ROUND(v_amt),
    'detail', 'Includes plans registered with older balances and plans cleared by staff edits; review against the Tenant Repayment Tracker.');

  -- C14 Back-dated postings (transaction date more than 2 days before posting) in the last 30 days
  SELECT COUNT(*), COALESCE(SUM(amount),0) INTO v_n, v_amt
  FROM public.general_ledger
  WHERE created_at > v_at - interval '30 days' AND transaction_date < created_at - interval '2 days'
    AND classification IN ('production','legacy_real','admin_correction');
  v_out := v_out || jsonb_build_object('id','C14','name','Back-dated postings (last 30 days)',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'warn' END, 'value', v_n, 'amount', ROUND(v_amt));

  -- C15 Completed withdrawals with no ledger entry
  SELECT COUNT(*), COALESCE(SUM(w.amount),0) INTO v_n, v_amt
  FROM public.withdrawal_requests w
  WHERE w.status IN ('completed','paid')
    AND NOT EXISTS (SELECT 1 FROM public.general_ledger g WHERE g.source_table = 'withdrawal_requests' AND g.source_id = w.id);
  v_out := v_out || jsonb_build_object('id','C15','name','Paid withdrawals with no ledger entry',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'fail' END, 'value', v_n, 'amount', ROUND(v_amt));

  -- C16 Abnormal merchandise recovery plans
  SELECT COUNT(*), COALESCE(SUM(outstanding_balance),0),
         COALESCE(jsonb_agg(jsonb_build_object('plan', id, 'item', item_name, 'outstanding', ROUND(outstanding_balance), 'daily', ROUND(daily_deduction_amount), 'status', status)), '[]'::jsonb)
    INTO v_n, v_amt, v_detail
  FROM public.merchandise_recovery_plans
  WHERE status = 'active' AND (COALESCE(original_amount,0) > 50000000 OR COALESCE(daily_deduction_amount,0) > 2000000);
  v_out := v_out || jsonb_build_object('id','C16','name','Abnormal merchandise recovery plans (> 50M or > 2M a day)',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'fail' END, 'value', v_n, 'amount', ROUND(v_amt), 'detail', v_detail);

  -- C19 Landlord payouts still open on Rent Plans whose funding was reversed (allocation returned)
  WITH rev AS (
    SELECT g.source_id rr FROM public.general_ledger g
    WHERE g.source_table = 'rent_requests' AND g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
    GROUP BY 1 HAVING SUM(CASE WHEN g.direction = 'cash_out' THEN g.amount ELSE -g.amount END) <= 0.5
                  AND bool_or(g.direction = 'cash_in')
  )
  SELECT COUNT(*), COALESCE(SUM(p.amount),0),
         COALESCE(jsonb_agg(jsonb_build_object('payout', p.id, 'rent_request', p.rent_request_id, 'amount', p.amount, 'status', p.status, 'created', p.created_at)), '[]'::jsonb)
    INTO v_n, v_amt, v_detail
  FROM public.landlord_payouts p JOIN rev ON rev.rr = p.rent_request_id
  WHERE p.status IN ('pending','otp_verified','pending_merchant_payout');
  v_out := v_out || jsonb_build_object('id','C19','name','Landlord payouts still open after the allocation was returned',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'fail' END, 'value', v_n, 'amount', ROUND(v_amt), 'detail', v_detail);

  -- C20 Rent Plans funded in the ledger with no successful landlord payout after 7 days
  WITH led AS (
    SELECT g.source_id rr, SUM(CASE WHEN g.direction = 'cash_out' THEN g.amount ELSE -g.amount END) net, MIN(g.transaction_date) first_d
    FROM public.general_ledger g
    WHERE g.source_table = 'rent_requests' AND g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
      AND g.classification IN ('production','legacy_real')
    GROUP BY 1
  )
  SELECT COUNT(*), COALESCE(SUM(led.net),0) INTO v_n, v_amt
  FROM led
  WHERE led.net > 0.5 AND led.first_d < v_at - interval '7 days' AND led.first_d >= timestamptz '2026-06-01 00:00+03'
    AND NOT EXISTS (SELECT 1 FROM public.landlord_payouts p WHERE p.rent_request_id = led.rr
                    AND p.status IN ('completed','awaiting_agent_receipt','pending_merchant_payout'));
  v_out := v_out || jsonb_build_object('id','C20','name','Rent Plans funded in the ledger with no landlord payout (since June, older than 7 days)',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'warn' END, 'value', v_n, 'amount', ROUND(v_amt));

  -- C21 Admin-correction wallet legs (move wallets, excluded from statements) in the last 30 days
  SELECT COUNT(*), COALESCE(SUM(amount),0) INTO v_n, v_amt
  FROM public.general_ledger gl
  WHERE gl.ledger_scope = 'wallet' AND gl.classification = 'admin_correction' AND gl.created_at > v_at - interval '30 days'
    AND NOT EXISTS (SELECT 1 FROM public.general_ledger g2 WHERE g2.transaction_group_id = gl.transaction_group_id
                    AND g2.classification IN ('production','legacy_real'));
  v_out := v_out || jsonb_build_object('id','C21','name','Wallet corrections left out of the statements (last 30 days)',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'warn' END, 'value', v_n, 'amount', ROUND(v_amt));

  RETURN jsonb_build_object('as_at', v_at, 'generated_at', now(), 'controls', v_out,
    'summary', jsonb_build_object(
      'fail', (SELECT COUNT(*) FROM jsonb_array_elements(v_out) e WHERE e->>'status' = 'fail'),
      'warn', (SELECT COUNT(*) FROM jsonb_array_elements(v_out) e WHERE e->>'status' = 'warn'),
      'ok',   (SELECT COUNT(*) FROM jsonb_array_elements(v_out) e WHERE e->>'status' = 'ok')));
END;
$function$;
