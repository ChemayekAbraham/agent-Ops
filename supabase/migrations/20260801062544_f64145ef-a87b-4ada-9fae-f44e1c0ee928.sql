-- 1. Canonical schedule helpers (frequency-aware)
CREATE OR REPLACE FUNCTION public.advance_installment_amount(
  p_principal numeric,
  p_access_fee numeric,
  p_cycle_days integer,
  p_frequency text,
  p_installment_amount numeric DEFAULT NULL
)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT GREATEST(0, CASE
    WHEN COALESCE(p_installment_amount, 0) > 0 THEN p_installment_amount
    ELSE ceil(
      (COALESCE(p_principal, 0) + COALESCE(p_access_fee, 0))
      / GREATEST(1, ceil(
          GREATEST(COALESCE(p_cycle_days, 30), 1)::numeric
          / public.advance_period_days(p_frequency)
        ))
    )
  END);
$$;

-- Cumulative amount that should have been repaid by today, measured in whole
-- scheduled installments (NOT days) so weekly/bi-weekly/monthly advances are
-- never treated as daily.
CREATE OR REPLACE FUNCTION public.advance_expected_repaid_to_date(
  p_issued_at timestamptz,
  p_principal numeric,
  p_access_fee numeric,
  p_cycle_days integer,
  p_frequency text,
  p_installment_amount numeric DEFAULT NULL
)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  WITH s AS (
    SELECT
      public.advance_period_days(p_frequency) AS period_days,
      public.advance_installment_amount(p_principal, p_access_fee, p_cycle_days, p_frequency, p_installment_amount) AS installment,
      COALESCE(p_principal, 0) + COALESCE(p_access_fee, 0) AS total_payable,
      GREATEST(0, ((now() AT TIME ZONE 'Africa/Kampala')::date
                   - (p_issued_at AT TIME ZONE 'Africa/Kampala')::date)) AS days_elapsed
  )
  SELECT LEAST(
    s.total_payable,
    s.installment * GREATEST(1, LEAST(
      GREATEST(1, ceil(GREATEST(COALESCE(p_cycle_days, 30), 1)::numeric / s.period_days)),
      floor(s.days_elapsed::numeric / s.period_days)
    ))
  )
  FROM s;
$$;

GRANT EXECUTE ON FUNCTION public.advance_installment_amount(numeric, numeric, integer, text, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.advance_expected_repaid_to_date(timestamptz, numeric, numeric, integer, text, numeric) TO authenticated, service_role;

-- 2. Frequency-aware auto recovery sweep
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
  v_installment numeric; v_paid_today numeric; v_room numeric;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_row_exists boolean;
  v_agent_recovered numeric;
  v_period_days int; v_anchor date; v_expected_to_date numeric; v_paid_to_date numeric;
BEGIN
  FOR v_agent IN
    SELECT DISTINCT agent_id FROM public.agent_advances
    WHERE status IN ('active','overdue') AND outstanding_balance > 0
      AND COALESCE(recovery_source, 'wallet_daily') <> 'roi'
  LOOP
    v_avail := COALESCE(public.get_agent_sweepable_withdrawable(v_agent.agent_id), 0);
    v_agent_recovered := 0;

    FOR v_adv IN
      SELECT * FROM public.agent_advances
      WHERE agent_id = v_agent.agent_id
        AND status IN ('active','overdue') AND outstanding_balance > 0
        AND COALESCE(recovery_source, 'wallet_daily') <> 'roi'
      ORDER BY issued_at ASC
    LOOP
      SELECT EXISTS (
        SELECT 1 FROM public.agent_advance_ledger
        WHERE advance_id = v_adv.id AND date = v_today
      ) INTO v_row_exists;
      IF v_row_exists THEN CONTINUE; END IF;

      IF COALESCE(v_adv.prepaid_installments_remaining, 0) > 0 THEN
        UPDATE public.agent_advances
        SET prepaid_installments_remaining = prepaid_installments_remaining - 1, updated_at = now()
        WHERE id = v_adv.id;
        INSERT INTO public.agent_advance_ledger
          (advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status)
        VALUES
          (v_adv.id, v_today, v_adv.outstanding_balance, 0, 0, v_adv.outstanding_balance, 'prepaid');
        CONTINUE;
      END IF;

      v_period_days := public.advance_period_days(v_adv.repayment_frequency);

      -- Due-day gate: weekly / bi-weekly / monthly advances are only swept on
      -- their due day. Anchor on the last successful deduction (falling back to
      -- the issue date) so the schedule self-corrects after missed runs or term
      -- edits.
      IF v_period_days > 1 THEN
        SELECT max(date) INTO v_anchor
          FROM public.agent_advance_ledger
         WHERE advance_id = v_adv.id AND amount_deducted > 0;
        v_anchor := COALESCE(v_anchor, (v_adv.issued_at AT TIME ZONE 'Africa/Kampala')::date);
        IF (v_today - v_anchor) < v_period_days THEN
          INSERT INTO public.agent_advance_ledger
            (advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status)
          VALUES
            (v_adv.id, v_today, v_adv.outstanding_balance, 0, 0, v_adv.outstanding_balance, 'not_due');
          CONTINUE;
        END IF;
      END IF;

      v_total_payable := COALESCE(v_adv.principal,0) + COALESCE(v_adv.access_fee,0);
      v_installment := public.advance_installment_amount(
        v_adv.principal, v_adv.access_fee, v_adv.cycle_days,
        v_adv.repayment_frequency, v_adv.installment_amount
      );
      IF v_installment <= 0 THEN CONTINUE; END IF;

      v_expected_to_date := public.advance_expected_repaid_to_date(
        v_adv.issued_at, v_adv.principal, v_adv.access_fee, v_adv.cycle_days,
        v_adv.repayment_frequency, v_adv.installment_amount
      );
      v_paid_to_date := GREATEST(0, v_total_payable - COALESCE(v_adv.outstanding_balance, 0));

      IF v_paid_to_date >= v_expected_to_date THEN
        INSERT INTO public.agent_advance_ledger
          (advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status)
        VALUES
          (v_adv.id, v_today, v_adv.outstanding_balance, 0, 0, v_adv.outstanding_balance, 'ahead');
        CONTINUE;
      END IF;

      EXIT WHEN v_avail <= 0;

      SELECT COALESCE(SUM(amount_deducted), 0) INTO v_paid_today
        FROM public.agent_advance_ledger
       WHERE advance_id = v_adv.id AND date = v_today;

      v_room := GREATEST(0, (v_expected_to_date - v_paid_to_date) - v_paid_today);
      IF v_room <= 0 THEN CONTINUE; END IF;

      v_deduct := LEAST(v_avail, v_adv.outstanding_balance, v_room);
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
          access_fee_collected = v_new_fee, access_fee_status = v_fee_status,
          -- Arrears measured per scheduled installment: paying the full
          -- installment (or more) pays arrears down; a shortfall grows it.
          arrears_balance = GREATEST(0, LEAST(
            GREATEST(0, v_closing),
            COALESCE(v_adv.arrears_balance, 0) + (v_installment - v_deduct)
          )),
          updated_at = now()
      WHERE id = v_adv.id;

      INSERT INTO public.agent_advance_ledger
        (advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status)
      VALUES
        (v_adv.id, v_today, v_adv.outstanding_balance, 0, v_deduct, GREATEST(0, v_closing),
         CASE WHEN v_closing <= 0 THEN 'full' ELSE 'partial' END);

      v_avail := v_avail - v_deduct;
      v_recovered_total := v_recovered_total + v_deduct;
      v_agent_recovered := v_agent_recovered + v_deduct;
    END LOOP;

    IF v_agent_recovered > 0 THEN
      BEGIN
        PERFORM net.http_post(
          url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/notify-advance-deduction',
          headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
          body := jsonb_build_object('agent_id', v_agent.agent_id, 'amount', v_agent_recovered, 'source', 'auto_withdrawable_sweep')
        );
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
    END IF;

    v_agents_touched := v_agents_touched + 1;
  END LOOP;

  RETURN jsonb_build_object('agents_touched', v_agents_touched, 'recovered_total', v_recovered_total, 'ran_at', now());
END;
$function$;

-- 3. Monitor RPC: scheduled installment must follow the advance's frequency
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
    public.advance_installment_amount(
      a.principal, a.access_fee, a.cycle_days, a.repayment_frequency, a.installment_amount
    )::numeric,
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
             WHEN BOOL_OR(l.deduction_status = 'not_due')  THEN 'not_due'
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
    AND COALESCE(a.recovery_source, 'wallet_daily') <> 'roi'
  ORDER BY (COALESCE(td.amt, 0) > 0) ASC, COALESCE(a.arrears_balance, 0) DESC, a.outstanding_balance DESC;
END;
$function$;