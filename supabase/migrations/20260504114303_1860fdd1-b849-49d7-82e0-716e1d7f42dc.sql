-- Reject duplicate (provider, transaction_id) on deposit_requests.
-- Scope: only block when an active record (status in pending/approved/processing)
-- already uses that TID. Rejected/cancelled deposits do not block re-use.

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
BEGIN
  -- Only enforce when a TID is provided.
  IF NEW.transaction_id IS NULL OR length(btrim(NEW.transaction_id)) = 0 THEN
    RETURN NEW;
  END IF;

  -- Skip when the row itself is being created/updated as rejected/cancelled.
  IF NEW.status IN ('rejected', 'cancelled', 'failed') THEN
    RETURN NEW;
  END IF;

  v_norm_tid := lower(btrim(NEW.transaction_id));
  v_norm_provider := lower(coalesce(NEW.provider, ''));

  -- On UPDATE, allow same row to keep its TID.
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

DROP TRIGGER IF EXISTS trg_enforce_unique_deposit_tid ON public.deposit_requests;
CREATE TRIGGER trg_enforce_unique_deposit_tid
BEFORE INSERT OR UPDATE OF transaction_id, provider, status
ON public.deposit_requests
FOR EACH ROW
EXECUTE FUNCTION public.enforce_unique_deposit_tid();

-- Supporting index to keep the lookup cheap.
CREATE INDEX IF NOT EXISTS idx_deposit_requests_tid_provider_active
  ON public.deposit_requests (lower(btrim(transaction_id)), lower(coalesce(provider, '')))
  WHERE status NOT IN ('rejected', 'cancelled', 'failed')
    AND transaction_id IS NOT NULL;
