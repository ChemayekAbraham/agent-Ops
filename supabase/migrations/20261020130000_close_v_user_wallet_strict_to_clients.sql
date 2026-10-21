-- 2026-10-20 (doc 247, step 36): v_user_wallet_strict closed to browsers. Its only reader, ProxyPartnerFunds, now calls the checked function
-- wallet_strict_withdrawable_for_users (step 31). Edge functions and database functions are unaffected (owner / service role).
-- Applied to production 2026-10-20 on Josh's instruction before the screen was confirmed live ("close it anyway").
-- Undo: grant select on public.v_user_wallet_strict to authenticated;
revoke select on public.v_user_wallet_strict from authenticated;
