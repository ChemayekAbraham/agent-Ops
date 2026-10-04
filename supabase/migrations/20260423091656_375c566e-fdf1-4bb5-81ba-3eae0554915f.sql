-- Step 1: Remove v2 back-fill ledger rows and reverse wallet bucket inflation
ALTER TABLE public.general_ledger DISABLE TRIGGER trg_prevent_ledger_delete;
ALTER TABLE public.general_ledger DISABLE TRIGGER trg_prevent_ledger_update;
ALTER TABLE public.general_ledger DISABLE TRIGGER general_ledger_route_buckets;

DO $$
DECLARE
  v_row record;
  v_count int := 0;
  v_total numeric := 0;
BEGIN
  PERFORM set_config('wallet.sync_authorized', 'true', true);

  FOR v_row IN
    SELECT user_id, category, amount
    FROM public.general_ledger
    WHERE source_table = 'phantom_wallet_backfill_v2'
      AND user_id IS NOT NULL
      AND ledger_scope = 'wallet'
  LOOP
    IF v_row.category = 'agent_float_deposit' THEN
      UPDATE public.wallets
        SET float_balance = GREATEST(0, COALESCE(float_balance,0) - v_row.amount),
            balance = GREATEST(0, COALESCE(balance,0) - v_row.amount),
            updated_at = now()
        WHERE user_id = v_row.user_id;
    ELSE
      UPDATE public.wallets
        SET withdrawable_balance = GREATEST(0, COALESCE(withdrawable_balance,0) - v_row.amount),
            balance = GREATEST(0, COALESCE(balance,0) - v_row.amount),
            updated_at = now()
        WHERE user_id = v_row.user_id;
    END IF;
    v_total := v_total + v_row.amount;
    v_count := v_count + 1;
  END LOOP;

  DELETE FROM public.general_ledger WHERE source_table = 'phantom_wallet_backfill_v2';
  PERFORM set_config('wallet.sync_authorized', 'false', true);

  INSERT INTO public.audit_logs (action_type, table_name, record_id, metadata)
  VALUES ('phantom_wallet_backfill_v2_rollback', 'wallets', NULL,
    jsonb_build_object('rows_reversed', v_count, 'total_ugx_reversed', v_total));
END $$;

ALTER TABLE public.general_ledger ENABLE TRIGGER trg_prevent_ledger_delete;
ALTER TABLE public.general_ledger ENABLE TRIGGER trg_prevent_ledger_update;
ALTER TABLE public.general_ledger ENABLE TRIGGER general_ledger_route_buckets;

-- Step 2: Update bucket router to honor a session-level skip flag.
-- This lets admin/back-fill code write ledger entries without touching wallets.
CREATE OR REPLACE FUNCTION public.tr_general_ledger_route_buckets()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.ledger_scope IS DISTINCT FROM 'wallet' THEN RETURN NEW; END IF;
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;

  -- Allow admin reconciliation to insert ledger entries without bucket sync.
  IF current_setting('ledger.skip_bucket_sync', true) = 'true' THEN
    RETURN NEW;
  END IF;

  PERFORM public.apply_wallet_movement(NEW.user_id, NEW.category, NEW.amount, NEW.direction);
  RETURN NEW;
END;
$function$;

-- Also update the legacy sync_wallet_from_ledger trigger function to honor the flag.
CREATE OR REPLACE FUNCTION public.sync_wallet_from_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.ledger_scope IS DISTINCT FROM 'wallet' THEN RETURN NEW; END IF;
  IF NEW.category IN ('rent_float_funding', 'landlord_float_payout') THEN RETURN NEW; END IF;

  -- Honor admin bypass flag
  IF current_setting('ledger.skip_bucket_sync', true) = 'true' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.wallets (user_id, balance) VALUES (NEW.user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;

  PERFORM set_config('wallet.sync_authorized', 'true', true);

  IF NEW.direction = 'cash_in' THEN
    UPDATE public.wallets SET balance = balance + NEW.amount, updated_at = now() WHERE user_id = NEW.user_id;
  ELSIF NEW.direction = 'cash_out' THEN
    UPDATE public.wallets SET balance = GREATEST(balance - NEW.amount, 0), updated_at = now() WHERE user_id = NEW.user_id;
  END IF;

  PERFORM set_config('wallet.sync_authorized', 'false', true);
  RETURN NEW;
END;
$function$;