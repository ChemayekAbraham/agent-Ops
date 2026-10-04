-- 1. Bucket-aware columns on obligations
ALTER TABLE public.cfo_debit_obligations
  ADD COLUMN IF NOT EXISTS wallet_bucket text NOT NULL DEFAULT 'withdrawable',
  ADD COLUMN IF NOT EXISTS recovery_source text NOT NULL DEFAULT 'withdrawable';

UPDATE public.cfo_debit_obligations
SET wallet_bucket = COALESCE(NULLIF(metadata->>'wallet_bucket',''), 'withdrawable'),
    recovery_source = COALESCE(NULLIF(metadata->>'wallet_bucket',''), 'withdrawable')
WHERE wallet_bucket = 'withdrawable'
  AND COALESCE(NULLIF(metadata->>'wallet_bucket',''), 'withdrawable') <> 'withdrawable';

ALTER TABLE public.cfo_debit_obligations
  DROP CONSTRAINT IF EXISTS cfo_debit_obligations_wallet_bucket_check;
ALTER TABLE public.cfo_debit_obligations
  ADD CONSTRAINT cfo_debit_obligations_wallet_bucket_check
  CHECK (wallet_bucket IN ('withdrawable','float','advance'));

ALTER TABLE public.cfo_debit_obligations
  DROP CONSTRAINT IF EXISTS cfo_debit_obligations_recovery_source_check;
ALTER TABLE public.cfo_debit_obligations
  ADD CONSTRAINT cfo_debit_obligations_recovery_source_check
  CHECK (recovery_source IN ('withdrawable','float','advance'));

CREATE INDEX IF NOT EXISTS idx_cfo_debit_obligations_bucket
  ON public.cfo_debit_obligations (wallet_bucket, status);

-- 2. Guardrail: float obligations can never be personal auto-recoverable debts.
CREATE OR REPLACE FUNCTION public.enforce_bucket_aware_obligation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.wallet_bucket = 'float' AND NEW.auto_recover THEN
    RAISE EXCEPTION 'INVALID_BUCKET_RECOVERY: float obligations may not set auto_recover=true (operational float shortfalls are not personal debts)';
  END IF;
  IF NEW.wallet_bucket = 'float' AND NEW.recovery_source <> 'float' THEN
    RAISE EXCEPTION 'INVALID_BUCKET_RECOVERY: float obligation must use recovery_source=float, got %', NEW.recovery_source;
  END IF;
  IF NEW.wallet_bucket = 'withdrawable' AND NEW.recovery_source = 'float' THEN
    RAISE EXCEPTION 'INVALID_BUCKET_RECOVERY: withdrawable obligation may not recover from float';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_bucket_aware_obligation ON public.cfo_debit_obligations;
CREATE TRIGGER trg_enforce_bucket_aware_obligation
BEFORE INSERT OR UPDATE ON public.cfo_debit_obligations
FOR EACH ROW EXECUTE FUNCTION public.enforce_bucket_aware_obligation();

-- 3. Float-scoped strict solvency helper.
CREATE OR REPLACE FUNCTION public.get_user_float_available_balance(p_user_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT GREATEST(0, COALESCE((SELECT float_balance FROM public.v_user_wallet_strict WHERE user_id = p_user_id), 0));
$$;

GRANT EXECUTE ON FUNCTION public.get_user_float_available_balance(uuid) TO authenticated, service_role;

-- 4. Bucket-aware recovery entry point.
CREATE OR REPLACE FUNCTION public.recover_cfo_debit_obligation(
  p_obligation_id uuid,
  p_amount numeric,
  p_source_bucket text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ob public.cfo_debit_obligations;
  v_new numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_RECOVERY_AMOUNT';
  END IF;

  SELECT * INTO v_ob FROM public.cfo_debit_obligations WHERE id = p_obligation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OBLIGATION_NOT_FOUND';
  END IF;

  IF v_ob.recovery_source <> p_source_bucket THEN
    RAISE EXCEPTION 'INVALID_BUCKET_RECOVERY: obligation recovery_source=% cannot be recovered from % credits',
      v_ob.recovery_source, p_source_bucket;
  END IF;

  IF v_ob.status NOT IN ('open','partially_recovered') THEN
    RAISE EXCEPTION 'OBLIGATION_NOT_RECOVERABLE: status=%', v_ob.status;
  END IF;

  v_new := LEAST(v_ob.amount, v_ob.recovered_amount + p_amount);

  UPDATE public.cfo_debit_obligations
  SET recovered_amount = v_new,
      status = CASE WHEN v_new >= amount THEN 'recovered' ELSE 'partially_recovered' END
  WHERE id = p_obligation_id;

  RETURN jsonb_build_object(
    'obligation_id', p_obligation_id,
    'recovery_source', v_ob.recovery_source,
    'wallet_bucket', v_ob.wallet_bucket,
    'recovered_amount', v_new,
    'amount', v_ob.amount
  );
END;
$$;

REVOKE ALL ON FUNCTION public.recover_cfo_debit_obligation(uuid, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recover_cfo_debit_obligation(uuid, numeric, text) TO service_role;

-- 5. Read-only audit report of legacy float obligations wrongly flagged auto_recover.
CREATE OR REPLACE FUNCTION public.report_float_auto_recover_obligations()
RETURNS TABLE (
  obligation_id uuid,
  user_id uuid,
  user_name text,
  amount numeric,
  recovered_amount numeric,
  outstanding numeric,
  status text,
  wallet_bucket text,
  recovery_source text,
  auto_recover boolean,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id, o.user_id, p.full_name, o.amount, o.recovered_amount,
         GREATEST(0, o.amount - o.recovered_amount), o.status,
         o.wallet_bucket, o.recovery_source, o.auto_recover, o.created_at
  FROM public.cfo_debit_obligations o
  LEFT JOIN public.profiles p ON p.id = o.user_id
  WHERE (o.wallet_bucket = 'float' OR o.metadata->>'wallet_bucket' = 'float')
    AND o.auto_recover = true
  ORDER BY o.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.report_float_auto_recover_obligations() TO authenticated, service_role;