-- Agent vetting: record every change to agent_vetting_settings.
--
-- On 2026-10-27, between about 11:20 and 11:32 UTC, someone set enforce = true (the switch that
-- blocks unverified agents from adding tenants and posting Rent Plan requests) while every agent
-- was still unverified. updated_at did not move and nothing recorded who did it. From now on every
-- insert, update and delete on the settings row writes one audit row, and updated_at follows real
-- changes.
--
-- Who: auth.uid() for app/API calls. Direct SQL (dashboard SQL editor, CLI) has no auth.uid(), so
-- the database role, application name and client address are kept as well; the dashboard and the
-- CLI identify themselves in application_name.

CREATE TABLE IF NOT EXISTS public.agent_vetting_settings_audit (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  changed_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  operation        text NOT NULL,
  changed_by       uuid,
  db_role          text NOT NULL DEFAULT current_user,
  session_role     text NOT NULL DEFAULT session_user,
  application_name text,
  client_addr      inet,
  jwt_role         text,
  changed_fields   text[],
  old_row          jsonb,
  new_row          jsonb
);
CREATE INDEX IF NOT EXISTS agent_vetting_settings_audit_at_idx
  ON public.agent_vetting_settings_audit (changed_at DESC);

ALTER TABLE public.agent_vetting_settings_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_vetting_settings_audit_read ON public.agent_vetting_settings_audit;
CREATE POLICY agent_vetting_settings_audit_read ON public.agent_vetting_settings_audit
  FOR SELECT TO authenticated USING ((SELECT public.is_agent_vetting_reviewer(auth.uid())));
DROP POLICY IF EXISTS mfa_required_for_staff ON public.agent_vetting_settings_audit;
CREATE POLICY mfa_required_for_staff ON public.agent_vetting_settings_audit AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));
-- Append-only: rows come from the trigger; nobody updates or deletes them through the API.
REVOKE ALL ON public.agent_vetting_settings_audit FROM anon, authenticated;
GRANT SELECT ON public.agent_vetting_settings_audit TO authenticated;
GRANT SELECT, INSERT ON public.agent_vetting_settings_audit TO service_role;

-- updated_at follows real changes (it stayed at creation time when enforce was flipped).
CREATE OR REPLACE FUNCTION public.agent_vetting_settings_touch()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $$
BEGIN
  IF to_jsonb(NEW) - 'updated_at' IS DISTINCT FROM to_jsonb(OLD) - 'updated_at' THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.agent_vetting_settings_touch() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_agent_vetting_settings_touch ON public.agent_vetting_settings;
CREATE TRIGGER trg_agent_vetting_settings_touch
  BEFORE UPDATE ON public.agent_vetting_settings
  FOR EACH ROW EXECUTE FUNCTION public.agent_vetting_settings_touch();

-- Runs as the caller (not SECURITY DEFINER) so current_user is whoever made the change. Only
-- privileged roles can write the settings row, and they can all insert here; anyone else's change
-- fails along with its audit row.
CREATE OR REPLACE FUNCTION public.agent_vetting_settings_audit_write()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $$
DECLARE
  v_old    jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  v_new    jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  v_fields text[];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(k ORDER BY k) INTO v_fields
      FROM jsonb_object_keys(v_new) k
     WHERE k <> 'updated_at' AND v_new->k IS DISTINCT FROM v_old->k;
    IF v_fields IS NULL THEN RETURN NULL; END IF;  -- nothing but updated_at changed
  END IF;

  INSERT INTO public.agent_vetting_settings_audit
    (operation, changed_by, db_role, session_role, application_name, client_addr, jwt_role,
     changed_fields, old_row, new_row)
  VALUES
    (TG_OP, auth.uid(), current_user, session_user, nullif(current_setting('application_name', true), ''),
     inet_client_addr(), nullif(current_setting('request.jwt.claim.role', true), ''),
     v_fields, v_old, v_new);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.agent_vetting_settings_audit_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_agent_vetting_settings_audit ON public.agent_vetting_settings;
CREATE TRIGGER trg_agent_vetting_settings_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.agent_vetting_settings
  FOR EACH ROW EXECUTE FUNCTION public.agent_vetting_settings_audit_write();

-- The two known changes from before the audit existed, so the trail starts complete.
INSERT INTO public.agent_vetting_settings_audit
  (changed_at, operation, db_role, session_role, application_name, changed_fields, new_row)
SELECT t.at, 'UPDATE', 'unknown', 'unknown', t.note, ARRAY['enforce'], jsonb_build_object('enforce', t.enforce)
FROM (VALUES
  ('2026-10-27 11:25:00+00'::timestamptz, true,
   'backfill: set on between ~11:20 and 11:32 UTC by an unknown session (no audit existed)'),
  ('2026-10-27 11:35:21+00'::timestamptz, false,
   'backfill: turned off by Claude Code (supabase CLI) at Pius''s request')
) AS t(at, enforce, note)
WHERE NOT EXISTS (SELECT 1 FROM public.agent_vetting_settings_audit);
