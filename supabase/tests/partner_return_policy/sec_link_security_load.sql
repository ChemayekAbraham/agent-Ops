-- The REAL promissory-note link security migration (20261106200000, commit 5e2ad5e930; not yet in production on 2026-11-07:
-- trg_guard_note_direct_edit absent, the browser INSERT policy present), loaded VERBATIM from
-- sec_link_security_20261106200000.sql in place of the earlier no-op trg_guard_note_direct_edit stand-in.
-- The stubs keep app_role values as text, so production's current_user_has_any_role_ignoring_enabled(app_role[]) is a
-- stub-only overload that delegates to the stub's text[] version (the migration calls it with ::public.app_role[]).
-- Include with \ir from a test file (inside a transaction or not). LOCAL THROWAWAY CLUSTER ONLY.
CREATE OR REPLACE FUNCTION public.current_user_has_any_role_ignoring_enabled(p_roles public.app_role[]) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public AS $$ SELECT public.current_user_has_any_role_ignoring_enabled(p_roles::text[]) $$;
\ir sec_link_security_20261106200000.sql
