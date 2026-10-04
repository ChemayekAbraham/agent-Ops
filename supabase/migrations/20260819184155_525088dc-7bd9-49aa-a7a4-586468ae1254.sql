-- 1. Stage added to the pipeline
ALTER TABLE public.rent_requests DROP CONSTRAINT IF EXISTS rent_requests_status_check;
ALTER TABLE public.rent_requests ADD CONSTRAINT rent_requests_status_check
CHECK (status = ANY (ARRAY[
  'pending','service_center_review','approved','rejected','cancelled','deleted_by_agent',
  'agent_ops_approved','tenant_ops_approved','agent_verified','landlord_ops_approved',
  'partner_ops_approved','coo_approved','funded','disbursed','repaying','fully_repaid',
  'defaulted','completed'
]::text[]));

-- 2. Partner Ops review columns
ALTER TABLE public.rent_requests
  ADD COLUMN IF NOT EXISTS proxy_agent_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS partner_ops_reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS partner_ops_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS partner_ops_comment text;

CREATE INDEX IF NOT EXISTS idx_rent_requests_status_partner_ops
  ON public.rent_requests (status, updated_at DESC)
  WHERE status IN ('landlord_ops_approved','partner_ops_approved');
CREATE INDEX IF NOT EXISTS idx_rent_requests_proxy_agent ON public.rent_requests (proxy_agent_id);

-- 3. Hard fence: partner_ops_approved requires a VERIFIED proxy agent
CREATE OR REPLACE FUNCTION public.enforce_partner_ops_proxy_attachment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'partner_ops_approved'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    IF NEW.proxy_agent_id IS NULL THEN
      RAISE EXCEPTION 'A verified proxy agent must be attached before Partner Operations can forward this rent request'
        USING ERRCODE = '42501';
    END IF;
    IF NOT public.is_approved_proxy_agent(NEW.proxy_agent_id) THEN
      RAISE EXCEPTION 'Proxy agent % is not an approved (verified) proxy agent', NEW.proxy_agent_id
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_partner_ops_proxy_attachment ON public.rent_requests;
CREATE TRIGGER trg_enforce_partner_ops_proxy_attachment
  BEFORE INSERT OR UPDATE ON public.rent_requests
  FOR EACH ROW EXECUTE FUNCTION public.enforce_partner_ops_proxy_attachment();

-- 4. Single-round-trip reader: queue rows + media + verified proxy agents
CREATE OR REPLACE FUNCTION public.partner_ops_list_rent_requests(
  p_status text DEFAULT 'landlord_ops_approved',
  p_search text DEFAULT NULL,
  p_limit int DEFAULT 20,
  p_offset int DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lim int := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_off int := GREATEST(COALESCE(p_offset, 0), 0);
  v_status text := COALESCE(NULLIF(p_status, ''), 'landlord_ops_approved');
  v_q text := NULLIF(TRIM(COALESCE(p_search, '')), '');
  v_total int;
  v_rows jsonb;
  v_proxies jsonb;
BEGIN
  IF NOT public.is_partner_ops(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorised for Partner Operations' USING ERRCODE = '42501';
  END IF;

  IF v_status NOT IN ('landlord_ops_approved', 'partner_ops_approved', 'all') THEN
    v_status := 'landlord_ops_approved';
  END IF;

  WITH base AS (
    SELECT r.*,
           tp.full_name AS tenant_name, tp.phone AS tenant_phone,
           ap.full_name AS agent_name,  ap.phone AS agent_phone,
           lp.full_name AS landlord_name, lp.phone AS landlord_phone,
           xp.full_name AS proxy_agent_name, xp.phone AS proxy_agent_phone
      FROM public.rent_requests r
      LEFT JOIN public.profiles tp ON tp.id = r.tenant_id
      LEFT JOIN public.profiles ap ON ap.id = COALESCE(r.assigned_agent_id, r.agent_id)
      LEFT JOIN public.profiles lp ON lp.id = r.landlord_id
      LEFT JOIN public.profiles xp ON xp.id = r.proxy_agent_id
     WHERE (v_status = 'all' OR r.status = v_status)
       AND (v_status = 'all' OR r.status <> 'landlord_ops_approved'
            OR r.registration_type IS NULL
            OR r.registration_type <> 'outstanding_balance')
  ), filtered AS (
    SELECT * FROM base
     WHERE v_q IS NULL
        OR tenant_name ILIKE '%' || v_q || '%'
        OR tenant_phone ILIKE '%' || v_q || '%'
        OR agent_name ILIKE '%' || v_q || '%'
        OR landlord_name ILIKE '%' || v_q || '%'
        OR request_city ILIKE '%' || v_q || '%'
  ), counted AS (
    SELECT COUNT(*)::int AS total FROM filtered
  ), page AS (
    SELECT * FROM filtered
     ORDER BY landlord_ops_reviewed_at DESC NULLS LAST, updated_at DESC NULLS LAST, created_at DESC
     LIMIT v_lim OFFSET v_off
  )
  SELECT (SELECT total FROM counted),
         COALESCE(jsonb_agg(jsonb_build_object(
           'id', id,
           'status', status,
           'created_at', created_at,
           'landlord_ops_reviewed_at', landlord_ops_reviewed_at,
           'rent_amount', rent_amount,
           'duration_days', duration_days,
           'daily_repayment', daily_repayment,
           'total_repayment', total_repayment,
           'house_category', house_category,
           'request_city', request_city,
           'registration_type', registration_type,
           'tenant_id', tenant_id,
           'tenant_name', COALESCE(tenant_name, 'Tenant'),
           'tenant_phone', tenant_phone,
           'agent_id', COALESCE(assigned_agent_id, agent_id),
           'agent_name', agent_name,
           'agent_phone', agent_phone,
           'landlord_name', landlord_name,
           'landlord_phone', landlord_phone,
           'proxy_agent_id', proxy_agent_id,
           'proxy_agent_name', proxy_agent_name,
           'proxy_agent_phone', proxy_agent_phone,
           'partner_ops_comment', partner_ops_comment,
           'partner_ops_reviewed_at', partner_ops_reviewed_at,
           'agent_ops_comment', agent_ops_comment,
           'tenant_ops_comment', tenant_ops_comment,
           'landlord_ops_comment', landlord_ops_comment,
           'tenant_photo_url', tenant_photo_url,
           'house_image_urls', COALESCE(house_image_urls, ARRAY[]::text[]),
           'latest_rent_receipt_url', latest_rent_receipt_url,
           'latest_rent_receipt_uploaded_at', latest_rent_receipt_uploaded_at
         ) ORDER BY landlord_ops_reviewed_at DESC NULLS LAST, created_at DESC), '[]'::jsonb)
    INTO v_total, v_rows
    FROM page;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'agent_user_id', i.agent_user_id,
           'full_name', COALESCE(p.full_name, i.full_name, 'Proxy agent'),
           'phone', COALESCE(p.phone, i.phone),
           'approved_at', i.reviewed_at
         ) ORDER BY COALESCE(p.full_name, i.full_name)), '[]'::jsonb)
    INTO v_proxies
    FROM public.proxy_agent_identity i
    LEFT JOIN public.profiles p ON p.id = i.agent_user_id
   WHERE i.status = 'approved';

  RETURN jsonb_build_object(
    'total', COALESCE(v_total, 0),
    'limit', v_lim,
    'offset', v_off,
    'status', v_status,
    'rows', v_rows,
    'proxy_agents', v_proxies,
    'generated_at', now()
  );
END;
$$;

-- 5. Set-based submit: attach the verified proxy agent and forward to the COO
CREATE OR REPLACE FUNCTION public.partner_ops_attach_proxy_and_forward(
  p_request_ids uuid[],
  p_proxy_agent_id uuid,
  p_comment text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_comment text := TRIM(COALESCE(p_comment, ''));
  v_ids uuid[];
  v_updated jsonb;
BEGIN
  IF NOT public.is_partner_ops(v_actor) THEN
    RAISE EXCEPTION 'Not authorised for Partner Operations' USING ERRCODE = '42501';
  END IF;
  IF p_request_ids IS NULL OR array_length(p_request_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'Select at least one rent request';
  END IF;
  IF char_length(v_comment) < 10 THEN
    RAISE EXCEPTION 'A note of at least 10 characters is required';
  END IF;
  IF p_proxy_agent_id IS NULL OR NOT public.is_approved_proxy_agent(p_proxy_agent_id) THEN
    RAISE EXCEPTION 'Only a verified proxy agent can be attached' USING ERRCODE = '42501';
  END IF;

  SELECT ARRAY_AGG(id) INTO v_ids
    FROM public.rent_requests
   WHERE id = ANY(p_request_ids)
     AND status = 'landlord_ops_approved'
     AND (registration_type IS NULL OR registration_type <> 'outstanding_balance');

  IF v_ids IS NULL THEN
    RAISE EXCEPTION 'None of the selected requests are awaiting Partner Operations';
  END IF;

  WITH upd AS (
    UPDATE public.rent_requests
       SET status = 'partner_ops_approved',
           proxy_agent_id = p_proxy_agent_id,
           partner_ops_reviewed_by = v_actor,
           partner_ops_reviewed_at = now(),
           partner_ops_comment = v_comment,
           updated_at = now()
     WHERE id = ANY(v_ids)
    RETURNING id, tenant_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'tenant_id', tenant_id)), '[]'::jsonb)
    INTO v_updated FROM upd;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, reason, metadata)
  SELECT 'partner_ops_proxy_attached', 'rent_requests', (x->>'id')::uuid, v_actor, v_comment,
         jsonb_build_object('proxy_agent_id', p_proxy_agent_id, 'forwarded_to', 'coo')
    FROM jsonb_array_elements(v_updated) x;

  INSERT INTO public.system_events (event_type, user_id, metadata)
  SELECT 'rent_request_approved', (x->>'tenant_id')::uuid,
         jsonb_build_object(
           'stage', 'partner_ops_approved',
           'rent_request_id', (x->>'id')::uuid,
           'proxy_agent_id', p_proxy_agent_id,
           'reviewed_by', v_actor
         )
    FROM jsonb_array_elements(v_updated) x;

  RETURN jsonb_build_object(
    'updated', jsonb_array_length(v_updated),
    'rows', v_updated,
    'proxy_agent_id', p_proxy_agent_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.partner_ops_list_rent_requests(text, text, int, int) FROM anon;
REVOKE ALL ON FUNCTION public.partner_ops_attach_proxy_and_forward(uuid[], uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.partner_ops_list_rent_requests(text, text, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.partner_ops_attach_proxy_and_forward(uuid[], uuid, text) TO authenticated;