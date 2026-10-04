-- Relax single-route guardrail: block re-routing only to the SAME target user.
-- Routing the same email/MoMo transaction to a DIFFERENT user remains allowed
-- (e.g. an auto-credit went to user A but the money truly belonged to user B —
-- ops can still post a corrective route to B after reversing A, OR route the
-- residual to another user without touching A).

CREATE OR REPLACE FUNCTION public.enforce_single_forward_email_route()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_active_count INT;
  v_reversed_count INT;
BEGIN
  -- Reversal rows are always allowed through.
  IF NEW.reason IS NOT NULL AND NEW.reason ILIKE 'Reversed%' THEN
    RETURN NEW;
  END IF;

  -- Skip if we don't know the source transaction or target user — nothing to
  -- de-duplicate against.
  IF NEW.gmail_transaction_id IS NULL OR NEW.target_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Count active (non-reversal) forwards for this gmail_transaction_id
  -- scoped to the SAME target_user_id.
  SELECT
    COUNT(*) FILTER (WHERE reason IS NULL OR reason NOT ILIKE 'Reversed%'),
    COUNT(*) FILTER (WHERE reason ILIKE 'Reversed%')
  INTO v_active_count, v_reversed_count
  FROM email_routing_history
  WHERE gmail_transaction_id = NEW.gmail_transaction_id
    AND target_user_id = NEW.target_user_id;

  IF v_active_count > v_reversed_count THEN
    RAISE EXCEPTION 'DUPLICATE_EMAIL_ROUTE: this MoMo/email transaction has already been routed to this user. Reverse the existing entry first, or route to a different user.'
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$;