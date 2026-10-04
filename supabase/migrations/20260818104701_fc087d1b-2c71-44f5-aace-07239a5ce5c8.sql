CREATE OR REPLACE FUNCTION public.get_cash_at_hand_total_system()
RETURNS json
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_total numeric;
  v_count integer;
BEGIN
  WITH latest AS (
    SELECT DISTINCT ON (v.deposit_request_id) v.deposit_request_id, v.amount, v.status
    FROM public.cash_deposit_verifications v
    ORDER BY v.deposit_request_id, v.created_at DESC
  )
  SELECT COALESCE(SUM(l.amount), 0), COUNT(*)
  INTO v_total, v_count
  FROM latest l
  JOIN public.deposit_requests dr ON dr.id = l.deposit_request_id
  WHERE l.status = 'verified'
    AND COALESCE(dr.purpose_audit->>'cash_location', 'cash_at_hand') = 'cash_at_hand';

  RETURN json_build_object('cash_at_hand_total', v_total, 'verified_count', v_count, 'computed_at', now());
END;
$function$;

REVOKE ALL ON FUNCTION public.get_cash_at_hand_total_system() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_cash_at_hand_total_system() TO service_role;