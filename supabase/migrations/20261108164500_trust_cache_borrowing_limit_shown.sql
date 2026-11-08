-- Partner Returns per person, owner decision 2026-11-08 (4b, "hide it"): the cached borrowing (vouch) limit in
-- welile_trust_score_cache.borrowing_limit_ugx is built from a person's portfolio and Returns, so other
-- people must not see it for a person who has Returns. Postgres cannot mask one column per viewer inside a
-- table, so the browser reads a computed field instead:
--
--   welile_trust_score_cache.borrowing_limit_shown  (PostgREST computed field; alias it in a select:
--                                                    'borrowing_limit_ugx:borrowing_limit_shown')
--
-- It is the cached limit, or NULL when the person has Returns (any portfolio, or Returns paid) and the caller
-- is not the person, partner staff or an approved active supporter proxy: the same rule and the same helper
-- as 4b's get_user_trust_profile mask. Row visibility is unchanged (the table's own RLS still decides which
-- rows a caller sees).
--
-- This file only ADDS the field, so nothing changes for the published screens. Migration 4b
-- (20261108163000, applied after the screens that read borrowing_limit_shown are published) then removes the
-- browser's SELECT on the raw borrowing_limit_ugx column.
--
-- Note: called through /rpc with a hand-made row, the function answers whether that user id has Returns
-- (NULL vs the passed value). The public trust profile already says that (supporter_activity.earning_returns),
-- so this reveals nothing new.
-- Rollback: supabase/rollbacks/20261108164500_trust_cache_borrowing_limit_shown.rollback.sql

-- The 4b helper, created here verbatim so this field can use it before 4b; 4b re-creates it unchanged.
CREATE OR REPLACE FUNCTION public.partner_returns_visible_to_caller(p_person uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p_person IS NOT NULL AND (
           COALESCE((SELECT auth.uid()) = p_person, false)
        OR EXISTS (SELECT 1 FROM public.proxy_agent_assignments m
                    WHERE m.agent_id = (SELECT auth.uid()) AND m.beneficiary_id = p_person
                      AND m.is_active = true AND m.approval_status = 'approved'
                      AND m.beneficiary_role = 'supporter')
        OR COALESCE(public.partner_rate_visible_to_caller(p_person), false));
$function$;
REVOKE ALL ON FUNCTION public.partner_returns_visible_to_caller(uuid) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.partner_returns_visible_to_caller(uuid) IS
  'True when the caller may see this person''s Returns figures and rate: the person, partner staff (or a backend context), or an approved active supporter proxy agent. Never NULL. Owner-run 4b readers only.';

CREATE OR REPLACE FUNCTION public.borrowing_limit_shown(c public.welile_trust_score_cache)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
           WHEN c.user_id IS NULL OR c.borrowing_limit_ugx IS NULL THEN c.borrowing_limit_ugx
           WHEN public.partner_returns_visible_to_caller(c.user_id) THEN c.borrowing_limit_ugx
           WHEN EXISTS (SELECT 1 FROM public.investor_portfolios ip WHERE ip.investor_id = c.user_id)
             OR EXISTS (SELECT 1 FROM public.supporter_roi_payments r
                         WHERE r.supporter_id = c.user_id AND r.status = 'paid') THEN NULL
           ELSE c.borrowing_limit_ugx
         END;
$function$;
REVOKE ALL ON FUNCTION public.borrowing_limit_shown(public.welile_trust_score_cache) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.borrowing_limit_shown(public.welile_trust_score_cache) TO authenticated, service_role;
COMMENT ON FUNCTION public.borrowing_limit_shown(public.welile_trust_score_cache) IS
  'Computed field: the cached borrowing limit, or NULL for a person with Returns unless the caller is that person, partner staff or their approved active supporter proxy (Partner Returns 4b, owner decision 2026-11-08).';
