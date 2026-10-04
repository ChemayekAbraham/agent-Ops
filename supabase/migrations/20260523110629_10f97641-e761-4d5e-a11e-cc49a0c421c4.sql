
CREATE OR REPLACE FUNCTION public.enforce_single_forward_email_route()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_active_count int;
  v_reversed_count int;
BEGIN
  -- Reversal entries are always allowed (they offset a prior forward route).
  IF NEW.reason IS NOT NULL AND NEW.reason ILIKE 'Reversed%' THEN
    RETURN NEW;
  END IF;

  IF NEW.gmail_transaction_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Count existing forward routes (non-reversal) for this email tx.
  SELECT
    count(*) FILTER (WHERE reason IS NULL OR reason NOT ILIKE 'Reversed%'),
    count(*) FILTER (WHERE reason ILIKE 'Reversed%')
  INTO v_active_count, v_reversed_count
  FROM public.email_routing_history
  WHERE gmail_transaction_id = NEW.gmail_transaction_id;

  -- Allow re-routing only if every prior forward route has been reversed.
  IF v_active_count > v_reversed_count THEN
    RAISE EXCEPTION
      'DUPLICATE_EMAIL_ROUTE: email transaction % already has an active routing entry — reverse it first before re-routing.',
      NEW.gmail_transaction_id
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_single_forward_email_route ON public.email_routing_history;
CREATE TRIGGER trg_enforce_single_forward_email_route
BEFORE INSERT ON public.email_routing_history
FOR EACH ROW
EXECUTE FUNCTION public.enforce_single_forward_email_route();

COMMENT ON FUNCTION public.enforce_single_forward_email_route() IS
  'Prevents the same email transaction from being routed twice. Reversal entries (reason starting with "Reversed") are exempt and can re-enable routing if the prior forward route has been reversed.';
