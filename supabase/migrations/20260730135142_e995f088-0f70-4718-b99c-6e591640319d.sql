CREATE OR REPLACE FUNCTION public.enforce_unique_deposit_tid()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_id uuid;
  v_existing_status text;
  v_existing_amount numeric;
  v_existing_created timestamptz;
  v_norm_tid text;
  v_norm_provider text;
  v_old_active boolean;
  v_new_active boolean;
BEGIN
  IF NEW.transaction_id IS NULL OR length(btrim(NEW.transaction_id)) = 0 THEN
    RETURN NEW;
  END IF;

  IF NEW.status IN ('rejected', 'cancelled', 'failed') THEN
    RETURN NEW;
  END IF;

  v_norm_tid := lower(btrim(NEW.transaction_id));
  v_norm_provider := lower(coalesce(NEW.provider, ''));
  v_new_active := NEW.status NOT IN ('rejected', 'cancelled', 'failed');

  IF TG_OP = 'UPDATE' THEN
    v_old_active := OLD.status NOT IN ('rejected', 'cancelled', 'failed');

    -- Status progression within the active lifecycle (for example pending →
    -- approved) must not be blocked by a historical/concurrent duplicate.
    -- No TID is being introduced or reactivated in this path.
    IF lower(btrim(coalesce(OLD.transaction_id, ''))) = v_norm_tid
       AND lower(coalesce(OLD.provider, '')) = v_norm_provider
       AND v_old_active
       AND v_new_active THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT id, status, amount, created_at
    INTO v_existing_id, v_existing_status, v_existing_amount, v_existing_created
  FROM public.deposit_requests
  WHERE lower(btrim(transaction_id)) = v_norm_tid
    AND lower(coalesce(provider, '')) = v_norm_provider
    AND status NOT IN ('rejected', 'cancelled', 'failed')
    AND id <> NEW.id
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Duplicate transaction ID: TID % on % was already recorded on % (deposit %, status %, amount UGX %). Each TID can only be used once.',
      NEW.transaction_id,
      coalesce(NEW.provider, 'unknown'),
      to_char(v_existing_created, 'YYYY-MM-DD HH24:MI'),
      v_existing_id,
      v_existing_status,
      v_existing_amount
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- Repair only requests whose wallet credit already exists. This changes status
-- metadata only and cannot create a second credit.
UPDATE public.deposit_requests AS d
SET status = 'approved',
    approved_at = COALESCE(d.approved_at, gl.first_posted_at),
    updated_at = now()
FROM (
  SELECT source_id, min(created_at) AS first_posted_at
  FROM public.general_ledger
  WHERE source_table = 'deposit_requests'
    AND category IN ('wallet_deposit', 'agent_float_deposit')
    AND direction = 'cash_in'
    AND ledger_scope = 'wallet'
  GROUP BY source_id
) AS gl
WHERE d.id = gl.source_id
  AND d.status = 'pending';