-- ============================================================
-- FUSED A+B: Wallet cache demolition
-- - Neuter both apply_wallet_movement overloads (no cache writes)
-- - Drop wallets view + 8 dependent views/matview (CASCADE)
-- - Drop 7 cache-bucket triggers on wallets_physical
-- - Drop 4 bucket columns from wallets_physical
-- - Recreate wallets view sourcing buckets from v_user_wallet_strict
-- General ledger is the only truth from this point on.
-- ============================================================

BEGIN;

-- 1. Neuter apply_wallet_movement (4-arg legacy overload) ------
CREATE OR REPLACE FUNCTION public.apply_wallet_movement(
  p_user_id uuid, p_category text, p_amount numeric, p_direction text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_route record;
  v_direction text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN; END IF;

  v_direction := CASE lower(coalesce(p_direction, ''))
    WHEN 'in' THEN 'credit' WHEN 'inflow' THEN 'credit'
    WHEN 'out' THEN 'debit' WHEN 'outflow' THEN 'debit'
    ELSE p_direction
  END;

  -- Keep diagnostic visibility for unrouted categories.
  SELECT * INTO v_route FROM public.wallet_route_for_category(p_user_id, p_category, v_direction);
  IF v_route.bucket = 'none' OR v_route.sign = 0 THEN
    BEGIN
      INSERT INTO public.wallet_unrouted_movements (
        user_id, category, direction, amount, bucket_returned, sign_returned
      ) VALUES (
        p_user_id, p_category, v_direction, p_amount, v_route.bucket, v_route.sign
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  -- Ensure a wallet identity row exists. No bucket writes — ledger is truth.
  INSERT INTO public.wallets_physical (user_id) VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;
END;
$$;

-- 2. Neuter apply_wallet_movement (5-arg recipient_type overload) ------
CREATE OR REPLACE FUNCTION public.apply_wallet_movement(
  p_user_id uuid, p_category text, p_amount numeric, p_direction text, p_recipient_type text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN; END IF;

  IF p_recipient_type IS NULL OR p_recipient_type NOT IN ('user','operational_wallet') THEN
    BEGIN
      INSERT INTO public.wallet_routing_violations (
        user_id, category, direction, amount, recipient_type, reason, context
      ) VALUES (
        p_user_id, p_category, p_direction, p_amount, p_recipient_type,
        'RECIPIENT_TYPE_REQUIRED',
        jsonb_build_object('source', 'apply_wallet_movement_v2_neutered')
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RAISE EXCEPTION 'RECIPIENT_TYPE_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;

  BEGIN
    PERFORM public.assert_routing_compatible(p_category, p_recipient_type);
  EXCEPTION WHEN check_violation THEN
    BEGIN
      INSERT INTO public.wallet_routing_violations (
        user_id, category, direction, amount, recipient_type, reason, context
      ) VALUES (
        p_user_id, p_category, p_direction, p_amount, p_recipient_type,
        SQLERRM, jsonb_build_object('source', 'apply_wallet_movement_v2_neutered')
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RAISE;
  END;

  INSERT INTO public.wallets_physical (user_id) VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;
END;
$$;

-- 3. Drop the wallets view (will be recreated after column drop) ------
DROP VIEW IF EXISTS public.wallets CASCADE;

-- 4. Drop the 7 cache-bucket triggers on wallets_physical ------
DROP TRIGGER IF EXISTS enforce_bucket_invariant ON public.wallets_physical;
DROP TRIGGER IF EXISTS enforce_wallet_balance_floor ON public.wallets_physical;
DROP TRIGGER IF EXISTS enforce_wallet_ledger_only ON public.wallets_physical;
DROP TRIGGER IF EXISTS on_wallet_balance_change_log_event ON public.wallets_physical;
DROP TRIGGER IF EXISTS trg_auto_freeze_phantom_surplus ON public.wallets_physical;
DROP TRIGGER IF EXISTS trg_enforce_wallet_balance_invariant ON public.wallets_physical;
DROP TRIGGER IF EXISTS trg_guard_wallet_mutation ON public.wallets_physical;

-- 5. Drop the 4 bucket columns + cascade through dependent views ------
ALTER TABLE public.wallets_physical
  DROP COLUMN IF EXISTS balance CASCADE,
  DROP COLUMN IF EXISTS withdrawable_balance CASCADE,
  DROP COLUMN IF EXISTS float_balance CASCADE,
  DROP COLUMN IF EXISTS advance_balance CASCADE;

-- 6. Recreate wallets view: identity from wallets_physical,
--    buckets sourced live from v_user_wallet_strict.
CREATE OR REPLACE VIEW public.wallets AS
SELECT
  wp.id,
  wp.user_id,
  COALESCE(vs.total_visible, 0)    AS balance,
  wp.created_at,
  wp.updated_at,
  wp.locked_balance,
  wp.currency,
  COALESCE(vs.withdrawable, 0)     AS withdrawable_balance,
  COALESCE(vs.float_balance, 0)    AS float_balance,
  COALESCE(vs.advance_balance, 0)  AS advance_balance
FROM public.wallets_physical wp
LEFT JOIN public.v_user_wallet_strict vs ON vs.user_id = wp.user_id;

GRANT SELECT ON public.wallets TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;