CREATE OR REPLACE FUNCTION public.wallet_transfer_reversal_states(p_references text[])
RETURNS TABLE (reference_id text, state text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r text;
  s jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in required.';
  END IF;

  -- Batched wrapper: each transfer is resolved by the exact same per-transfer
  -- status function the statement's badges and Reverse button use, so a filter
  -- result can never disagree with the badge on the same row.
  FOREACH r IN ARRAY p_references LOOP
    CONTINUE WHEN r IS NULL OR r = '' OR r LIKE '%-REV';
    s := public.wallet_transfer_reversal_status(r);
    reference_id := r;
    state := s->>'state';
    RETURN NEXT;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.wallet_transfer_reversal_states(text[]) TO authenticated;