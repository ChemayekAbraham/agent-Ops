DO $$
DECLARE d text;
  v_old text := 'IF NOT public.hr_pay_is_releaser() THEN RAISE EXCEPTION ''Only the position holding release authority can pay a bonus pool.''; END IF;';
  v_new text := 'IF NOT (public.hr_pay_is_releaser() OR public.hr_pay_is_approver()) THEN RAISE EXCEPTION ''Only the CEO (approve authority) or the CFO (release authority) can disburse a bonus pool.''; END IF;';
BEGIN
  d := pg_get_functiondef('public.hr_pay_bonus_pay(uuid)'::regprocedure);
  IF position(v_old in d) = 0 THEN RAISE EXCEPTION 'BONUS-06: expected authority line not found'; END IF;
  EXECUTE replace(d, v_old, v_new);
END $$;