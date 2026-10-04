CREATE TABLE public.agent_duplicate_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  duplicate_of_user_id uuid,
  match_type text NOT NULL DEFAULT 'name',
  reason text NOT NULL,
  source text NOT NULL DEFAULT 'advance_review',
  status text NOT NULL DEFAULT 'active',
  flagged_by uuid,
  flagged_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid,
  released_at timestamptz,
  release_reason text,
  request_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_duplicate_flags_status_check CHECK (status IN ('active','released')),
  CONSTRAINT agent_duplicate_flags_match_type_check CHECK (match_type IN ('name','national_id','mobile_money','manual'))
);

CREATE UNIQUE INDEX agent_duplicate_flags_active_uniq
  ON public.agent_duplicate_flags (agent_id) WHERE status = 'active';
CREATE INDEX agent_duplicate_flags_agent_idx ON public.agent_duplicate_flags (agent_id);

GRANT SELECT ON public.agent_duplicate_flags TO authenticated;
GRANT ALL ON public.agent_duplicate_flags TO service_role;

ALTER TABLE public.agent_duplicate_flags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view duplicate flags"
ON public.agent_duplicate_flags FOR SELECT TO authenticated
USING (
  agent_id = auth.uid()
  OR public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
  OR public.has_role(auth.uid(), 'operations'::app_role)
  OR public.has_role(auth.uid(), 'agent_ops'::app_role)
);

CREATE OR REPLACE FUNCTION public.touch_agent_duplicate_flags()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;

CREATE TRIGGER trg_touch_agent_duplicate_flags
BEFORE UPDATE ON public.agent_duplicate_flags
FOR EACH ROW EXECUTE FUNCTION public.touch_agent_duplicate_flags();

-- Blocks advance requests from flagged accounts and from same-name duplicates that already borrow.
CREATE OR REPLACE FUNCTION public.enforce_no_duplicate_account_advance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_name_key text;
  v_dup record;
BEGIN
  IF NEW.status NOT IN ('pending','agent_ops_approved','tenant_ops_approved','landlord_ops_approved','coo_approved') THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.agent_duplicate_flags f
    WHERE f.agent_id = NEW.agent_id AND f.status = 'active'
  ) THEN
    RAISE EXCEPTION 'DUPLICATE_ACCOUNT_BLOCKED: This account is flagged as a duplicate account and cannot request an advance. Contact support to resolve the duplication.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP <> 'INSERT' THEN
    RETURN NEW;
  END IF;

  SELECT nullif(lower(regexp_replace(coalesce(p.full_name,''), '[^a-zA-Z]', '', 'g')), '')
    INTO v_name_key
  FROM public.profiles p WHERE p.id = NEW.agent_id;

  IF v_name_key IS NULL OR length(v_name_key) < 6 THEN
    RETURN NEW;
  END IF;

  SELECT p.id, p.full_name INTO v_dup
  FROM public.profiles p
  WHERE p.id <> NEW.agent_id
    AND lower(regexp_replace(coalesce(p.full_name,''), '[^a-zA-Z]', '', 'g')) = v_name_key
    AND (
      EXISTS (
        SELECT 1 FROM public.agent_advances a
        WHERE a.agent_id = p.id AND a.status IN ('active','overdue') AND a.outstanding_balance > 0
      )
      OR EXISTS (
        SELECT 1 FROM public.agent_advance_requests r
        WHERE r.agent_id = p.id
          AND r.status IN ('pending','agent_ops_approved','tenant_ops_approved','landlord_ops_approved','coo_approved')
      )
    )
  LIMIT 1;

  IF v_dup.id IS NOT NULL THEN
    RAISE EXCEPTION 'DUPLICATE_ACCOUNT_BLOCKED: Another account with the same full name (%) already has an advance or a pending advance request. One advance per person is allowed.', coalesce(v_dup.full_name,'same name')
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END; $$;

CREATE TRIGGER zz_enforce_no_duplicate_account_advance
BEFORE INSERT OR UPDATE ON public.agent_advance_requests
FOR EACH ROW EXECUTE FUNCTION public.enforce_no_duplicate_account_advance();

-- CFO / Agent Ops action: reject a request as a duplicate account and flag the account.
CREATE OR REPLACE FUNCTION public.reject_advance_as_duplicate(
  p_request_id uuid,
  p_reason text,
  p_duplicate_of_user_id uuid DEFAULT NULL,
  p_match_type text DEFAULT 'name'
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_req record;
  v_uid uuid := auth.uid();
BEGIN
  IF NOT (
    public.has_role(v_uid, 'cfo'::app_role)
    OR public.has_role(v_uid, 'manager'::app_role)
    OR public.has_role(v_uid, 'super_admin'::app_role)
    OR public.has_role(v_uid, 'coo'::app_role)
    OR public.has_role(v_uid, 'operations'::app_role)
    OR public.has_role(v_uid, 'agent_ops'::app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorised to flag duplicate accounts.';
  END IF;

  IF coalesce(length(trim(p_reason)),0) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required.';
  END IF;

  SELECT * INTO v_req FROM public.agent_advance_requests WHERE id = p_request_id FOR UPDATE;
  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'Advance request not found.';
  END IF;

  INSERT INTO public.agent_duplicate_flags
    (agent_id, duplicate_of_user_id, match_type, reason, source, flagged_by, request_id)
  VALUES
    (v_req.agent_id, p_duplicate_of_user_id, coalesce(p_match_type,'name'), trim(p_reason), 'advance_review', v_uid, p_request_id)
  ON CONFLICT (agent_id) WHERE status = 'active' DO NOTHING;

  UPDATE public.agent_advance_requests
     SET status = 'rejected',
         rejection_reason = 'DUPLICATE ACCOUNT — ' || trim(p_reason),
         updated_at = now()
   WHERE id = p_request_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_uid, 'advance_rejected_duplicate_account', 'agent_advance_requests', p_request_id::text, trim(p_reason),
          jsonb_build_object('agent_id', v_req.agent_id, 'duplicate_of_user_id', p_duplicate_of_user_id, 'match_type', coalesce(p_match_type,'name')));

  RETURN jsonb_build_object('success', true, 'agent_id', v_req.agent_id);
END; $$;

CREATE OR REPLACE FUNCTION public.release_agent_duplicate_flag(
  p_agent_id uuid,
  p_reason text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_count int;
BEGIN
  IF NOT (public.has_role(v_uid, 'manager'::app_role) OR public.has_role(v_uid, 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'Only a manager can release a duplicate-account flag.';
  END IF;
  IF coalesce(length(trim(p_reason)),0) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required.';
  END IF;

  UPDATE public.agent_duplicate_flags
     SET status = 'released', released_by = v_uid, released_at = now(), release_reason = trim(p_reason)
   WHERE agent_id = p_agent_id AND status = 'active';
  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_uid, 'duplicate_account_flag_released', 'agent_duplicate_flags', p_agent_id::text, trim(p_reason), '{}'::jsonb);

  RETURN jsonb_build_object('success', true, 'released', v_count);
END; $$;

GRANT EXECUTE ON FUNCTION public.reject_advance_as_duplicate(uuid, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_agent_duplicate_flag(uuid, text) TO authenticated;