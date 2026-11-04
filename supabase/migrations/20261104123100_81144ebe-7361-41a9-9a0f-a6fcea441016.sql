CREATE TABLE public.wh_tenant_draft_cleanup_log (
  id bigserial PRIMARY KEY,
  run_at timestamptz NOT NULL DEFAULT now(),
  run_date date NOT NULL DEFAULT (now() AT TIME ZONE 'Africa/Kampala')::date,
  drafts_deleted integer NOT NULL DEFAULT 0,
  photos_deleted integer NOT NULL DEFAULT 0,
  photos_failed integer NOT NULL DEFAULT 0,
  reminders_sent integer NOT NULL DEFAULT 0
);
GRANT SELECT ON public.wh_tenant_draft_cleanup_log TO authenticated;
GRANT ALL ON public.wh_tenant_draft_cleanup_log TO service_role;
GRANT USAGE ON SEQUENCE public.wh_tenant_draft_cleanup_log_id_seq TO service_role;
ALTER TABLE public.wh_tenant_draft_cleanup_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY wh_draft_cleanup_log_ops_read ON public.wh_tenant_draft_cleanup_log FOR SELECT TO authenticated
  USING ((select public.has_role((select auth.uid()), 'agent_ops'::app_role))
      OR (select public.has_role((select auth.uid()), 'coo'::app_role))
      OR (select public.has_role((select auth.uid()), 'manager'::app_role))
      OR (select public.has_role((select auth.uid()), 'super_admin'::app_role)));
CREATE POLICY mfa_required_for_staff ON public.wh_tenant_draft_cleanup_log AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));

-- Daily cleanup: one reminder 7 days before deletion, then delete drafts untouched for 30 days.
-- Returns draft photo paths safe to remove (never a photo an enrolled tenant's ID uses).
CREATE OR REPLACE FUNCTION public.wh_tenant_drafts_cleanup()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_reminders int := 0; v_deleted int := 0; v_paths text[]; v_log bigint;
BEGIN
  INSERT INTO public.notifications (user_id, title, message, type, event_key, metadata, link_path)
  SELECT d.agent_id, 'Welile Homes: draft will be deleted soon',
    'A tenant draft for ' || coalesce(nullif(d.landlord_name,''), 'a landlord') || '''s portfolio will be deleted in '
      || greatest(1, 30 - floor(extract(epoch FROM now() - d.updated_at) / 86400)::int)
      || ' days. Open or save it to keep it.',
    'float', 'wh_draft_expiry:' || d.id || ':' || d.updated_at::text,
    jsonb_build_object('kind','wh_draft_expiry','draft_id', d.id), NULL
  FROM public.wh_tenant_drafts d
  WHERE d.updated_at < now() - interval '23 days' AND d.updated_at >= now() - interval '30 days'
    AND NOT EXISTS (SELECT 1 FROM public.notifications n
      WHERE n.event_key = 'wh_draft_expiry:' || d.id || ':' || d.updated_at::text);
  GET DIAGNOSTICS v_reminders = ROW_COUNT;

  WITH del AS (
    DELETE FROM public.wh_tenant_drafts WHERE updated_at < now() - interval '30 days'
    RETURNING photo_path)
  SELECT count(*)::int,
    coalesce(array_agg(photo_path) FILTER (WHERE coalesce(photo_path,'') <> ''
      AND NOT EXISTS (SELECT 1 FROM public.wh_tenant_identity i WHERE i.photo_path = del.photo_path)
      AND NOT EXISTS (SELECT 1 FROM public.wh_tenant_drafts o WHERE o.photo_path = del.photo_path)), '{}')
  INTO v_deleted, v_paths FROM del;

  INSERT INTO public.wh_tenant_draft_cleanup_log (drafts_deleted, reminders_sent)
  VALUES (v_deleted, v_reminders) RETURNING id INTO v_log;
  RETURN jsonb_build_object('log_id', v_log, 'drafts_deleted', v_deleted, 'reminders_sent', v_reminders, 'photo_paths', to_jsonb(v_paths));
END $$;
REVOKE ALL ON FUNCTION public.wh_tenant_drafts_cleanup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wh_tenant_drafts_cleanup() TO service_role;

-- Reset the 30 days when the agent opens a draft (owner only).
CREATE OR REPLACE FUNCTION public.wh_touch_tenant_draft(p_draft_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.wh_tenant_drafts SET updated_at = now()
  WHERE id = p_draft_id AND agent_id = (select auth.uid())
$$;
REVOKE ALL ON FUNCTION public.wh_touch_tenant_draft(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_touch_tenant_draft(uuid) TO authenticated;