CREATE OR REPLACE FUNCTION public.zz_guard_agent_advance_double_charge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
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
  -- committed its collection. Charging it again would take the same
  -- installment twice.
  IF COALESCE(NEW.opening_balance, 0) > COALESCE(v_adv.outstanding_balance, 0) + 1 THEN
    INSERT INTO public.system_events (event_type, payload)
    VALUES ('repayment_skipped_insufficient_balance', jsonb_build_object(
      'source', 'zz_guard_agent_advance_double_charge',
      'reason', 'stale_opening_balance',
      'advance_id', NEW.advance_id,
      'user_id', v_adv.agent_id,
      'attempted_amount', NEW.amount_deducted,
      'attempted_opening', NEW.opening_balance,
      'true_outstanding', v_adv.outstanding_balance
    ));
    RAISE EXCEPTION 'ADVANCE_LEDGER_STALE_OPENING: advance % opening % exceeds true outstanding % (double-charge blocked)',
      NEW.advance_id, NEW.opening_balance, v_adv.outstanding_balance;
  END IF;

  -- Never collect more than the outstanding balance.
  IF COALESCE(NEW.amount_deducted, 0) > COALESCE(v_adv.outstanding_balance, 0) + COALESCE(NEW.interest_accrued, 0) + 1 THEN
    RAISE EXCEPTION 'ADVANCE_LEDGER_OVER_COLLECTION: advance % attempted % against outstanding %',
      NEW.advance_id, NEW.amount_deducted, v_adv.outstanding_balance;
  END IF;

  -- Same-day cap: scheduled installment + arrears. Blocks any path from
  -- charging a second full installment on the same calendar day.
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
      INSERT INTO public.system_events (event_type, payload)
      VALUES ('repayment_skipped_insufficient_balance', jsonb_build_object(
        'source', 'zz_guard_agent_advance_double_charge',
        'reason', 'daily_cap_exceeded',
        'advance_id', NEW.advance_id,
        'user_id', v_adv.agent_id,
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

DROP TRIGGER IF EXISTS zz_guard_agent_advance_double_charge ON public.agent_advance_ledger;
CREATE TRIGGER zz_guard_agent_advance_double_charge
BEFORE INSERT ON public.agent_advance_ledger
FOR EACH ROW EXECUTE FUNCTION public.zz_guard_agent_advance_double_charge();