-- 2026-10-19 (doc 247, step 23): new functions are no longer callable by anon / signed-in users by default.
-- Before: default privileges for functions created by `postgres` in schema public granted EXECUTE to anon, authenticated and service_role, so every new
-- owner-rights function was open to the API the moment it was created (the cause of 2,000+ exposed functions).
-- After: new functions in public get EXECUTE for the owner and service_role only; the global default no longer grants PUBLIC.
-- A migration that adds an RPC the browser calls must now grant it explicitly:
--     grant execute on function public.my_fn(args) to authenticated;   -- (and `anon` only for genuine pre-login flows)
-- CREATE OR REPLACE keeps the existing grants; DROP + CREATE resets them to this closed default, so re-grant after any drop/recreate.
-- Existing functions are unchanged. Applied to production 2026-10-19.
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated, public;
alter default privileges for role postgres revoke execute on functions from public;
