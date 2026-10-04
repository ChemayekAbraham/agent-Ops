CREATE OR REPLACE FUNCTION public.get_money_at_bank_total()
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total numeric;
  v_count integer;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'operations') OR public.has_role(auth.uid(), 'financial_ops')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT COALESCE(SUM(gt.amount), 0), COUNT(*)
  INTO v_total, v_count
  FROM public.gmail_transactions gt
  WHERE gt.channel = 'bank'
    AND gt.direction = 'in'
    AND lower(
      COALESCE(gt.raw_body, '') || ' ' ||
      COALESCE(gt.snippet, '') || ' ' ||
      COALESCE(gt.subject, '')
    ) ~ 'dear[[:space:]]+bayo'
    AND lower(
      COALESCE(gt.raw_body, '') || ' ' ||
      COALESCE(gt.snippet, '') || ' ' ||
      COALESCE(gt.subject, '')
    ) ~ 'from[[:space:]]+welile[[:space:]]+technologies';

  RETURN json_build_object('money_at_bank_total', v_total, 'verified_count', v_count, 'computed_at', now());
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_money_at_bank_total() TO authenticated;