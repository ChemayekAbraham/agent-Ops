DO $mig$
DECLARE
  s text;
BEGIN
  -- 1) Installment down payment: 25% of the item price (capped by wallet), not 25% of wallet
  SELECT pg_get_functiondef(oid) INTO s FROM pg_proc
   WHERE proname = 'agent_purchase_merchandise' AND pronamespace = 'public'::regnamespace;
  s := replace(s,
    'v_down := LEAST(v_total, GREATEST(round(v_avail * 0.25), 0));',
    'v_down := LEAST(v_avail, GREATEST(round(v_total * 0.25), 1));');
  IF s NOT LIKE '%LEAST(v_avail, GREATEST(round(v_total * 0.25), 1))%' THEN
    RAISE EXCEPTION 'down payment patch failed';
  END IF;
  EXECUTE s;

  -- 2) Recovery installments: 25% of the original item price, not 25% of the wallet
  SELECT pg_get_functiondef(oid) INTO s FROM pg_proc
   WHERE proname = 'recover_merchandise_from_wallets' AND pronamespace = 'public'::regnamespace;
  s := replace(s,
    'GREATEST(round(v_avail * v_plan.daily_rate), 1)',
    'GREATEST(round(COALESCE(v_plan.original_amount, v_plan.outstanding_balance) * v_plan.daily_rate), 1)');
  s := replace(s, '% Wallet Recovery)', '% Installment)');
  IF s NOT LIKE '%v_plan.original_amount, v_plan.outstanding_balance%' THEN
    RAISE EXCEPTION 'recovery patch failed';
  END IF;
  EXECUTE s;
END
$mig$;