-- Puts the three exception functions back as they were (no code needed) and removes the approval-code machinery.
DROP FUNCTION IF EXISTS public.allow_landlord_payouts_with_exception(uuid[], text);
DROP FUNCTION IF EXISTS public.allow_agent_landlord_float_withdrawal(uuid, text);
DROP FUNCTION IF EXISTS public.cfo_allow_rent_disbursement_exception(uuid[], text);
ALTER FUNCTION public.allow_landlord_payouts_with_exception_unchecked(uuid[], text) RENAME TO allow_landlord_payouts_with_exception;
ALTER FUNCTION public.allow_agent_landlord_float_withdrawal_unchecked(uuid, text) RENAME TO allow_agent_landlord_float_withdrawal;
ALTER FUNCTION public.cfo_allow_rent_disbursement_exception_unchecked(uuid[], text) RENAME TO cfo_allow_rent_disbursement_exception;
GRANT EXECUTE ON FUNCTION public.allow_landlord_payouts_with_exception(uuid[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.allow_agent_landlord_float_withdrawal(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cfo_allow_rent_disbursement_exception(uuid[], text) TO authenticated;
DROP FUNCTION IF EXISTS public.use_verified_exception_approval(text, uuid[], text);
DROP FUNCTION IF EXISTS public.verify_exception_otp(text, uuid[], text, text);
DROP FUNCTION IF EXISTS public.request_exception_otp(text, uuid[], text);
DROP FUNCTION IF EXISTS public.exception_otp_fingerprint(text, uuid[], text);
-- The table keeps its history; drop it only if it is not wanted:
-- DROP TABLE IF EXISTS public.exception_approval_codes;
-- DELETE FROM public.treasury_controls WHERE control_key = 'exception_approver_email';
