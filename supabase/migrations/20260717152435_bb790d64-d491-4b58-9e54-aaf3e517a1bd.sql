
CREATE OR REPLACE FUNCTION public.get_agent_advance_repayment_monitor(_days integer DEFAULT 7)
 RETURNS TABLE(advance_id uuid, agent_id uuid, full_name text, phone text, avatar_url text, status text, principal numeric, outstanding_balance numeric, arrears_balance numeric, access_fee numeric, scheduled_daily numeric, issued_at timestamp with time zone, expires_at timestamp with time zone, is_overdue boolean, withdrawable numeric, repaid_today numeric, deduction_status_today text, paid_today boolean, repaid_window numeric, missed_days_window integer, paid_days_window integer, last_deduction_date date, last_deduction_amount numeric, collections_today numeric, collections_count_today bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_since date := (now() AT TIME ZONE 'Africa/Kampala')::date - GREATEST(COALESCE(_days, 7), 1);
BEGIN
  RETURN QUERY
  SELECT
    a.id, a.agent_id, p.full_name, p.phone, p.avatar_url, a.status,
    a.principal, a.outstanding_balance,
    COALESCE(a.arrears_balance, 0)::numeric,
    COALESCE(a.access_fee, 0)::numeric,
    (CASE WHEN COALESCE(a.cycle_days, 30) > 0
          THEN round((a.principal + COALESCE(a.access_fee, 0)) / COALESCE(a.cycle_days, 30))
          ELSE 0 END)::numeric,
    a.issued_at, a.expires_at,
    (now() > a.expires_at),
    GREATEST(0, COALESCE(public.get_user_available_balance(a.agent_id), 0))::numeric,
    COALESCE(td.amt, 0)::numeric,
    COALESCE(td.status, 'none'),
    (COALESCE(td.amt, 0) > 0),
    COALESCE(win.repaid, 0)::numeric,
    COALESCE(win.missed, 0)::int,
    COALESCE(win.paid, 0)::int,
    last.d, last.amt,
    COALESCE(ct.amt, 0)::numeric,
    COALESCE(ct.cnt, 0)::bigint
  FROM public.agent_advances a
  JOIN public.profiles p ON p.id = a.agent_id
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(l.amount_deducted), 0) AS amt,
           CASE
             WHEN BOOL_OR(l.deduction_status = 'full')     THEN 'full'
             WHEN COALESCE(SUM(l.amount_deducted), 0) > 0  THEN 'partial'
             ELSE 'none'
           END AS status
    FROM public.agent_advance_ledger l
    WHERE l.advance_id = a.id AND l.date = v_today
  ) td ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(l.amount_deducted), 0) AS repaid,
           COUNT(DISTINCT l.date) FILTER (WHERE l.deduction_status = 'none') AS missed,
           COUNT(DISTINCT l.date) FILTER (WHERE l.deduction_status IN ('full','partial')) AS paid
    FROM public.agent_advance_ledger l
    WHERE l.advance_id = a.id AND l.date >= v_since
  ) win ON true
  LEFT JOIN LATERAL (
    SELECT l.date AS d, SUM(l.amount_deducted) AS amt
    FROM public.agent_advance_ledger l
    WHERE l.advance_id = a.id AND l.amount_deducted > 0
    GROUP BY l.date
    ORDER BY l.date DESC
    LIMIT 1
  ) last ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(c.amount), 0) AS amt, COUNT(*) AS cnt
    FROM public.agent_collections c
    WHERE c.agent_id = a.agent_id
      AND (c.created_at AT TIME ZONE 'Africa/Kampala')::date = v_today
  ) ct ON true
  WHERE a.status IN ('active', 'overdue')
  ORDER BY (COALESCE(td.amt, 0) > 0) ASC, COALESCE(a.arrears_balance, 0) DESC, a.outstanding_balance DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sweep_agent_advance_recovery()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent record; v_adv record;
  v_avail numeric; v_deduct numeric; v_closing numeric;
  v_total_payable numeric; v_total_deducted numeric;
  v_fee_ratio numeric; v_new_fee numeric; v_fee_status text; v_new_status text;
  v_recovered_total numeric := 0; v_agents_touched int := 0; v_idem text;
  v_scheduled_daily numeric; v_paid_today numeric; v_daily_room numeric;
BEGIN
  FOR v_agent IN
    SELECT DISTINCT agent_id FROM public.agent_advances
    WHERE status IN ('active','overdue') AND outstanding_balance > 0
  LOOP
    v_avail := COALESCE(public.get_user_available_balance(v_agent.agent_id), 0);
    IF v_avail <= 0 THEN CONTINUE; END IF;

    FOR v_adv IN
      SELECT * FROM public.agent_advances
      WHERE agent_id = v_agent.agent_id
        AND status IN ('active','overdue') AND outstanding_balance > 0
      ORDER BY issued_at ASC
    LOOP
      EXIT WHEN v_avail <= 0;

      v_total_payable  := COALESCE(v_adv.principal, 0) + COALESCE(v_adv.access_fee, 0);
      v_scheduled_daily := CASE WHEN COALESCE(v_adv.cycle_days, 30) > 0
        THEN round(v_total_payable / COALESCE(v_adv.cycle_days, 30)) ELSE 0 END;

      SELECT COALESCE(SUM(amount_deducted), 0) INTO v_paid_today
        FROM public.agent_advance_ledger
       WHERE advance_id = v_adv.id
         AND date = (now() AT TIME ZONE 'Africa/Kampala')::date;

      v_daily_room := GREATEST(0, v_scheduled_daily + COALESCE(v_adv.arrears_balance, 0) - v_paid_today);
      IF v_daily_room <= 0 THEN CONTINUE; END IF;

      v_deduct := LEAST(v_avail, v_adv.outstanding_balance, v_daily_room);
      IF v_deduct <= 0 THEN CONTINUE; END IF;

      v_idem := 'adv_recover_' || v_adv.id::text || '_' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text;

      PERFORM public.create_ledger_transaction(
        entries => jsonb_build_array(
          jsonb_build_object(
            'user_id', v_agent.agent_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
            'amount', v_deduct, 'category', 'agent_repayment', 'recipient_type', 'user',
            'source_table', 'agent_advances', 'source_id', v_adv.id,
            'description', 'Automatic advance recovery from withdrawable balance', 'currency', 'UGX',
            'metadata', jsonb_build_object('source','auto_withdrawable_sweep','advance_id',v_adv.id,'bucket_intent','advance_balance_recovery')
          ),
          jsonb_build_object(
            'user_id', v_agent.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
            'amount', v_deduct, 'category', 'agent_repayment', 'recipient_type', 'operational_wallet',
            'source_table', 'agent_advances', 'source_id', v_adv.id,
            'description', 'Advance repayment received from agent (auto-sweep)', 'currency', 'UGX',
            'metadata', jsonb_build_object('source','auto_withdrawable_sweep','advance_id',v_adv.id,'bucket_intent','advance_balance_recovery')
          )
        ),
        idempotency_key => v_idem
      );

      v_closing := v_adv.outstanding_balance - v_deduct;
      v_new_status := CASE WHEN v_closing <= 0 THEN 'completed'
                           WHEN v_adv.expires_at < now() THEN 'overdue' ELSE 'active' END;
      v_total_deducted := v_total_payable - GREATEST(0, v_closing);
      v_fee_ratio := CASE WHEN v_total_payable > 0 THEN LEAST(1, v_total_deducted / v_total_payable) ELSE 0 END;
      v_new_fee := round(COALESCE(v_adv.access_fee, 0) * v_fee_ratio);
      v_fee_status := CASE WHEN v_new_fee >= COALESCE(v_adv.access_fee, 0) THEN 'settled'
                           WHEN v_new_fee > 0 THEN 'partial' ELSE 'unpaid' END;

      UPDATE public.agent_advances
      SET outstanding_balance = GREATEST(0, v_closing), status = v_new_status,
          access_fee_collected = v_new_fee, access_fee_status = v_fee_status, updated_at = now()
      WHERE id = v_adv.id;

      INSERT INTO public.agent_advance_ledger
        (advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status)
      VALUES
        (v_adv.id, current_date, v_adv.outstanding_balance, 0, v_deduct, GREATEST(0, v_closing),
         CASE WHEN v_closing <= 0 THEN 'full' ELSE 'partial' END);

      v_avail := v_avail - v_deduct;
      v_recovered_total := v_recovered_total + v_deduct;
    END LOOP;

    v_agents_touched := v_agents_touched + 1;
  END LOOP;

  RETURN jsonb_build_object('agents_touched', v_agents_touched, 'recovered_total', v_recovered_total, 'ran_at', now());
END;
$function$;

-- Refund Watsala Enock: post reversal via create_ledger_transaction and restore outstanding.
DO $$
DECLARE
  v_advance uuid := '67b4449b-7560-4e40-91d5-4b2f55bfa557';
  v_agent   uuid := 'ebf0897b-dfdf-4403-ad5c-1c988c72e67c';
  v_today   date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_total_today numeric; v_scheduled numeric; v_excess numeric; v_new_outstanding numeric;
BEGIN
  SELECT COALESCE(SUM(amount_deducted), 0) INTO v_total_today
    FROM public.agent_advance_ledger WHERE advance_id = v_advance AND date = v_today;

  SELECT round((principal + COALESCE(access_fee, 0)) / GREATEST(COALESCE(cycle_days, 30), 1))
    INTO v_scheduled FROM public.agent_advances WHERE id = v_advance;

  v_excess := GREATEST(0, v_total_today - v_scheduled);
  IF v_excess <= 0 THEN RETURN; END IF;

  PERFORM public.create_ledger_transaction(
    entries => jsonb_build_array(
      jsonb_build_object(
        'user_id', v_agent, 'ledger_scope', 'wallet', 'direction', 'cash_in',
        'amount', v_excess, 'category', 'agent_repayment', 'recipient_type', 'user',
        'source_table', 'agent_advances', 'source_id', v_advance,
        'description', 'Refund: today''s advance deductions exceeded daily installment',
        'currency', 'UGX',
        'metadata', jsonb_build_object('source','manual_over_deduction_refund','advance_id',v_advance,'reversal',true)
      ),
      jsonb_build_object(
        'user_id', v_agent, 'ledger_scope', 'platform', 'direction', 'cash_out',
        'amount', v_excess, 'category', 'agent_repayment', 'recipient_type', 'operational_wallet',
        'source_table', 'agent_advances', 'source_id', v_advance,
        'description', 'Refund: today''s advance deductions exceeded daily installment',
        'currency', 'UGX',
        'metadata', jsonb_build_object('source','manual_over_deduction_refund','advance_id',v_advance,'reversal',true)
      )
    ),
    idempotency_key => 'adv_refund_' || v_advance::text || '_' || v_today::text
  );

  UPDATE public.agent_advances
     SET outstanding_balance = outstanding_balance + v_excess,
         status = CASE WHEN expires_at < now() THEN 'overdue' ELSE 'active' END,
         updated_at = now()
   WHERE id = v_advance
  RETURNING outstanding_balance INTO v_new_outstanding;

  INSERT INTO public.agent_advance_ledger
    (advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status)
  VALUES
    (v_advance, v_today, v_new_outstanding + v_excess, 0, -v_excess, v_new_outstanding, 'partial');
END $$;
