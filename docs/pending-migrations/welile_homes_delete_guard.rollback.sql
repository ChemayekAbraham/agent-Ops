-- Rollback for docs/pending-migrations/welile_homes_delete_guard.sql
-- Restores delete_welile_home_subscription exactly as defined in
-- supabase/migrations/20260817204253_99b9baf0-e729-4fa3-904d-17f54dc3010d.sql
-- (permission check only — repaying plans become deletable again).
-- Touches no data, wallet or ledger. Grants are kept by CREATE OR REPLACE.
BEGIN;

CREATE OR REPLACE FUNCTION public.delete_welile_home_subscription(p_subscription_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_subscription public.welile_homes_subscriptions%ROWTYPE;
BEGIN
  SELECT * INTO v_subscription
  FROM public.welile_homes_subscriptions
  WHERE id = p_subscription_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Subscription not found';
  END IF;

  IF NOT COALESCE(v_subscription.agent_id = auth.uid(), false)
     AND NOT COALESCE(v_subscription.enrolled_by = auth.uid(), false)
     AND NOT public.has_role(auth.uid(), 'manager') THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;

  DELETE FROM public.welile_homes_monthly_dues WHERE subscription_id = p_subscription_id;
  DELETE FROM public.welile_homes_enrollment_audit WHERE subscription_id = p_subscription_id;

  DELETE FROM public.welile_homes_subscriptions WHERE id = p_subscription_id;

  RETURN true;
END;
$$;

COMMIT;
