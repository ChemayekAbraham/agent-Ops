
-- Helper: extract a normalized TID (digits only, 10-14 chars) from free text
CREATE OR REPLACE FUNCTION public.extract_tid_normalized(p_text text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v text;
BEGIN
  IF p_text IS NULL OR length(p_text) = 0 THEN
    RETURN NULL;
  END IF;
  -- Prefer explicit "TID <digits>" pattern first
  v := (regexp_matches(p_text, 'TID[^0-9]?([0-9]{10,14})', 'i'))[1];
  IF v IS NOT NULL THEN RETURN v; END IF;
  -- Fallback: any standalone 12-13 digit run (Airtel/MTN TIDs today)
  v := (regexp_matches(p_text, '(?<![0-9])([0-9]{12,13})(?![0-9])'))[1];
  RETURN v;
END;
$$;

-- Trigger function: on wallet-side deposit credit, enforce TID uniqueness
CREATE OR REPLACE FUNCTION public.enforce_tid_deposit_uniqueness()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tid text;
  v_haystack text;
  v_existing_source text;
  v_existing_id uuid;
BEGIN
  -- Only guard user-facing deposit credits (wallet leg, cash_in)
  IF NEW.ledger_scope <> 'wallet' OR NEW.direction <> 'cash_in' THEN
    RETURN NEW;
  END IF;

  IF NEW.category NOT IN (
    'agent_float_deposit',
    'agent_float_topup',
    'agent_float_funding',
    'deposit',
    'wallet_deposit'
  ) THEN
    RETURN NEW;
  END IF;

  -- Skip reversal / correction / offset legs — they intentionally reference the same TID
  v_haystack := lower(coalesce(NEW.idempotency_key,'') || ' ' || coalesce(NEW.description,''));
  IF v_haystack ~ '(reversal|reverse|offset|correction|admincorr|writedown)' THEN
    RETURN NEW;
  END IF;

  -- Extract TID: check idempotency_key, reference_id, then description
  v_tid := public.extract_tid_normalized(NEW.idempotency_key);
  IF v_tid IS NULL THEN v_tid := public.extract_tid_normalized(NEW.reference_id); END IF;
  IF v_tid IS NULL THEN v_tid := public.extract_tid_normalized(NEW.description); END IF;

  IF v_tid IS NULL THEN
    RETURN NEW; -- no TID to guard on
  END IF;

  -- If already reconciled, block this insert
  SELECT source, source_id INTO v_existing_source, v_existing_id
  FROM public.ledger_reconciled_tids
  WHERE tid_normalized = v_tid
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Duplicate TID % — already credited (source: %, id: %). Refusing to double-credit.',
      v_tid, v_existing_source, v_existing_id
      USING ERRCODE = 'unique_violation';
  END IF;

  -- Record it so future SMS/email cannot re-credit
  INSERT INTO public.ledger_reconciled_tids
    (tid_normalized, source, source_id, amount, user_id, notes)
  VALUES
    (v_tid, 'general_ledger', NEW.id, NEW.amount, NEW.user_id,
     'Auto-recorded by TID guard on ' || NEW.category);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_tid_deposit_uniqueness ON public.general_ledger;
CREATE TRIGGER trg_enforce_tid_deposit_uniqueness
BEFORE INSERT ON public.general_ledger
FOR EACH ROW
EXECUTE FUNCTION public.enforce_tid_deposit_uniqueness();

-- Backfill from historical wallet-side deposit credits (skipping reversals/offsets/corrections)
INSERT INTO public.ledger_reconciled_tids (tid_normalized, source, source_id, amount, user_id, notes)
SELECT DISTINCT ON (tid)
  tid,
  'general_ledger',
  gl.id,
  gl.amount,
  gl.user_id,
  'Backfilled from historical ledger entry'
FROM (
  SELECT
    id, amount, user_id, category, ledger_scope, direction, description, idempotency_key, reference_id, created_at,
    coalesce(
      public.extract_tid_normalized(idempotency_key),
      public.extract_tid_normalized(reference_id),
      public.extract_tid_normalized(description)
    ) AS tid
  FROM public.general_ledger
  WHERE ledger_scope = 'wallet'
    AND direction = 'cash_in'
    AND category IN ('agent_float_deposit','agent_float_topup','agent_float_funding','deposit','wallet_deposit')
    AND lower(coalesce(idempotency_key,'') || ' ' || coalesce(description,''))
        !~ '(reversal|reverse|offset|correction|admincorr|writedown)'
) gl
WHERE tid IS NOT NULL
ORDER BY tid, created_at ASC
ON CONFLICT (tid_normalized) DO NOTHING;

-- Backfill from gmail_transactions that were already matched to a deposit request
INSERT INTO public.ledger_reconciled_tids (tid_normalized, source, source_id, amount, notes)
SELECT DISTINCT ON (transaction_id)
  transaction_id,
  'gmail_transactions',
  id,
  amount,
  'Backfilled from gmail_transactions'
FROM public.gmail_transactions
WHERE transaction_id IS NOT NULL
  AND length(regexp_replace(transaction_id,'[^0-9]','','g')) BETWEEN 10 AND 14
  AND (parsed = true OR linked_deposit_request_id IS NOT NULL)
ORDER BY transaction_id, internal_date ASC NULLS LAST
ON CONFLICT (tid_normalized) DO NOTHING;
