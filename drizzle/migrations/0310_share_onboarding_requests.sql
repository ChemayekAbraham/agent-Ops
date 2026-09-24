CREATE TABLE public.share_onboarding_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shareholder_id uuid NOT NULL,
  created_by uuid NOT NULL,
  amount bigint NOT NULL CHECK (amount >= 20000),
  shares numeric NOT NULL CHECK (shares > 0),
  pool_ownership_percent numeric NOT NULL,
  company_ownership_percent numeric NOT NULL,
  reference_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'awaiting_signature'
    CHECK (status IN ('awaiting_signature','submitted','completed','cancelled')),
  prefill_name text,
  prefill_phone text,
  prefill_email text,
  shareholder_name text,
  shareholder_signature_data_url text,
  shareholder_signed_at timestamptz,
  company_rep_name text,
  company_rep_position text,
  company_rep_signature_data_url text,
  company_signed_at timestamptz,
  countersigned_by uuid,
  pdf_path text,
  angel_pool_investment_id uuid,
  token_hash text,
  token_expires_at timestamptz,
  cancelled_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.share_onboarding_requests TO authenticated;
GRANT ALL ON public.share_onboarding_requests TO service_role;

ALTER TABLE public.share_onboarding_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Partner ops read share onboarding"
ON public.share_onboarding_requests FOR SELECT TO authenticated
USING (public.is_partner_ops(auth.uid()));

CREATE POLICY "Shareholder reads own share onboarding"
ON public.share_onboarding_requests FOR SELECT TO authenticated
USING (shareholder_id = auth.uid());

CREATE INDEX idx_share_onb_status_created ON public.share_onboarding_requests (status, created_at DESC);
CREATE INDEX idx_share_onb_shareholder ON public.share_onboarding_requests (shareholder_id);

CREATE TRIGGER trg_share_onb_updated_at BEFORE UPDATE ON public.share_onboarding_requests
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Partner Ops list: one round trip, names joined server-side.
CREATE OR REPLACE FUNCTION public.share_onboarding_list(
  p_status text DEFAULT NULL, p_search text DEFAULT NULL,
  p_limit int DEFAULT 50, p_offset int DEFAULT 0)
RETURNS TABLE (
  id uuid, shareholder_id uuid, shareholder_full_name text, shareholder_phone text, shareholder_email text,
  created_by_name text, amount bigint, shares numeric, pool_ownership_percent numeric,
  company_ownership_percent numeric, reference_id text, status text, shareholder_name text,
  shareholder_signature_data_url text, shareholder_signed_at timestamptz, company_rep_name text,
  company_rep_position text, company_signed_at timestamptz, pdf_path text,
  token_expires_at timestamptz, created_at timestamptz, total_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_partner_ops(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT r.id, r.shareholder_id, p.full_name, p.phone, p.email, c.full_name,
    r.amount, r.shares, r.pool_ownership_percent, r.company_ownership_percent, r.reference_id,
    r.status, r.shareholder_name, r.shareholder_signature_data_url, r.shareholder_signed_at,
    r.company_rep_name, r.company_rep_position, r.company_signed_at, r.pdf_path,
    r.token_expires_at, r.created_at, count(*) OVER ()
  FROM public.share_onboarding_requests r
  LEFT JOIN public.profiles p ON p.id = r.shareholder_id
  LEFT JOIN public.profiles c ON c.id = r.created_by
  WHERE (p_status IS NULL OR r.status = p_status)
    AND (p_search IS NULL OR p_search = '' OR p.full_name ILIKE '%'||p_search||'%'
         OR p.phone ILIKE '%'||p_search||'%' OR p.email ILIKE '%'||p_search||'%'
         OR r.reference_id ILIKE '%'||p_search||'%')
  ORDER BY r.created_at DESC
  LIMIT LEAST(GREATEST(p_limit,1),200) OFFSET GREATEST(p_offset,0);
END $$;

-- Shareholder: load own request by id + token (must be signed in as the invited account).
CREATE OR REPLACE FUNCTION public.share_onboarding_get(p_id uuid, p_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.share_onboarding_requests;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('state','auth_required'); END IF;
  SELECT * INTO r FROM public.share_onboarding_requests WHERE id = p_id;
  IF NOT FOUND OR r.token_hash IS NULL OR r.token_hash <> encode(extensions.digest(coalesce(p_token,''),'sha256'),'hex') THEN
    RETURN jsonb_build_object('state','invalid');
  END IF;
  IF r.shareholder_id <> auth.uid() THEN RETURN jsonb_build_object('state','wrong_account'); END IF;
  IF r.status = 'cancelled' THEN RETURN jsonb_build_object('state','invalid'); END IF;
  IF r.status = 'awaiting_signature' AND r.token_expires_at < now() THEN
    RETURN jsonb_build_object('state','expired');
  END IF;
  RETURN jsonb_build_object('state', CASE WHEN r.status='awaiting_signature' THEN 'ready' ELSE 'done' END,
    'id', r.id, 'status', r.status, 'reference_id', r.reference_id, 'amount', r.amount, 'shares', r.shares,
    'pool_ownership_percent', r.pool_ownership_percent, 'company_ownership_percent', r.company_ownership_percent,
    'prefill_name', r.prefill_name, 'prefill_phone', r.prefill_phone, 'prefill_email', r.prefill_email,
    'shareholder_name', r.shareholder_name, 'created_at', r.created_at);
END $$;

CREATE OR REPLACE FUNCTION public.share_onboarding_submit(p_id uuid, p_token text, p_name text, p_signature text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.share_onboarding_requests;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Please sign in' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM public.share_onboarding_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR r.token_hash <> encode(extensions.digest(coalesce(p_token,''),'sha256'),'hex') THEN
    RAISE EXCEPTION 'This signing link is not valid';
  END IF;
  IF r.shareholder_id <> auth.uid() THEN RAISE EXCEPTION 'This link belongs to another account'; END IF;
  IF r.status <> 'awaiting_signature' THEN RAISE EXCEPTION 'This agreement has already been signed'; END IF;
  IF r.token_expires_at < now() THEN RAISE EXCEPTION 'This signing link has expired'; END IF;
  IF length(trim(coalesce(p_name,''))) < 3 THEN RAISE EXCEPTION 'Enter your full name'; END IF;
  IF coalesce(p_signature,'') NOT LIKE 'data:image/%' OR length(p_signature) > 700000 THEN
    RAISE EXCEPTION 'Please sign the agreement';
  END IF;
  UPDATE public.share_onboarding_requests SET status='submitted', shareholder_name=trim(p_name),
    shareholder_signature_data_url=p_signature, shareholder_signed_at=now() WHERE id=p_id;
  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES ('account_activated'::system_event_type, auth.uid(), 'share_onboarding_requests', p_id,
    jsonb_build_object('action','share_onboarding.shareholder_signed','reference_id', r.reference_id));
  RETURN jsonb_build_object('ok', true);
END $$;

REVOKE ALL ON FUNCTION public.share_onboarding_list(text,text,int,int) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.share_onboarding_get(uuid,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.share_onboarding_submit(uuid,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.share_onboarding_list(text,text,int,int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.share_onboarding_get(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.share_onboarding_submit(uuid,text,text,text) TO authenticated;