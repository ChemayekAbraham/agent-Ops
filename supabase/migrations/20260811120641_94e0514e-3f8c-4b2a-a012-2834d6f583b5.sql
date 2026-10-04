CREATE OR REPLACE FUNCTION public.get_phone_platform_reconciliation()
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  SELECT json_build_object(
    'mtn_balance', COALESCE(m.balance, 0),
    'mtn_last_sms_at', m.internal_date,
    'airtel_balance', COALESCE(a.balance, 0),
    'airtel_last_sms_at', a.internal_date,
    'total_float', COALESCE(m.balance, 0) + COALESCE(a.balance, 0),
    'computed_at', now()
  )
  FROM (SELECT 1) AS anchor
  LEFT JOIN LATERAL (
    SELECT balance, internal_date FROM public.gmail_transactions
    WHERE channel = 'mtn_momo' AND balance IS NOT NULL AND subject ILIKE '%MobMoney%'
    ORDER BY internal_date DESC LIMIT 1
  ) m ON true
  LEFT JOIN LATERAL (
    SELECT balance, internal_date FROM public.gmail_transactions
    WHERE channel = 'airtel_money' AND balance IS NOT NULL AND subject ILIKE '%AirtelMoney%'
    ORDER BY internal_date DESC LIMIT 1
  ) a ON true;
$fn$;

REVOKE ALL ON FUNCTION public.get_phone_platform_reconciliation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_phone_platform_reconciliation() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_cash_at_hand_total()
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
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
$fn$;

REVOKE ALL ON FUNCTION public.get_cash_at_hand_total() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_cash_at_hand_total() TO authenticated;