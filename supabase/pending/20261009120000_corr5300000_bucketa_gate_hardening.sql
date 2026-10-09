-- PENDING — NOT APPLIED. Needs separate explicit deployment approval (CFO + Josh).
-- Security hardening for the CORR-2026-10-08-9fc656402a73 and Bucket A posting gates
-- (audit 2026-10-09 10:06 EAT). Posts nothing, moves no money, touches no ledger rows,
-- does not change the package lines or the approved fingerprint 262bf75c20610b3682ce31a4ff508006.
--
-- Legitimate callers after this change:
--   * Gate page -> PostgREST RPC as role `authenticated` (auth.uid() from a verified JWT).
--   * cfo-bucket-a-post edge function -> verifies the JWT with auth.getUser, then
--     `set local role authenticated` + claims of the verified user. Still works.
-- Every write to the gate tables happens inside SECURITY DEFINER functions owned by postgres,
-- so no caller role needs direct table write grants.

BEGIN;

-- 1. Posting / pre-flight entry points: only `authenticated` (verified JWT) may call them.
--    Removes the internal sandbox roles (which can set request.jwt.claim.sub themselves)
--    and service_role (no JWT identity; nothing legitimate calls these as service_role).
REVOKE EXECUTE ON FUNCTION public.cfo_corr_5300000_post(uuid, text, text)   FROM PUBLIC, anon, service_role, sandbox_exec_wirntoujqoyjobfhyelc;
REVOKE EXECUTE ON FUNCTION public.cfo_corr_5300000_preflight()              FROM PUBLIC, anon, service_role, sandbox_exec_wirntoujqoyjobfhyelc;
REVOKE EXECUTE ON FUNCTION public.cfo_bucket_a_post(uuid, text, text)       FROM PUBLIC, anon, service_role, sandbox_exec_wirntoujqoyjobfhyelc;
REVOKE EXECUTE ON FUNCTION public.cfo_bucket_a_preflight()                  FROM PUBLIC, anon, service_role, sandbox_exec_wirntoujqoyjobfhyelc;

-- 2. Approver list and gate records: no direct writes by any API or internal role.
--    SELECT stays (RLS still limits authenticated reads; sandbox/investigator keep read-only checks).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.cfo_approval_approvers
  FROM PUBLIC, anon, authenticated, service_role, sandbox_exec, sandbox_exec_wirntoujqoyjobfhyelc;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.cfo_corr_5300000_events
  FROM PUBLIC, anon, authenticated, service_role, sandbox_exec, sandbox_exec_wirntoujqoyjobfhyelc;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.cfo_corr_5300000_lines
  FROM PUBLIC, anon, authenticated, service_role, sandbox_exec, sandbox_exec_wirntoujqoyjobfhyelc;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.cfo_bucket_a_events
  FROM PUBLIC, anon, authenticated, service_role, sandbox_exec, sandbox_exec_wirntoujqoyjobfhyelc;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.cfo_bucket_a_package_lines
  FROM PUBLIC, anon, authenticated, service_role, sandbox_exec, sandbox_exec_wirntoujqoyjobfhyelc;
-- Restrictive policy: even if a permissive write policy is added later, writes through RLS stay refused.
CREATE POLICY "Approver list is never writable through the API"
  ON public.cfo_approval_approvers AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (true) WITH CHECK (false);
-- Approver changes therefore require the database owner (a reviewed migration), by design.

-- 3. One-time keys enforced by the database.
--    Each correction posts two legs that share one key (bridge receivable leg + platform equity leg),
--    so uniqueness is (key, scope). Inside the posting transaction, a concurrent duplicate blocks
--    on the index and then fails; a rolled-back attempt leaves no row, so the key is not consumed.
CREATE UNIQUE INDEX IF NOT EXISTS general_ledger_cfo_corr_5300000_key_uniq
  ON public.general_ledger (idempotency_key, ledger_scope)
  WHERE idempotency_key LIKE 'cfo-corr-5300000:%';
-- Only one completion record can ever exist.
CREATE UNIQUE INDEX IF NOT EXISTS cfo_corr_5300000_events_one_commit
  ON public.cfo_corr_5300000_events ((true)) WHERE event_type = 'posting_committed';

-- 4. Fingerprint v2 (covers every material line field). Read-only helper ONLY; it is NOT wired into
--    cfo_corr_5300000_post. Current value 332a632588d9da2e60f84864b723c96e — needs explicit CFO approval
--    before any change to the gate's expected fingerprint.
CREATE OR REPLACE FUNCTION public._cfo_corr_5300000_hash_v2()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT md5('[' || string_agg(format('{"amount":%s,"credit":"%s","debit":"%s","equity_cat":"receivable_restatement_equity","equity_dir":"%s","key":"%s","label":"%s","line":%s,"post_source_id":"%s","post_source_table":"%s","receivable_cat":"%s","receivable_dir":"%s","source":[%s]}',
      trunc(amount)::bigint, credit_account, debit_account, equity_leg_direction, idempotency_key, replace(label,'"','\"'), line_no,
      post_source_id, post_source_table, receivable_leg_category, receivable_leg_direction,
      (SELECT string_agg('"'||s||'"', ',' ORDER BY o) FROM unnest(source_groups) WITH ORDINALITY u(s,o))), ',' ORDER BY line_no) || ']')
  FROM public.cfo_corr_5300000_lines
$$;
REVOKE ALL ON FUNCTION public._cfo_corr_5300000_hash_v2() FROM PUBLIC, anon, authenticated;

COMMIT;
