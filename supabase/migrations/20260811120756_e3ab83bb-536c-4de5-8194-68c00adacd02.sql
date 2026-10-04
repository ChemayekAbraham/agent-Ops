CREATE OR REPLACE FUNCTION public.get_phone_platform_reconciliation()
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  WITH calc AS (
    SELECT
      COALESCE(m.balance, 0) AS mtn_balance,
      m.internal_date AS mtn_last_sms_at,
      COALESCE(a.balance, 0) AS airtel_balance,
      a.internal_date AS airtel_last_sms_at,
      COALESCE(m.balance, 0) + COALESCE(a.balance, 0) AS phone_total,
      COALESCE(p.total_balance, 0) AS platform_total,
      p.computed_at AS platform_computed_at,
      COALESCE(p.total_balance, 0) * 0.5 AS expected_phone_total
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
    ) a ON true
    LEFT JOIN public.wallet_totals_cache p ON p.id = 1
  )
  SELECT json_build_object(
    'mtn_balance', mtn_balance,
    'mtn_last_sms_at', mtn_last_sms_at,
    'airtel_balance', airtel_balance,
    'airtel_last_sms_at', airtel_last_sms_at,
    'total_float', phone_total,
    'phone_total', phone_total,
    'platform_total', platform_total,
    'platform_computed_at', platform_computed_at,
    'target_ratio', 0.5,
    'expected_phone_total', expected_phone_total,
    'gap_amount', phone_total - expected_phone_total,
    'gap_pct', CASE WHEN expected_phone_total = 0 THEN 0
      ELSE ROUND(((phone_total - expected_phone_total) / expected_phone_total) * 100, 2) END,
    'tolerance_amount', GREATEST(500000, expected_phone_total * 0.15),
    'is_on_target', (phone_total - expected_phone_total) >= -GREATEST(500000, expected_phone_total * 0.15),
    'computed_at', now()
  ) FROM calc;
$fn$;

REVOKE ALL ON FUNCTION public.get_phone_platform_reconciliation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_phone_platform_reconciliation() TO authenticated;