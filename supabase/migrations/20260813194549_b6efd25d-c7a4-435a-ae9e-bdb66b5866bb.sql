-- 1. Extend proxy_agent_identity with applicant details + approval workflow
ALTER TABLE public.proxy_agent_identity
  ADD COLUMN IF NOT EXISTS full_name text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS invite_code text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_notes text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'proxy_agent_identity_status_check'
  ) THEN
    ALTER TABLE public.proxy_agent_identity
      ADD CONSTRAINT proxy_agent_identity_status_check
      CHECK (status IN ('pending','approved','rejected','suspended'));
  END IF;
END $$;

-- Grandfather every existing proxy agent so no live user loses access
UPDATE public.proxy_agent_identity
   SET status = 'approved',
       reviewed_at = COALESCE(reviewed_at, captured_at)
 WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_proxy_agent_identity_status
  ON public.proxy_agent_identity (status, submitted_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.proxy_agent_identity TO authenticated;
GRANT ALL ON public.proxy_agent_identity TO service_role;

DROP POLICY IF EXISTS pai_select ON public.proxy_agent_identity;
CREATE POLICY pai_select ON public.proxy_agent_identity
FOR SELECT TO authenticated
USING (
  agent_user_id = (SELECT auth.uid())
  OR public.has_role((SELECT auth.uid()), 'super_admin'::app_role)
  OR public.has_role((SELECT auth.uid()), 'coo'::app_role)
  OR public.has_role((SELECT auth.uid()), 'manager'::app_role)
  OR public.has_role((SELECT auth.uid()), 'partner_ops'::app_role)
);

-- 2. Database-level access identifier for the proxy route
CREATE OR REPLACE FUNCTION public.is_approved_proxy_agent(p_user_id uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.proxy_agent_identity
     WHERE agent_user_id = p_user_id
       AND status = 'approved'
  )
$$;

CREATE OR REPLACE FUNCTION public.my_proxy_agent_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v record;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('status','none');
  END IF;

  SELECT * INTO v FROM public.proxy_agent_identity
   WHERE agent_user_id = auth.uid();

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','none');
  END IF;

  RETURN jsonb_build_object(
    'status', v.status,
    'full_name', v.full_name,
    'phone', v.phone,
    'submitted_at', v.submitted_at,
    'reviewed_at', v.reviewed_at,
    'review_notes', v.review_notes
  );
END;
$$;

-- 3. Acceptance now captures name + phone and files a pending application
CREATE OR REPLACE FUNCTION public.accept_proxy_agreement(
  p_code text,
  p_nin text DEFAULT NULL::text,
  p_full_name text DEFAULT NULL::text,
  p_phone text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare v_ver record; v_inv record; v_lead uuid; v_ident record;
begin
  if auth.uid() is null then
    return jsonb_build_object('status','error','message','Not signed in');
  end if;

  select * into v_ident from public.proxy_agent_identity where agent_user_id = auth.uid();

  if not found then
    if p_nin is null or length(btrim(p_nin)) < 8 then
      return jsonb_build_object('status','error','message','National ID number is required');
    end if;
    if p_full_name is null or length(btrim(p_full_name)) < 3 then
      return jsonb_build_object('status','error','message','Your full name is required');
    end if;
    if p_phone is null or length(regexp_replace(coalesce(p_phone,''),'\D','','g')) < 9 then
      return jsonb_build_object('status','error','message','A valid phone number is required');
    end if;

    insert into public.proxy_agent_identity
      (agent_user_id, nin, full_name, phone, invite_code, status, submitted_at)
    values (auth.uid(), btrim(p_nin), btrim(p_full_name), btrim(p_phone),
            nullif(btrim(coalesce(p_code,'')),''), 'pending', now())
    on conflict (agent_user_id) do nothing;

    select * into v_ident from public.proxy_agent_identity where agent_user_id = auth.uid();
  else
    -- keep contact details fresh on re-acceptance, never change the review status here
    update public.proxy_agent_identity
       set full_name = coalesce(nullif(btrim(coalesce(p_full_name,'')),''), full_name),
           phone     = coalesce(nullif(btrim(coalesce(p_phone,'')),''), phone),
           invite_code = coalesce(invite_code, nullif(btrim(coalesce(p_code,'')),''))
     where agent_user_id = auth.uid()
     returning * into v_ident;
  end if;

  select * into v_ver from public.proxy_agreement_versions
   where retired_at is null and effective_from <= now()
   order by effective_from desc limit 1;
  if not found then
    return jsonb_build_object('status','error','message','No agreement version published');
  end if;

  if p_code is not null and btrim(p_code) <> '' then
    select * into v_inv from public.partner_lead_invites
     where upper(code) = upper(btrim(p_code)) for update;
    if found and v_inv.revoked_at is null
       and (v_inv.expires_at is null or v_inv.expires_at > now())
       and (v_inv.max_uses is null or v_inv.uses_count < v_inv.max_uses)
       and v_inv.lead_user_id <> auth.uid() then
      v_lead := v_inv.lead_user_id;
      if not exists (select 1 from public.partner_lead_assignments
                      where agent_id = auth.uid() and detached_at is null) then
        insert into public.partner_lead_assignments
          (lead_user_id, agent_id, attached_by, reason)
        values (v_lead, auth.uid(), v_lead,
                'Attached via proxy invite ' || v_inv.code || ' with agreement accepted');
        update public.partner_lead_invites
           set uses_count = uses_count + 1 where id = v_inv.id;
      else
        select lead_user_id into v_lead from public.partner_lead_assignments
         where agent_id = auth.uid() and detached_at is null limit 1;
      end if;
    end if;
  end if;

  if v_lead is null then
    select lead_user_id into v_lead from public.partner_lead_assignments
     where agent_id = auth.uid() and detached_at is null limit 1;
  end if;

  insert into public.proxy_agreement_consents
    (agent_user_id, version_id, lead_user_id, invite_code, body_checksum)
  values (auth.uid(), v_ver.id, v_lead, nullif(btrim(p_code),''), md5(v_ver.body_md))
  on conflict (agent_user_id, version_id, period_month) do nothing;

  return jsonb_build_object(
    'status','accepted',
    'lead_attached', v_lead is not null,
    'approval_status', coalesce(v_ident.status,'pending')
  );
end;
$function$;

-- 4. Partner Ops review tools
CREATE OR REPLACE FUNCTION public.partner_ops_list_proxy_agent_applications(
  p_status text DEFAULT 'pending'
)
RETURNS TABLE(
  agent_user_id uuid,
  full_name text,
  phone text,
  nin text,
  invite_code text,
  status text,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  review_notes text,
  reviewer_name text,
  lead_name text,
  profile_name text,
  profile_phone text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'partner_ops'::app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  SELECT i.agent_user_id, i.full_name, i.phone, i.nin, i.invite_code, i.status,
         i.submitted_at, i.reviewed_at, i.review_notes,
         rp.full_name AS reviewer_name,
         lp.full_name AS lead_name,
         p.full_name  AS profile_name,
         p.phone      AS profile_phone
    FROM public.proxy_agent_identity i
    LEFT JOIN public.profiles p  ON p.id  = i.agent_user_id
    LEFT JOIN public.profiles rp ON rp.id = i.reviewed_by
    LEFT JOIN public.partner_lead_assignments a
           ON a.agent_id = i.agent_user_id AND a.detached_at IS NULL
    LEFT JOIN public.profiles lp ON lp.id = a.lead_user_id
   WHERE p_status = 'all' OR i.status = p_status
   ORDER BY i.submitted_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.partner_ops_decide_proxy_agent(
  p_agent_user_id uuid,
  p_decision text,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row record;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'partner_ops'::app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF p_decision NOT IN ('approved','rejected','suspended') THEN
    RAISE EXCEPTION 'Invalid decision';
  END IF;

  IF p_decision <> 'approved' AND length(btrim(coalesce(p_notes,''))) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  UPDATE public.proxy_agent_identity
     SET status = p_decision,
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         review_notes = nullif(btrim(coalesce(p_notes,'')),'')
   WHERE agent_user_id = p_agent_user_id
   RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proxy agent application not found';
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  VALUES (auth.uid(), 'proxy_agent_' || p_decision, 'proxy_agent_identity',
          p_agent_user_id::text,
          coalesce(nullif(btrim(coalesce(p_notes,'')),''), 'Proxy agent application approved'),
          jsonb_build_object('status', p_decision));

  RETURN jsonb_build_object('status', p_decision, 'agent_user_id', p_agent_user_id);
END;
$$;

REVOKE ALL ON FUNCTION public.partner_ops_decide_proxy_agent(uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.partner_ops_list_proxy_agent_applications(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.partner_ops_decide_proxy_agent(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.partner_ops_list_proxy_agent_applications(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_approved_proxy_agent(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_proxy_agent_status() TO authenticated;