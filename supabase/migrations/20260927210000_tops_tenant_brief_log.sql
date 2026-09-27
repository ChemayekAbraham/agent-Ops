-- Tenant Ops Workspace — tops-tenant-brief edge function's log/rate-limit
-- table. Per docs/TOPS_RULES.md: new, additive object only. The written
-- allowed-paths list in that doc's "Definition of done" predates any task
-- needing an edge function and does not enumerate supabase/functions/** —
-- this task explicitly commissions "New Edge Function tops-tenant-brief",
-- and per the user's own clarification earlier in this build ("don't change
-- existing things Classic uses, create new where you need to"), a brand-new
-- function touching nothing existing is squarely in scope. Recorded here and
-- in the build log rather than silently assumed.
--
-- One table serves two purposes: the required "log to a tops_ table" record,
-- and the rate-limit check itself (counting this table's own rows for a user
-- in a trailing window) — no second table needed.
CREATE TABLE public.tops_tenant_brief_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  model text NOT NULL,
  validation_passed boolean NOT NULL,
  degraded_to_facts_only boolean NOT NULL,
  sentence_count integer NULL,
  error_detail text NULL
);

CREATE INDEX tops_tenant_brief_log_requested_by_idx ON public.tops_tenant_brief_log (requested_by, requested_at);
CREATE INDEX tops_tenant_brief_log_rent_request_id_idx ON public.tops_tenant_brief_log (rent_request_id);

COMMENT ON TABLE public.tops_tenant_brief_log IS
'One row per call to the tops-tenant-brief edge function. validation_passed / degraded_to_facts_only record whether the AI narrative was accepted (every UGX figure in it matched the supplied facts verbatim) or rejected in favour of returning the facts alone. Also serves as this function''s own rate-limit ledger (count of a user''s rows in a trailing window) — no separate rate-limit table exists. Written only by the edge function via the service-role client; no client write path.';

REVOKE ALL ON public.tops_tenant_brief_log FROM PUBLIC, anon;
GRANT SELECT ON public.tops_tenant_brief_log TO authenticated;
ALTER TABLE public.tops_tenant_brief_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY tops_tenant_brief_log_select_tops_roles ON public.tops_tenant_brief_log
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  );

-- No INSERT/UPDATE/DELETE policy for any client role — only the edge
-- function (service-role client, bypasses RLS) ever writes a row.
