-- Rollback for 20261108164500_trust_cache_borrowing_limit_shown.sql.
-- Run only after the browser SELECT on welile_trust_score_cache.borrowing_limit_ugx is back (4b rollback) and
-- no published screen reads borrowing_limit_shown any more.
SET client_encoding = 'UTF8';
DROP FUNCTION IF EXISTS public.borrowing_limit_shown(public.welile_trust_score_cache);
-- partner_returns_visible_to_caller(uuid) stays when 4b is applied (4b owns it); drop it only if 4b is not.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                  AND p.prosrc LIKE '%Partner Returns Phase 4b%') THEN
    DROP FUNCTION IF EXISTS public.partner_returns_visible_to_caller(uuid);
  END IF;
END $$;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261108164500';
