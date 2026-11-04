CREATE TABLE public.wh_nin_check_log (
  id bigserial PRIMARY KEY,
  agent_id uuid NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('check','enrol')),
  result text NOT NULL CHECK (result IN ('in_use','not_in_use','blocked'))
);
CREATE INDEX wh_nin_check_log_agent_time_idx ON public.wh_nin_check_log (agent_id, checked_at DESC);
GRANT SELECT ON public.wh_nin_check_log TO authenticated;
GRANT ALL ON public.wh_nin_check_log TO service_role;
ALTER TABLE public.wh_nin_check_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY wh_nin_check_log_ops_read ON public.wh_nin_check_log FOR SELECT TO authenticated
  USING ((select public.has_role((select auth.uid()), 'agent_ops'::app_role))
      OR (select public.has_role((select auth.uid()), 'coo'::app_role))
      OR (select public.has_role((select auth.uid()), 'manager'::app_role))
      OR (select public.has_role((select auth.uid()), 'super_admin'::app_role)));
CREATE POLICY mfa_required_for_staff ON public.wh_nin_check_log AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));

-- Checks counted toward the hourly limit (blocked attempts are logged but not counted)
CREATE OR REPLACE FUNCTION public._wh_nin_checks_last_hour(p_agent uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*)::int FROM public.wh_nin_check_log
  WHERE agent_id = p_agent AND result <> 'blocked' AND checked_at > now() - interval '1 hour'
$$;
REVOKE ALL ON FUNCTION public._wh_nin_checks_last_hour(uuid) FROM PUBLIC, anon, authenticated;

-- Rate-limited yes/no check; never reveals whose NIN it is.
CREATE OR REPLACE FUNCTION public.wh_nin_check(p_nin text, p_tenant_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_used boolean; v_oldest timestamptz;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated' USING errcode='42501'; END IF;
  IF public._wh_nin_checks_last_hour(v_uid) >= 30 THEN
    INSERT INTO public.wh_nin_check_log (agent_id, source, result) VALUES (v_uid, 'check', 'blocked');
    SELECT min(checked_at) INTO v_oldest FROM public.wh_nin_check_log
      WHERE agent_id = v_uid AND result <> 'blocked' AND checked_at > now() - interval '1 hour';
    RETURN jsonb_build_object('limited', true, 'in_use', null, 'retry_at', v_oldest + interval '1 hour');
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.wh_tenant_identity
    WHERE nin = upper(regexp_replace(coalesce(p_nin,''), '\s', '', 'g'))
      AND (p_tenant_id IS NULL OR tenant_id <> p_tenant_id)) INTO v_used;
  INSERT INTO public.wh_nin_check_log (agent_id, source, result)
  VALUES (v_uid, 'check', CASE WHEN v_used THEN 'in_use' ELSE 'not_in_use' END);
  RETURN jsonb_build_object('limited', false, 'in_use', v_used);
END $$;
REVOKE ALL ON FUNCTION public.wh_nin_check(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_nin_check(text, uuid) TO authenticated;

-- Close the old unlimited check so it cannot be used to bypass the limit.
REVOKE EXECUTE ON FUNCTION public.wh_nin_in_use(text, uuid) FROM PUBLIC, anon, authenticated;

-- Agent Ops review: agents by number of NIN checks in a window.
CREATE OR REPLACE FUNCTION public.wh_nin_check_activity(p_hours integer DEFAULT 24)
RETURNS TABLE(agent_id uuid, agent_name text, agent_phone text, checks bigint, in_use bigint, blocked bigint, enrol_duplicates bigint, last_check timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT ((select public.has_role(auth.uid(), 'agent_ops'::app_role)) OR (select public.has_role(auth.uid(), 'coo'::app_role))
       OR (select public.has_role(auth.uid(), 'manager'::app_role)) OR (select public.has_role(auth.uid(), 'super_admin'::app_role))) THEN
    RAISE EXCEPTION 'not allowed' USING errcode='42501';
  END IF;
  RETURN QUERY
  SELECT l.agent_id, p.full_name::text, p.phone::text,
    count(*) FILTER (WHERE l.result <> 'blocked'),
    count(*) FILTER (WHERE l.result = 'in_use'),
    count(*) FILTER (WHERE l.result = 'blocked'),
    count(*) FILTER (WHERE l.source = 'enrol' AND l.result = 'in_use'),
    max(l.checked_at)
  FROM public.wh_nin_check_log l LEFT JOIN public.profiles p ON p.id = l.agent_id
  WHERE l.checked_at > now() - make_interval(hours => greatest(1, least(coalesce(p_hours,24), 720)))
  GROUP BY l.agent_id, p.full_name, p.phone
  ORDER BY 4 DESC, 8 DESC
  LIMIT 200;
END $$;
REVOKE ALL ON FUNCTION public.wh_nin_check_activity(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_nin_check_activity(integer) TO authenticated;

-- Enrolment: same hourly limit; a duplicate-NIN refusal is logged and counted.
CREATE OR REPLACE FUNCTION public.wh_enroll_tenant_with_identity(p_tenant_id uuid, p_agent_id uuid, p_monthly_rent numeric, p_payout_day integer, p_has_smartphone boolean, p_landlord_uses_wallet boolean, p_landlord_id uuid, p_landlord_name text, p_landlord_phone text, p_notes text, p_nin text, p_photo_path text, p_draft_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_nin text := upper(regexp_replace(coalesce(p_nin,''), '\s', '', 'g'));
  v_cur public.wh_tenant_identity%rowtype;
  v_other uuid; v_res jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated' USING errcode='42501'; END IF;
  IF p_tenant_id IS NULL THEN RAISE EXCEPTION 'Tenant is required' USING errcode='22023'; END IF;
  SELECT * INTO v_cur FROM public.wh_tenant_identity WHERE tenant_id = p_tenant_id;

  IF v_nin = '' AND coalesce(p_photo_path,'') = '' THEN
    IF v_cur.tenant_id IS NULL OR v_cur.nin !~ '^C[MF][A-Z0-9]{12}$' OR coalesce(v_cur.photo_path,'') = '' THEN
      RAISE EXCEPTION 'Enter the tenant NIN and passport photo before enrolling' USING errcode='22023';
    END IF;
  ELSE
    IF v_nin !~ '^C[MF][A-Z0-9]{12}$' THEN
      RAISE EXCEPTION 'NIN must be 14 characters and start with CM or CF' USING errcode='22023'; END IF;
    IF coalesce(p_photo_path,'') = '' OR split_part(p_photo_path,'/',1) <> v_uid::text
       OR split_part(p_photo_path,'/',2) NOT IN ('drafts', p_tenant_id::text) THEN
      RAISE EXCEPTION 'Upload the tenant passport photo' USING errcode='22023'; END IF;
    IF public._wh_nin_checks_last_hour(v_uid) >= 30 THEN
      RETURN jsonb_build_object('success', false, 'code', 'nin_rate_limited',
        'error', 'Too many ID checks – try again later');
    END IF;
    SELECT tenant_id INTO v_other FROM public.wh_tenant_identity WHERE nin = v_nin AND tenant_id <> p_tenant_id;
    IF v_other IS NOT NULL THEN
      INSERT INTO public.wh_nin_check_log (agent_id, source, result) VALUES (v_uid, 'enrol', 'in_use');
      RETURN jsonb_build_object('success', false, 'code', 'nin_in_use',
        'error', 'This NIN is already recorded for another tenant');
    END IF;
    INSERT INTO public.wh_tenant_identity (tenant_id, nin, photo_path, recorded_by)
    VALUES (p_tenant_id, v_nin, p_photo_path, v_uid)
    ON CONFLICT (tenant_id) DO UPDATE SET nin = excluded.nin, photo_path = excluded.photo_path,
      recorded_by = excluded.recorded_by, updated_at = now();
  END IF;

  v_res := public.enroll_welile_home_tenant(p_tenant_id, p_agent_id, p_monthly_rent, p_payout_day,
    p_has_smartphone, p_landlord_uses_wallet, p_landlord_id, p_landlord_name, p_landlord_phone, p_notes);
  IF coalesce((v_res->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION '%', coalesce(v_res->>'error', 'Enrollment failed') USING errcode='22023';
  END IF;
  IF p_draft_id IS NOT NULL THEN
    DELETE FROM public.wh_tenant_drafts WHERE id = p_draft_id AND agent_id = v_uid;
  END IF;
  RETURN v_res;
END $function$;