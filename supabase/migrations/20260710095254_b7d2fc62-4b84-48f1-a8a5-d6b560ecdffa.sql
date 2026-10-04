REVOKE SELECT ON public.credit_request_details FROM anon;
REVOKE SELECT ON public.credit_request_details FROM authenticated;

GRANT SELECT (
  id,
  loan_id,
  borrower_id,
  borrower_mm_name,
  landlord_name,
  landlord_on_platform,
  landlord_id,
  electricity_meter_number,
  water_meter_number,
  location_address,
  repayment_frequency,
  duration_days,
  platform_fee_rate,
  funder_interest_rate,
  platform_fee_amount,
  total_with_fees,
  agent_id,
  agent_verified,
  agent_verified_at,
  created_at,
  updated_at
) ON public.credit_request_details TO authenticated;

REVOKE SELECT ON public.vendors FROM anon;

GRANT SELECT (
  id,
  name,
  location,
  category,
  active,
  created_at
) ON public.vendors TO anon;

DROP POLICY IF EXISTS "Super admin only" ON public.wallet_backup_2026_04_17;
REVOKE ALL ON public.wallet_backup_2026_04_17 FROM anon;
REVOKE ALL ON public.wallet_backup_2026_04_17 FROM authenticated;