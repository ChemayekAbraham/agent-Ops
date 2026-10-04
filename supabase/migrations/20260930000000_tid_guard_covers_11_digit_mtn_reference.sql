-- Doc 168: the TID deposit guard could not see 11-digit MTN transaction ids.
--
-- enforce_tid_deposit_uniqueness() pulled the TID out of idempotency_key,
-- reference_id or description with extract_tid_normalized(), whose fallback
-- only recognises a standalone 12-13 digit run. MTN ids are often 11 digits
-- (e.g. 43868722751), so the guard returned early and neither blocked nor
-- recorded the credit. A manual FinOps float credit (which locks the TID
-- itself) followed by the email auto-match of the same SMS therefore
-- credited the same money twice.
--
-- Fix: when the extractor finds nothing, fall back to reference_id when it is
-- exactly a TID (optional "TID" prefix + 10-14 digits). Nothing else changes;
-- extract_tid_normalized() is left alone because it is also used for free-text
-- descriptions where a looser match would hit phone numbers and amounts.

CREATE OR REPLACE FUNCTION public.enforce_tid_deposit_uniqueness()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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

  -- reference_id that IS a TID but is shorter than the extractor's 12-13 digit
  -- fallback (11-digit MTN ids).
  IF v_tid IS NULL AND NEW.reference_id ~* '^(TID)?[0-9]{10,14}$' THEN
    v_tid := regexp_replace(NEW.reference_id, '^TID', '', 'i');
  END IF;

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
$function$;
