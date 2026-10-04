-- Reverse the mass rent_funded_landlord_float bonus reseed of 2026-07-28 06:39
DO $$
DECLARE
  r RECORD;
  v_available NUMERIC;
  v_reverse NUMERIC;
  v_group UUID;
BEGIN
  PERFORM set_config('ledger.authorized', 'true', true);
  PERFORM set_config('wallet.sync_authorized', 'true', true);

  FOR r IN
    SELECT user_id AS agent_id, SUM(amount) AS total
    FROM public.general_ledger
    WHERE created_at BETWEEN '2026-07-28 06:39:00+00' AND '2026-07-28 06:39:10+00'
      AND description ILIKE '%Landlord float disbursed for registered tenant%'
      AND direction = 'cash_in'
      AND category = 'agent_commission'
    GROUP BY user_id
  LOOP
    -- clamp reversal to current withdrawable so wallet doesn't go negative
    SELECT COALESCE(public.get_user_available_balance(r.agent_id), 0) INTO v_available;
    v_reverse := LEAST(r.total, GREATEST(v_available, 0));
    IF v_reverse <= 0 THEN CONTINUE; END IF;

    v_group := gen_random_uuid();

    -- Wallet leg: pull money back from agent's withdrawable bucket
    INSERT INTO public.general_ledger
      (user_id, amount, direction, category, source_table, source_id,
       description, ledger_scope, transaction_group_id, classification,
       recipient_type, wallet_bucket, solvency_bypass_reason)
    VALUES
      (r.agent_id, v_reverse, 'cash_out', 'system_balance_correction',
       'admin_correction', gen_random_uuid(),
       'Reversal: erroneous rent_funded_landlord_float bonus reseed',
       'wallet', v_group, 'admin_correction', 'user', 'withdrawable',
       'duplicate_reversal');

    -- Platform offset leg
    INSERT INTO public.general_ledger
      (user_id, amount, direction, category, source_table, source_id,
       description, ledger_scope, transaction_group_id, classification)
    VALUES
      (r.agent_id, v_reverse, 'cash_in', 'system_balance_correction',
       'admin_correction', gen_random_uuid(),
       'Reversal offset: erroneous rent_funded_landlord_float bonus reseed',
       'platform', v_group, 'admin_correction');
  END LOOP;
END $$;