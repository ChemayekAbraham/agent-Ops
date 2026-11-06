CREATE TABLE public.wh_tenant_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  landlord_id uuid,
  landlord_name text,
  landlord_phone text,
  landlord_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  form jsonb NOT NULL DEFAULT '{}'::jsonb,
  photo_path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wh_tenant_drafts_agent_idx ON public.wh_tenant_drafts(agent_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wh_tenant_drafts TO authenticated;
GRANT ALL ON public.wh_tenant_drafts TO service_role;
ALTER TABLE public.wh_tenant_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY wh_tenant_drafts_owner ON public.wh_tenant_drafts FOR ALL TO authenticated
  USING (agent_id = (select auth.uid())) WITH CHECK (agent_id = (select auth.uid()));
CREATE POLICY mfa_required_for_staff ON public.wh_tenant_drafts AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));
CREATE OR REPLACE FUNCTION public.wh_tenant_drafts_touch() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER wh_tenant_drafts_touch BEFORE UPDATE ON public.wh_tenant_drafts FOR EACH ROW EXECUTE FUNCTION public.wh_tenant_drafts_touch();

CREATE POLICY "wh tenant id draft photo upload by agent" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'wh-tenant-id-photos'
    AND (storage.foldername(name))[1] = (select auth.uid())::text
    AND (storage.foldername(name))[2] = 'drafts');

CREATE OR REPLACE FUNCTION public.wh_enroll_tenant_with_identity(
  p_tenant_id uuid, p_agent_id uuid, p_monthly_rent numeric, p_payout_day integer,
  p_has_smartphone boolean, p_landlord_uses_wallet boolean, p_landlord_id uuid,
  p_landlord_name text, p_landlord_phone text, p_notes text,
  p_nin text, p_photo_path text, p_draft_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
    -- Existing tenant with a complete ID already on file
    IF v_cur.tenant_id IS NULL OR v_cur.nin !~ '^C[MF][A-Z0-9]{12}$' OR coalesce(v_cur.photo_path,'') = '' THEN
      RAISE EXCEPTION 'Enter the tenant NIN and passport photo before enrolling' USING errcode='22023';
    END IF;
  ELSE
    IF v_nin !~ '^C[MF][A-Z0-9]{12}$' THEN
      RAISE EXCEPTION 'NIN must be 14 characters and start with CM or CF' USING errcode='22023'; END IF;
    IF coalesce(p_photo_path,'') = '' OR split_part(p_photo_path,'/',1) <> v_uid::text
       OR split_part(p_photo_path,'/',2) NOT IN ('drafts', p_tenant_id::text) THEN
      RAISE EXCEPTION 'Upload the tenant passport photo' USING errcode='22023'; END IF;
    SELECT tenant_id INTO v_other FROM public.wh_tenant_identity WHERE nin = v_nin AND tenant_id <> p_tenant_id;
    IF v_other IS NOT NULL THEN
      RAISE EXCEPTION 'This NIN is already recorded for another tenant' USING errcode='23505'; END IF;
    INSERT INTO public.wh_tenant_identity (tenant_id, nin, photo_path, recorded_by)
    VALUES (p_tenant_id, v_nin, p_photo_path, v_uid)
    ON CONFLICT (tenant_id) DO UPDATE SET nin = excluded.nin, photo_path = excluded.photo_path,
      recorded_by = excluded.recorded_by, updated_at = now();
  END IF;

  -- All existing agent/landlord/ownership checks run inside; any refusal rolls back the ID too.
  v_res := public.enroll_welile_home_tenant(p_tenant_id, p_agent_id, p_monthly_rent, p_payout_day,
    p_has_smartphone, p_landlord_uses_wallet, p_landlord_id, p_landlord_name, p_landlord_phone, p_notes);
  IF coalesce((v_res->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION '%', coalesce(v_res->>'error', 'Enrollment failed') USING errcode='22023';
  END IF;
  IF p_draft_id IS NOT NULL THEN
    DELETE FROM public.wh_tenant_drafts WHERE id = p_draft_id AND agent_id = v_uid;
  END IF;
  RETURN v_res;
END $$;
REVOKE ALL ON FUNCTION public.wh_enroll_tenant_with_identity(uuid,uuid,numeric,integer,boolean,boolean,uuid,text,text,text,text,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_enroll_tenant_with_identity(uuid,uuid,numeric,integer,boolean,boolean,uuid,text,text,text,text,text,uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.enroll_welile_home_tenant(uuid,uuid,numeric,integer,boolean,boolean,uuid,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enroll_welile_home_tenant(uuid,uuid,numeric,integer,boolean,boolean,uuid,text,text,text) TO service_role;