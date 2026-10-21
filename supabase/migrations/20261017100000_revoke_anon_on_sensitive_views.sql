-- 2026-10-17: Supabase advisor lint (exposed auth users / security definer views).
-- Four views owned by postgres (no security_invoker) were readable by the public role `anon`:
-- v_accounts_no_verified_phone (96,957 rows: names, emails, phones, via auth.users),
-- v_lc1_verification_inbox (24,560 rows of chairperson/agent contact data),
-- v_user_wallet_strict (every user's wallet balances), v_merchant_float_position (agent phones, float, amounts owed).
-- Signed-out visitors have no use for them (nothing in src/ or supabase/functions/ reads them signed out).
-- Already applied to production on 2026-10-17; this file keeps rebuilds consistent. Idempotent.
-- NOT changed here: `authenticated` still reads them (staff dashboards and 7 edge functions depend on it); see doc 247.
revoke all on public.v_accounts_no_verified_phone, public.v_user_wallet_strict,
              public.v_merchant_float_position, public.v_lc1_verification_inbox from anon;
