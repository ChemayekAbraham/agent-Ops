CREATE OR REPLACE FUNCTION public.my_staff_loan_eligibility()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_eligible boolean := false;
  v_active integer := 0;
  v_owed numeric := 0;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'not_signed_in');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_uid AND ur.role = 'employee' AND COALESCE(ur.enabled, true)
  ) INTO v_eligible;

  SELECT count(*), COALESCE(sum(outstanding_principal + accrued_interest), 0)
    INTO v_active, v_owed
    FROM public.staff_loans
   WHERE user_id = v_uid AND status = 'active';

  RETURN jsonb_build_object(
    'eligible', v_eligible,
    'monthly_rate', 0.28,
    'max_months', 12,
    'active_loans', v_active,
    'outstanding', v_owed
  );
END
$function$;