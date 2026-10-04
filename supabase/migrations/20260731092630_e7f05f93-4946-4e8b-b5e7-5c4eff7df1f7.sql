ALTER TABLE public.agent_advance_ledger
  ADD COLUMN IF NOT EXISTS recovery_source text NOT NULL DEFAULT 'wallet_daily',
  ADD COLUMN IF NOT EXISTS roi_amount numeric,
  ADD COLUMN IF NOT EXISTS recovery_percent numeric;

-- Normalise ROI advances: no daily installment, no arrears, no prepaid schedule
CREATE OR REPLACE FUNCTION public.tg_normalize_roi_advance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF COALESCE(NEW.recovery_source, 'wallet_daily') = 'roi' THEN
    NEW.daily_installment := 0;
    NEW.arrears_balance := 0;
    NEW.prepaid_installments_remaining := 0;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_roi_advance ON public.agent_advances;
CREATE TRIGGER trg_normalize_roi_advance
BEFORE INSERT OR UPDATE ON public.agent_advances
FOR EACH ROW EXECUTE FUNCTION public.tg_normalize_roi_advance();

-- Tag ROI recoveries in the advance ledger
CREATE OR REPLACE FUNCTION public.apply_roi_advance_recovery(
  p_user_id uuid,
  p_roi_amount numeric,
  p_source_id uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_adv record;
  v_remaining numeric := COALESCE(p_roi_amount, 0);
  v_recovered numeric := 0;
  v_take numeric;
  v_closing numeric;
  v_new_status text;
  v_idem text;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_details jsonb := '[]'::jsonb;
BEGIN
  IF p_user_id IS NULL OR v_remaining <= 0 THEN
    RETURN jsonb_build_object('recovered', 0, 'net_roi', GREATEST(0, v_remaining), 'advances', v_details);
  END IF;

  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.general_ledger
    WHERE idempotency_key = 'roi_adv_rec_' || p_idempotency_key
  ) THEN
    RETURN jsonb_build_object('recovered', 0, 'net_roi', v_remaining, 'advances', v_details, 'skipped', 'already_recovered');
  END IF;

  FOR v_adv IN
    SELECT * FROM public.agent_advances
    WHERE agent_id = p_user_id
      AND recovery_source = 'roi'
      AND status IN ('active','overdue')
      AND outstanding_balance > 0
      AND COALESCE(roi_recovery_percent, 0) > 0
    ORDER BY issued_at ASC
  LOOP
    EXIT WHEN v_remaining <= 0;

    v_take := round(LEAST(
      v_adv.outstanding_balance,
      v_remaining,
      COALESCE(p_roi_amount, 0) * (v_adv.roi_recovery_percent / 100.0)
    ));
    IF v_take <= 0 THEN CONTINUE; END IF;

    v_idem := COALESCE(
      'roi_adv_rec_' || p_idempotency_key,
      'roi_adv_rec_' || v_adv.id::text || '_' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text
    );

    PERFORM public.create_ledger_transaction(
      entries => jsonb_build_array(
        jsonb_build_object(
          'user_id', p_user_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
          'amount', v_take, 'category', 'agent_repayment', 'recipient_type', 'user',
          'source_table', 'agent_advances', 'source_id', v_adv.id,
          'description', 'Advance recovery of ' || v_adv.roi_recovery_percent || '% from ROI payout',
          'currency', 'UGX',
          'metadata', jsonb_build_object('source','roi_recovery','advance_id',v_adv.id,'roi_amount',p_roi_amount,'portfolio_id',p_source_id)
        ),
        jsonb_build_object(
          'user_id', p_user_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
          'amount', v_take, 'category', 'agent_repayment', 'recipient_type', 'operational_wallet',
          'source_table', 'agent_advances', 'source_id', v_adv.id,
          'description', 'Advance repayment received from ROI recovery',
          'currency', 'UGX',
          'metadata', jsonb_build_object('source','roi_recovery','advance_id',v_adv.id,'roi_amount',p_roi_amount,'portfolio_id',p_source_id)
        )
      ),
      idempotency_key => v_idem
    );

    v_closing := GREATEST(0, v_adv.outstanding_balance - v_take);
    v_new_status := CASE WHEN v_closing <= 0 THEN 'completed'
                         WHEN v_adv.expires_at < now() THEN 'overdue' ELSE 'active' END;

    UPDATE public.agent_advances
    SET outstanding_balance = v_closing,
        status = v_new_status,
        updated_at = now()
    WHERE id = v_adv.id;

    INSERT INTO public.agent_advance_ledger
      (advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance,
       deduction_status, recovery_source, roi_amount, recovery_percent)
    VALUES
      (v_adv.id, v_today, v_adv.outstanding_balance, 0, v_take, v_closing,
       CASE WHEN v_closing <= 0 THEN 'full' ELSE 'partial' END,
       'roi', p_roi_amount, v_adv.roi_recovery_percent);

    v_remaining := v_remaining - v_take;
    v_recovered := v_recovered + v_take;
    v_details := v_details || jsonb_build_object(
      'advance_id', v_adv.id,
      'percent', v_adv.roi_recovery_percent,
      'recovered', v_take,
      'outstanding_after', v_closing,
      'status', v_new_status
    );
  END LOOP;

  RETURN jsonb_build_object(
    'recovered', v_recovered,
    'net_roi', GREATEST(0, COALESCE(p_roi_amount,0) - v_recovered),
    'advances', v_details
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_roi_advance_recovery(uuid, numeric, uuid, text) TO authenticated, service_role;

-- Repayment monitor: skip ROI-recovered advances
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
    COALESCE(NULLIF(a.daily_installment, 0),
             CASE WHEN COALESCE(a.cycle_days, 0) > 0
                  THEN round((COALESCE(a.principal,0) + COALESCE(a.access_fee,0)) / a.cycle_days)
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
    AND COALESCE(a.recovery_source, 'wallet_daily') <> 'roi'
  ORDER BY (COALESCE(td.amt, 0) > 0) ASC, COALESCE(a.arrears_balance, 0) DESC, a.outstanding_balance DESC;
END;
$function$;