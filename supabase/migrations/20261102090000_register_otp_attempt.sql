-- Atomic OTP guess counter for the otp-login edge function.
-- Already run by hand in the production SQL editor on 2026-11-02; this file
-- records it. CREATE OR REPLACE and re-granting make it safe to run again.

create or replace function public.register_otp_attempt(p_otp_id uuid)
returns integer
language sql
security definer
set search_path = public
as $$
  update otp_verifications
  set attempts = attempts + 1
  where id = p_otp_id
  returning attempts;
$$;

revoke all on function public.register_otp_attempt(uuid) from public, anon, authenticated;
grant execute on function public.register_otp_attempt(uuid) to service_role;
