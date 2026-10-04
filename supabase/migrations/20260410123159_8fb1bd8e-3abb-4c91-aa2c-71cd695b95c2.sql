
-- STEP 1: Update sync_wallet_from_ledger to set session flag
CREATE OR REPLACE FUNCTION public.sync_wallet_from_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.ledger_scope IS DISTINCT FROM 'wallet' THEN
    RETURN NEW;
  END IF;

  IF NEW.category IN ('rent_float_funding', 'landlord_float_payout') THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.wallets (user_id, balance)
  VALUES (NEW.user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;

  PERFORM set_config('wallet.sync_authorized', 'true', true);

  IF NEW.direction = 'cash_in' THEN
    UPDATE public.wallets
    SET balance = balance + NEW.amount, updated_at = now()
    WHERE user_id = NEW.user_id;
  ELSIF NEW.direction = 'cash_out' THEN
    UPDATE public.wallets
    SET balance = GREATEST(balance - NEW.amount, 0), updated_at = now()
    WHERE user_id = NEW.user_id;
  END IF;

  PERFORM set_config('wallet.sync_authorized', 'false', true);

  RETURN NEW;
END;
$$;

-- STEP 2: Create wallet mutation guard
CREATE OR REPLACE FUNCTION public.guard_wallet_direct_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.balance IS NOT DISTINCT FROM NEW.balance THEN
    RETURN NEW;
  END IF;

  IF current_setting('wallet.sync_authorized', true) = 'true' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Direct wallet balance mutation forbidden. All balance changes must go through the ledger.';
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_wallet_mutation ON public.wallets;
CREATE TRIGGER trg_guard_wallet_mutation
BEFORE UPDATE ON public.wallets
FOR EACH ROW
EXECUTE FUNCTION public.guard_wallet_direct_update();

-- STEP 3: Correction ledger entries for 4 drifted users
DO $$
DECLARE
  v_group1 UUID := gen_random_uuid();
  v_group2 UUID := gen_random_uuid();
  v_group3 UUID := gen_random_uuid();
  v_group4 UUID := gen_random_uuid();
  v_src1 UUID := gen_random_uuid();
  v_src2 UUID := gen_random_uuid();
  v_src3 UUID := gen_random_uuid();
  v_src4 UUID := gen_random_uuid();
BEGIN
  PERFORM set_config('ledger.authorized', 'true', true);

  -- MUSEMA KIZITO — wallet 1,100,000, ledger 0 → drain
  INSERT INTO public.general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id, reference_id)
  VALUES
    ('9f1b3504-1b5c-4f61-8e03-ea6e140fb8da', 1100000, 'cash_out', 'system_balance_correction', 'system', v_src1, 'Reconciliation: drain phantom wallet balance (legacy rogue trigger artifact)', 'wallet', v_group1, 'COR2604100001'),
    ('9f1b3504-1b5c-4f61-8e03-ea6e140fb8da', 1100000, 'cash_in', 'system_balance_correction', 'system', v_src1, 'Reconciliation: platform absorbs phantom funds from MUSEMA KIZITO', 'platform', v_group1, 'COR2604100001');

  -- Mercy Bayo — wallet 600,000, ledger 0 → drain
  INSERT INTO public.general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id, reference_id)
  VALUES
    ('6b7d9eee-4bc8-47ac-a2e6-b84cbaac8bb4', 600000, 'cash_out', 'system_balance_correction', 'system', v_src2, 'Reconciliation: drain phantom wallet balance (legacy rogue trigger artifact)', 'wallet', v_group2, 'COR2604100002'),
    ('6b7d9eee-4bc8-47ac-a2e6-b84cbaac8bb4', 600000, 'cash_in', 'system_balance_correction', 'system', v_src2, 'Reconciliation: platform absorbs phantom funds from Mercy Bayo', 'platform', v_group2, 'COR2604100002');

  -- NAMULINDWA IMMECULATE — wallet 75,000, ledger 0 → drain
  INSERT INTO public.general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id, reference_id)
  VALUES
    ('27d5a08b-5fee-452e-bc9a-bc8064f96ae3', 75000, 'cash_out', 'system_balance_correction', 'system', v_src3, 'Reconciliation: drain phantom wallet balance (legacy rogue trigger artifact)', 'wallet', v_group3, 'COR2604100003'),
    ('27d5a08b-5fee-452e-bc9a-bc8064f96ae3', 75000, 'cash_in', 'system_balance_correction', 'system', v_src3, 'Reconciliation: platform absorbs phantom funds from NAMULINDWA IMMECULATE', 'platform', v_group3, 'COR2604100003');

  -- HELLEN NABUKENYA — wallet 0, ledger 5,000 → credit wallet
  INSERT INTO public.general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id, reference_id)
  VALUES
    ('bd266fc7-1066-468a-8beb-347430d9d9b6', 5000, 'cash_in', 'system_balance_correction', 'system', v_src4, 'Reconciliation: credit wallet to match ledger truth for HELLEN NABUKENYA', 'wallet', v_group4, 'COR2604100004'),
    ('bd266fc7-1066-468a-8beb-347430d9d9b6', 5000, 'cash_out', 'system_balance_correction', 'system', v_src4, 'Reconciliation: platform funds correction for HELLEN NABUKENYA', 'platform', v_group4, 'COR2604100004');

  PERFORM set_config('ledger.authorized', 'false', true);
END $$;
