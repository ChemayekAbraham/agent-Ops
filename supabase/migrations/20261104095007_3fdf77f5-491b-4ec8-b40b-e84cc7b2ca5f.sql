CREATE TABLE public.wh_tenant_identity (
  tenant_id uuid PRIMARY KEY,
  nin text NOT NULL,
  photo_path text NOT NULL,
  recorded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wh_tenant_identity_nin_fmt CHECK (nin ~ '^C[MF][A-Z0-9]{12}$')
);
CREATE UNIQUE INDEX wh_tenant_identity_nin_uq ON public.wh_tenant_identity (nin);
GRANT SELECT ON public.wh_tenant_identity TO authenticated;
GRANT ALL ON public.wh_tenant_identity TO service_role;
ALTER TABLE public.wh_tenant_identity ENABLE ROW LEVEL SECURITY;
CREATE POLICY mfa_required_for_staff ON public.wh_tenant_identity AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));

CREATE OR REPLACE FUNCTION public._wh_tenant_id_staff_ok() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public._has_enabled_role(auth.uid(), ARRAY['agent_ops','coo','cfo','super_admin']) $$;
GRANT EXECUTE ON FUNCTION public._wh_tenant_id_staff_ok() TO authenticated;

CREATE OR REPLACE FUNCTION public._wh_is_tenant_agent(p_uid uuid, p_tenant uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.welile_homes_subscriptions s WHERE s.tenant_id = p_tenant AND s.agent_id = p_uid) $$;

CREATE POLICY wh_tenant_identity_read ON public.wh_tenant_identity FOR SELECT TO authenticated
  USING ((select public._wh_tenant_id_staff_ok()) OR public._wh_is_tenant_agent((select auth.uid()), tenant_id));

CREATE OR REPLACE FUNCTION public.wh_set_tenant_identity(p_tenant_id uuid, p_nin text, p_photo_path text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_nin text := upper(regexp_replace(coalesce(p_nin,''), '\s', '', 'g')); v_other uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated' USING errcode='42501'; END IF;
  IF NOT public._wh_is_tenant_agent(v_uid, p_tenant_id) THEN
    RAISE EXCEPTION 'Only the agent who registered this tenant can record their ID' USING errcode='42501'; END IF;
  IF v_nin !~ '^C[MF][A-Z0-9]{12}$' THEN
    RAISE EXCEPTION 'NIN must be 14 characters and start with CM or CF' USING errcode='22023'; END IF;
  IF coalesce(p_photo_path,'') = '' OR split_part(p_photo_path,'/',1) <> v_uid::text OR split_part(p_photo_path,'/',2) <> p_tenant_id::text THEN
    RAISE EXCEPTION 'Upload the tenant passport photo' USING errcode='22023'; END IF;
  SELECT tenant_id INTO v_other FROM public.wh_tenant_identity WHERE nin = v_nin AND tenant_id <> p_tenant_id;
  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'This NIN is already recorded for another tenant' USING errcode='23505'; END IF;
  INSERT INTO public.wh_tenant_identity (tenant_id, nin, photo_path, recorded_by)
  VALUES (p_tenant_id, v_nin, p_photo_path, v_uid)
  ON CONFLICT (tenant_id) DO UPDATE SET nin = excluded.nin, photo_path = excluded.photo_path,
    recorded_by = excluded.recorded_by, updated_at = now();
  INSERT INTO public.system_events (event_type, user_id, metadata)
  SELECT 'tenant_created'::system_event_type, p_tenant_id, jsonb_build_object('kind','wh_tenant_id_recorded','agent_id',v_uid)
  WHERE EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='system_events' AND column_name='metadata') AND false;
  RETURN jsonb_build_object('success', true, 'nin', v_nin);
END $$;
REVOKE ALL ON FUNCTION public.wh_set_tenant_identity(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_set_tenant_identity(uuid, text, text) TO authenticated;

-- ID details for the tenants in one float request (Agent Ops / COO / CFO review).
CREATE OR REPLACE FUNCTION public.wh_float_request_tenant_ids(p_request_id uuid)
RETURNS TABLE (subscription_id uuid, tenant_id uuid, tenant_name text, nin text, photo_path text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public._wh_tenant_id_staff_ok() THEN RAISE EXCEPTION 'not allowed' USING errcode='42501'; END IF;
  RETURN QUERY SELECT i.subscription_id, s.tenant_id, p.full_name, t.nin, t.photo_path
    FROM public.welile_homes_float_request_items i
    JOIN public.welile_homes_subscriptions s ON s.id = i.subscription_id
    LEFT JOIN public.profiles p ON p.id = s.tenant_id
    LEFT JOIN public.wh_tenant_identity t ON t.tenant_id = s.tenant_id
   WHERE i.float_request_id = p_request_id
   ORDER BY p.full_name;
END $$;
REVOKE ALL ON FUNCTION public.wh_float_request_tenant_ids(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_float_request_tenant_ids(uuid) TO authenticated;

CREATE POLICY "wh tenant id photo upload by agent" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id='wh-tenant-id-photos' AND (storage.foldername(name))[1] = (select auth.uid())::text
    AND public._wh_is_tenant_agent((select auth.uid()), ((storage.foldername(name))[2])::uuid));
CREATE POLICY "wh tenant id photo read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id='wh-tenant-id-photos' AND ((storage.foldername(name))[1] = (select auth.uid())::text OR (select public._wh_tenant_id_staff_ok())));

CREATE OR REPLACE FUNCTION public.wh_request_float(p_subscription_ids uuid[], p_recipient_phone text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_ids uuid[];
  v_found int;
  v_total numeric;
  v_bad int;
  v_req uuid;
  v_key record;
  v_cur uuid[];
  v_ver uuid[];
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  select array_agg(distinct x) into v_ids from unnest(p_subscription_ids) x where x is not null;
  if v_ids is null or cardinality(v_ids) = 0 then
    raise exception 'Select at least one tenant' using errcode = '22023';
  end if;
  if cardinality(v_ids) > 200 then
    raise exception 'At most 200 tenants per request' using errcode = '22023';
  end if;

  perform 1 from public.welile_homes_subscriptions s where s.id = any(v_ids) for update;

  select count(*) into v_found from public.welile_homes_subscriptions s
   where s.id = any(v_ids) and s.agent_id = v_uid and s.subscription_status = 'active'
     and s.mode = 'agent_collection' and s.funding_status = 'unfunded';
  if v_found <> cardinality(v_ids) then
    raise exception 'Some tenants are not yours, not active, or already have a float request' using errcode = '42501';
  end if;

  -- Tenant ID: every tenant needs a NIN and passport photo (no tenant OTP).
  if exists (select 1 from public.welile_homes_subscriptions s where s.id = any(v_ids)
              and not exists (select 1 from public.wh_tenant_identity t where t.tenant_id = s.tenant_id)) then
    raise exception 'Every tenant needs a NIN and passport photo before requesting float' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.welile_homes_subscriptions s
     where s.id = any(v_ids)
       and ((s.landlord_id is not null and not exists (
               select 1 from public.landlords l where l.id = s.landlord_id and l.registered_by = v_uid))
         or (s.landlord_id is null and nullif(trim(s.landlord_phone), '') is not null
             and exists (select 1 from public.landlords l where l.phone = trim(s.landlord_phone) and l.registered_by is distinct from v_uid)
             and not exists (select 1 from public.landlords l where l.phone = trim(s.landlord_phone) and l.registered_by = v_uid)))
  ) then
    raise exception 'Float can only be requested for landlords you registered' using errcode = '42501';
  end if;

  if exists (select 1 from public.welile_homes_subscriptions s where s.id = any(v_ids) and public._wh_phone_key(s.landlord_phone) is null) then
    raise exception 'Add the landlord phone number before requesting float' using errcode = '22023';
  end if;
  for v_key in select distinct public._wh_phone_key(s.landlord_phone) k from public.welile_homes_subscriptions s where s.id = any(v_ids) loop
    if not public._wh_owns_landlord_key(v_uid, v_key.k) then
      raise exception 'Float can only be requested for landlords you registered' using errcode = '42501';
    end if;
    v_cur := public._wh_portfolio_subs(v_uid, v_key.k);
    select v.subscription_ids into v_ver from public.wh_landlord_portfolio_verifications v
     where v.agent_id = v_uid and v.landlord_phone_key = v_key.k order by v.verified_at desc limit 1;
    if v_ver is null or v_ver is distinct from v_cur then
      raise exception 'Verify the landlord by SMS code for the current tenant list before requesting float' using errcode = '42501';
    end if;
    if exists (select 1 from unnest(v_cur) c where not (c = any(v_ids))) then
      raise exception 'Include every tenant in the verified landlord portfolio' using errcode = '22023';
    end if;
  end loop;

  select count(*) filter (where amt is null or amt <= 0), coalesce(sum(amt) filter (where amt > 0), 0)
    into v_bad, v_total
    from (select s.id, (select d.amount_due - coalesce(d.amount_collected, 0)
                          from public.welile_homes_monthly_dues d
                         where d.subscription_id = s.id and d.collection_status <> 'collected'
                         order by d.due_month_index limit 1) amt
            from public.welile_homes_subscriptions s where s.id = any(v_ids)) x;
  if v_bad > 0 or v_total <= 0 then
    raise exception 'Some tenants have no unpaid monthly due to fund' using errcode = '22023';
  end if;

  perform set_config('welile.wh_float_rpc', 'on', true);

  insert into public.float_requests (agent_id, requested_amount, reason, expected_recipient_phone, status, product)
  values (v_uid, v_total,
    format('Welile Homes landlord float (%s tenants)', cardinality(v_ids)) || coalesce(': ' || nullif(trim(p_notes), ''), ''),
    nullif(trim(p_recipient_phone), ''), 'pending', 'welile_homes')
  returning id into v_req;

  insert into public.welile_homes_float_request_items (float_request_id, subscription_id, amount)
  select v_req, s.id, (select d.amount_due - coalesce(d.amount_collected, 0)
                         from public.welile_homes_monthly_dues d
                        where d.subscription_id = s.id and d.collection_status <> 'collected'
                        order by d.due_month_index limit 1)
    from public.welile_homes_subscriptions s where s.id = any(v_ids);

  update public.welile_homes_subscriptions set funding_status = 'requested', updated_at = now() where id = any(v_ids);

  return jsonb_build_object('success', true, 'request_id', v_req, 'amount', v_total, 'tenant_count', cardinality(v_ids));
end $function$;