REVOKE SELECT ON public.landlord_payout_otp_challenges FROM authenticated;
REVOKE SELECT ON public.landlord_payout_otp_challenges FROM anon;

GRANT SELECT (
  id, agent_id, landlord_id, tenant_id, rent_request_id, amount,
  landlord_name, landlord_phone, tenant_name, tenant_phone,
  mobile_money_provider, otp_expires_at, attempts, max_attempts, status,
  verified_at, resulting_payout_id, agent_latitude, agent_longitude,
  property_latitude, property_longitude, metadata, created_at, updated_at
) ON public.landlord_payout_otp_challenges TO authenticated;

GRANT ALL ON public.landlord_payout_otp_challenges TO service_role;