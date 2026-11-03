-- "Pay now" for an agent's advance: one payment, any time, any amount up to what is owed, that cannot be charged twice.
--
-- WHY: the old "Pay ahead" button (edge function voluntary-repay-advance) had three problems.
--   1. Its idempotency key was voluntary_prepay_<advance>_<Date.now()>, different on every call, so a double-tap or a retry paid twice.
--   2. It stamped the day with the UTC date. The withdrawal-time collector and the daily cap use the Kampala date, so between 00:00 and 03:00
--      Kampala a payment was filed under yesterday and the collector charged the same day again.
--   3. It priced a "day" as (principal + access fee) / cycle days, leaving out the registration fee, so the figure the agent saw differed from the
--      installment actually deducted, and its prepaid-day counter over-credited.
--
-- WHAT THIS ADDS (all in one transaction, one place):
--   * agent_advance_payment_requests: one row per payment attempt, keyed by an idempotency key the app makes once per payment intent.
--     The same key a second time returns the first result and posts nothing. The edge function scopes the key as <agent>:<advance>:<key>.
--   * advance_pay_now(advance, agent, amount, key, expected_paid_today): locks the advance row, then
--       - returns the stored result if the key was already used (double-tap, retry, two devices);
--       - refuses if the amount the agent was shown as already paid today no longer matches (another deduction or payment landed first);
--       - works the day from the KAMPALA date and the same installment and daily cap the withdrawal-time collector uses;
--       - takes the agent's chosen amount, or what is due today when none is given; the agent MAY pay again after the day's deduction was taken;
--       - never takes more than is outstanding or more than the agent's withdrawable balance;
--       - posts through record_advance_voluntary_repayment_atomic (unchanged), with no prepaid days, so tomorrow's installment is not skipped by a counter.
--   * advance_pay_now_preview(advance, agent): the figures the dialog shows (installment, paid today, due today, outstanding, available).
--   * zz_guard_agent_advance_double_charge: the SAME-DAY CAP no longer blocks a voluntary payment (deduction_status 'voluntary_payment'). Every other
--     check stays (stale opening balance, never more than owed). Automated deductions that day are still capped, and the cap counts the voluntary
--     rows, so once the agent has paid the day's amount the collector, the 15-minute sweep and the earning-time recovery take nothing more that day.
--   * access_fee_collected is clamped at zero. It used to go negative (Shafeeq: -4,363) because the registration fee is in the outstanding balance
--     but not in principal + access fee.
-- Not changed here (flagged separately): collect_due_agent_advance_installment still measures "paid to date" against principal + access fee only, so the
-- registration fee makes an agent look up to that much behind schedule.
-- Roll back with 20261028100500_advance_pay_now.rollback.sql.

CREATE TABLE IF NOT EXISTS public.agent_advance_payment_requests (
  idempotency_key text PRIMARY KEY,
  advance_id uuid NOT NULL REFERENCES public.agent_advances(id),
  agent_id uuid NOT NULL,
  pay_date date NOT NULL,
  amount numeric NOT NULL,
  expected_paid_today numeric,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.agent_advance_payment_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_advance_payment_requests FROM PUBLIC, anon, authenticated;
CREATE INDEX IF NOT EXISTS idx_agent_advance_payment_requests_advance ON public.agent_advance_payment_requests (advance_id, pay_date);

-- The day's figures, worked the same way as collect_due_agent_advance_installment (the withdrawal-time collector).
CREATE OR REPLACE FUNCTION public._advance_day_figures(p_advance_id uuid, OUT installment numeric, OUT paid_today numeric, OUT cap numeric, OUT due_now numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  a record;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
BEGIN
  SELECT * INTO a FROM public.agent_advances WHERE id = p_advance_id;
  IF NOT FOUND THEN RETURN; END IF;
  installment := public.advance_installment_amount(a.principal, a.access_fee, a.cycle_days, a.repayment_frequency, a.installment_amount);
  SELECT COALESCE(SUM(amount_deducted), 0) INTO paid_today FROM public.agent_advance_ledger WHERE advance_id = p_advance_id AND date = v_today;
  cap := installment + GREATEST(0, CASE WHEN paid_today <= 0 THEN COALESCE(a.arrears_balance, 0)
                                        ELSE COALESCE(a.arrears_balance, 0) - installment + paid_today END);
  due_now := LEAST(GREATEST(0, cap - paid_today), GREATEST(0, COALESCE(a.outstanding_balance, 0)));
END;
$function$;
REVOKE ALL ON FUNCTION public._advance_day_figures(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.advance_pay_now_preview(p_advance_id uuid, p_agent_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE a record; f record;
BEGIN
  SELECT * INTO a FROM public.agent_advances WHERE id = p_advance_id AND agent_id = p_agent_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ADVANCE_NOT_FOUND: no such advance for this agent' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO f FROM public._advance_day_figures(p_advance_id);
  RETURN jsonb_build_object(
    'advance_id', a.id, 'status', a.status, 'day', (now() AT TIME ZONE 'Africa/Kampala')::date,
    'installment', f.installment, 'arrears', COALESCE(a.arrears_balance, 0), 'paid_today', f.paid_today,
    'due_now', f.due_now, 'outstanding', COALESCE(a.outstanding_balance, 0),
    'available', GREATEST(0, COALESCE(public.get_user_available_balance(p_agent_id), 0)));
END;
$function$;
REVOKE ALL ON FUNCTION public.advance_pay_now_preview(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.advance_pay_now_preview(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.advance_pay_now(
  p_advance_id uuid, p_agent_id uuid, p_amount numeric, p_idempotency_key text, p_expected_paid_today numeric DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  a public.agent_advances%ROWTYPE;
  f record;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_prior jsonb;
  v_amt numeric;
  v_avail numeric;
  v_open numeric;
  v_close numeric;
  v_status text;
  v_total_all numeric;
  v_fee numeric;
  v_fee_status text;
  v_arrears numeric;
  v_res jsonb;
BEGIN
  IF p_advance_id IS NULL OR p_agent_id IS NULL THEN
    RAISE EXCEPTION 'ADVANCE_BAD_REQUEST: advance and agent are required' USING ERRCODE = 'P0001';
  END IF;
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) < 16 OR char_length(p_idempotency_key) > 200 THEN
    RAISE EXCEPTION 'ADVANCE_BAD_REQUEST: a payment key of 16 to 200 characters is required' USING ERRCODE = 'P0001';
  END IF;

  -- Serialises every payment, deduction and sweep on this advance.
  SELECT * INTO a FROM public.agent_advances WHERE id = p_advance_id AND agent_id = p_agent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ADVANCE_NOT_FOUND: no such advance for this agent' USING ERRCODE = 'P0001'; END IF;

  -- The same key again: return the first result, post nothing.
  SELECT result INTO v_prior FROM public.agent_advance_payment_requests WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_prior || jsonb_build_object('duplicate', true);
  END IF;

  IF a.status NOT IN ('active', 'overdue') THEN
    RAISE EXCEPTION 'ADVANCE_NOT_ACTIVE: this advance is % and cannot be paid', a.status USING ERRCODE = 'P0001';
  END IF;
  v_open := COALESCE(a.outstanding_balance, 0);
  IF v_open <= 0 THEN
    RAISE EXCEPTION 'ADVANCE_NOTHING_OWED: nothing is outstanding on this advance' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO f FROM public._advance_day_figures(p_advance_id);
  IF f.installment <= 0 THEN
    RAISE EXCEPTION 'ADVANCE_BAD_REQUEST: the installment for this advance could not be worked out' USING ERRCODE = 'P0001';
  END IF;

  -- The payment is bound to the state the agent was shown. If a deduction or another payment landed since, ask them to look again.
  IF p_expected_paid_today IS NOT NULL AND abs(p_expected_paid_today - f.paid_today) > 0.5 THEN
    RAISE EXCEPTION 'ADVANCE_STATE_CHANGED: paid today is now % (you were shown %). Check the figures and try again.',
      round(f.paid_today, 2), round(p_expected_paid_today, 2) USING ERRCODE = 'P0001';
  END IF;

  v_amt := round(COALESCE(p_amount, f.due_now), 2);
  IF v_amt <= 0 THEN
    RAISE EXCEPTION 'ADVANCE_NOTHING_DUE: nothing is due today. Enter an amount to pay anyway.' USING ERRCODE = 'P0001';
  END IF;
  IF v_amt > v_open THEN v_amt := v_open; END IF;

  v_avail := GREATEST(0, COALESCE(public.get_user_available_balance(p_agent_id), 0));
  IF v_avail < v_amt THEN
    RAISE EXCEPTION 'ADVANCE_INSUFFICIENT_BALANCE: available % but % is needed', round(v_avail, 2), round(v_amt, 2) USING ERRCODE = 'P0001';
  END IF;

  v_close := GREATEST(0, v_open - v_amt);
  v_status := CASE WHEN v_close <= 0 THEN 'completed' ELSE a.status END;
  v_total_all := COALESCE(a.principal, 0) + COALESCE(a.access_fee, 0) + COALESCE(a.registration_fee, 0);
  v_fee := CASE WHEN v_total_all > 0
                THEN GREATEST(0, LEAST(COALESCE(a.access_fee, 0), round(COALESCE(a.access_fee, 0) * LEAST(1, GREATEST(0, v_total_all - v_close) / v_total_all))))
                ELSE 0 END;
  v_fee_status := CASE WHEN v_fee >= COALESCE(a.access_fee, 0) THEN 'settled' WHEN v_fee > 0 THEN 'partial' ELSE 'unpaid' END;
  -- Same arrears arithmetic as the withdrawal-time collector.
  v_arrears := GREATEST(0, LEAST(v_close, CASE WHEN f.paid_today <= 0
                                               THEN COALESCE(a.arrears_balance, 0) + (f.installment - v_amt)
                                               ELSE COALESCE(a.arrears_balance, 0) - v_amt END));

  PERFORM public.record_advance_voluntary_repayment_atomic(
    p_advance_id => a.id, p_agent_id => p_agent_id, p_date => v_today, p_amount => v_amt,
    p_opening_balance => v_open, p_closing_balance => v_close, p_new_status => v_status,
    p_new_fee_collected => v_fee, p_fee_status => v_fee_status, p_new_arrears => v_arrears,
    p_prepaid_remaining => COALESCE(a.prepaid_installments_remaining, 0),
    p_idempotency_key => 'advance_pay_now:' || p_idempotency_key,
    p_wallet_description => 'Advance payment (pay now)',
    p_meta => jsonb_build_object('source', 'pay_now', 'advance_id', a.id, 'bucket_intent', 'advance_balance_recovery', 'pay_date', v_today));

  v_res := jsonb_build_object(
    'ok', true, 'duplicate', false, 'advance_id', a.id, 'pay_date', v_today,
    'amount_paid', v_amt, 'due_before', f.due_now, 'paid_today_before', f.paid_today,
    'paid_today_after', f.paid_today + v_amt, 'day_covered', (f.paid_today + v_amt) >= f.cap,
    'closing_balance', v_close, 'arrears_after', v_arrears, 'status', v_status);

  INSERT INTO public.agent_advance_payment_requests (idempotency_key, advance_id, agent_id, pay_date, amount, expected_paid_today, result)
  VALUES (p_idempotency_key, a.id, p_agent_id, v_today, v_amt, p_expected_paid_today, v_res);

  RETURN v_res;
END;
$function$;
REVOKE ALL ON FUNCTION public.advance_pay_now(uuid, uuid, numeric, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.advance_pay_now(uuid, uuid, numeric, text, numeric) TO service_role;

-- The same-day cap must not block a voluntary payment; everything else in the guard is unchanged.
CREATE OR REPLACE FUNCTION public.zz_guard_agent_advance_double_charge()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_adv record;
  v_installment numeric;
  v_cap numeric;
  v_charged_today numeric;
BEGIN
  IF COALESCE(NEW.amount_deducted, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  -- Serialise concurrent recovery paths (daily cron, 15-min sweep,
  -- earning-time recovery, voluntary repayment) on the advance row.
  SELECT * INTO v_adv
    FROM public.agent_advances
   WHERE id = NEW.advance_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Stale-read guard: a charging row whose opening balance is HIGHER than the
  -- advance's true current balance was computed before another process
  -- committed its collection. Charging it again takes the same installment twice.
  IF COALESCE(NEW.opening_balance, 0) > COALESCE(v_adv.outstanding_balance, 0) + 1 THEN
    INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
    VALUES ('repayment_skipped_insufficient_balance', v_adv.agent_id, 'agent_advances', NEW.advance_id,
      jsonb_build_object(
        'source', 'zz_guard_agent_advance_double_charge',
        'reason', 'stale_opening_balance',
        'attempted_amount', NEW.amount_deducted,
        'attempted_opening', NEW.opening_balance,
        'true_outstanding', v_adv.outstanding_balance
      ));
    RAISE EXCEPTION 'ADVANCE_LEDGER_STALE_OPENING: advance % opening % exceeds true outstanding % (double-charge blocked)',
      NEW.advance_id, NEW.opening_balance, v_adv.outstanding_balance;
  END IF;

  -- Never collect more than what is owed.
  IF COALESCE(NEW.amount_deducted, 0) > COALESCE(v_adv.outstanding_balance, 0) + COALESCE(NEW.interest_accrued, 0) + 1 THEN
    RAISE EXCEPTION 'ADVANCE_LEDGER_OVER_COLLECTION: advance % attempted % against outstanding %',
      NEW.advance_id, NEW.amount_deducted, v_adv.outstanding_balance;
  END IF;

  -- A payment the agent chose to make is not an automatic charge: the same-day cap does not apply to it. It still counts
  -- toward the day, so automatic deductions that day stop once the day's amount has been paid.
  IF COALESCE(NEW.deduction_status, '') = 'voluntary_payment' THEN
    RETURN NEW;
  END IF;

  -- Same-day cap: scheduled installment + arrears.
  v_installment := public.advance_installment_amount(
    v_adv.principal, v_adv.access_fee, v_adv.cycle_days,
    v_adv.repayment_frequency, v_adv.installment_amount
  );

  IF v_installment > 0 THEN
    SELECT COALESCE(SUM(amount_deducted), 0) INTO v_charged_today
      FROM public.agent_advance_ledger
     WHERE advance_id = NEW.advance_id
       AND date = NEW.date;

    v_cap := v_installment + GREATEST(0, COALESCE(v_adv.arrears_balance, 0)) + 1;

    IF v_charged_today + NEW.amount_deducted > v_cap THEN
      INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
      VALUES ('repayment_skipped_insufficient_balance', v_adv.agent_id, 'agent_advances', NEW.advance_id,
        jsonb_build_object(
          'source', 'zz_guard_agent_advance_double_charge',
          'reason', 'daily_cap_exceeded',
          'attempted_amount', NEW.amount_deducted,
          'already_charged_today', v_charged_today,
          'cap', v_cap
        ));
      RAISE EXCEPTION 'ADVANCE_PERIOD_CAP_EXCEEDED: advance % already charged % today, cap % (attempted %)',
        NEW.advance_id, v_charged_today, v_cap, NEW.amount_deducted;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
