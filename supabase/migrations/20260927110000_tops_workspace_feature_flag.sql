-- Tenant Ops Workspace — kill switch for the new tab.
--
-- Per docs/TOPS_RULES.md: "the new tab reads a feature flag from the existing
-- config mechanism (read-only) and renders nothing when it is off." The
-- existing mechanism, per docs/TOPS_FINDINGS.md §9, is system_config (a
-- generic key/value table already used for at least five unrelated keys)
-- plus a thin STABLE SECURITY DEFINER wrapper function — the exact pattern
-- is_agent_perf_gate_disabled() already establishes. We use that existing
-- mechanism rather than inventing a second one: this migration adds ONE new
-- row (a new key, `tops_workspace_enabled`, INSERT ... ON CONFLICT DO
-- NOTHING) and ONE new wrapper function. No ALTER on system_config, no new
-- policy on it — the wrapper function is SECURITY DEFINER and reads it the
-- same way is_agent_perf_gate_disabled() does, so no RLS change is needed.
--
-- Seeded OFF (false): this is a new, not-yet-built-out tab (this task adds
-- only its shell and placeholder sections). Turning it on is a one-row
-- UPDATE, not a deploy.
INSERT INTO public.system_config (key, value)
VALUES ('tops_workspace_enabled', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.tops_is_workspace_enabled()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT (value #>> '{}')::boolean FROM public.system_config WHERE key = 'tops_workspace_enabled'),
    false
  );
$$;

-- Per docs/TOPS_RULES.md standards ("Never grant EXECUTE to anon"): revoke
-- from PUBLIC and anon explicitly, not just PUBLIC — this schema has a
-- pre-existing default-privilege rule that grants EXECUTE on every new
-- function straight to anon/authenticated at CREATE time (the same
-- mechanism recorded against every earlier tops_* function in this build).
REVOKE ALL ON FUNCTION public.tops_is_workspace_enabled() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_is_workspace_enabled() TO authenticated;

COMMENT ON FUNCTION public.tops_is_workspace_enabled() IS
'Kill switch for the Tenant Ops Workspace tab, read from system_config (key = tops_workspace_enabled) via the same pattern as is_agent_perf_gate_disabled(). Defaults false (missing row) so the tab stays off unless explicitly turned on. EXECUTE granted to authenticated only.';
