-- WelileHomesSubscriptionsManager's "Apply Interest" button (manager-only
-- page, client-side gated to role='manager') calls the edge function
-- 'apply-welile-homes-interest', which does not exist -- every click has
-- been failing. The real logic already lives in the RPC
-- apply_welile_homes_monthly_interest(), which compounds 5% interest onto
-- every active, landlord-registered subscription's total_savings.
--
-- Before wiring the frontend to call it directly: this RPC had NO
-- authorization check in its body at all, and was executable by `anon` and
-- `authenticated` (Supabase's default broad grant, never revoked here as it
-- is everywhere else in this codebase). Any signed-in user -- or an
-- unauthenticated request straight against the REST endpoint -- could
-- compound interest across the whole book on demand, independent of the
-- client-side manager-only route guard, which is not a security boundary by
-- itself. Adds the same role check pattern used elsewhere for manager-
-- triggered financial batch actions before the frontend is pointed at this
-- function.

CREATE OR REPLACE FUNCTION public.apply_welile_homes_monthly_interest()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_monthly_rate NUMERIC := 0.05; -- 5% monthly compound
  v_updated_count INTEGER := 0;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Not authorized to apply Welile Homes interest.';
  END IF;

  -- Apply 5% interest to all active subscriptions that haven't had interest applied this month
  UPDATE public.welile_homes_subscriptions
  SET
    total_savings = total_savings * (1 + v_monthly_rate),
    months_enrolled = months_enrolled + 1,
    last_interest_applied_at = now(),
    updated_at = now()
  WHERE subscription_status = 'active'
  AND landlord_registered = true
  AND total_savings > 0
  AND (
    last_interest_applied_at IS NULL
    OR last_interest_applied_at < date_trunc('month', now())
  );

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  RETURN v_updated_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_welile_homes_monthly_interest() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_welile_homes_monthly_interest() TO authenticated;
