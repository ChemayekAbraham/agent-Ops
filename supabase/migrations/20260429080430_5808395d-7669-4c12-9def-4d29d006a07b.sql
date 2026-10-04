-- ============================================================
-- 1) Schema additions
-- ============================================================
ALTER TABLE public.rent_requests
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_at_stage text,
  ADD COLUMN IF NOT EXISTS reopened_at timestamptz,
  ADD COLUMN IF NOT EXISTS reopened_by uuid,
  ADD COLUMN IF NOT EXISTS reopen_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reopen_reason text;

CREATE INDEX IF NOT EXISTS idx_rent_requests_rejected_stage
  ON public.rent_requests(rejected_at_stage)
  WHERE status = 'rejected';

-- ============================================================
-- 2) Backfill rejected_at_stage for existing rejected rows.
-- Highest reviewer reached wins. Rows with no reviewer info
-- default to 'pending' (original Tenant Ops gate).
-- ============================================================
UPDATE public.rent_requests
SET rejected_at_stage = CASE
  WHEN cfo_reviewed_by IS NOT NULL          THEN 'coo_approved'
  WHEN coo_reviewed_by IS NOT NULL          THEN 'landlord_ops_approved'
  WHEN landlord_ops_reviewed_by IS NOT NULL THEN 'agent_verified'
  WHEN agent_verified_by IS NOT NULL        THEN 'tenant_ops_approved'
  WHEN tenant_ops_reviewed_by IS NOT NULL   THEN 'pending'
  ELSE 'pending'
END
WHERE status = 'rejected' AND rejected_at_stage IS NULL;

-- Also backfill rejected_at from updated_at when missing (best-effort)
UPDATE public.rent_requests
SET rejected_at = COALESCE(updated_at, created_at)
WHERE status = 'rejected' AND rejected_at IS NULL;

-- ============================================================
-- 3) Reopen RPC — returns request to the stage that rejected it
-- ============================================================
CREATE OR REPLACE FUNCTION public.reopen_rent_request(
  p_request_id uuid,
  p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _row public.rent_requests%ROWTYPE;
  _allowed boolean := FALSE;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Reopen reason must be at least 10 characters';
  END IF;

  SELECT * INTO _row FROM public.rent_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rent request not found';
  END IF;

  IF _row.status <> 'rejected' THEN
    RAISE EXCEPTION 'Only rejected requests can be reopened (current status: %)', _row.status;
  END IF;

  -- 3-reopen lock — only manager can act after that
  IF _row.reopen_count >= 3 AND NOT public.has_role(auth.uid(), 'manager'::app_role) THEN
    RAISE EXCEPTION 'Reopen limit reached (3). Only a manager may act on this request.';
  END IF;

  -- Authorization: any reviewer role + manager + CFO + COO
  _allowed := public.has_role(auth.uid(), 'manager'::app_role)
           OR public.has_role(auth.uid(), 'cfo'::app_role)
           OR public.has_role(auth.uid(), 'coo'::app_role)
           OR public.has_role(auth.uid(), 'tenant_ops'::app_role)
           OR public.has_role(auth.uid(), 'landlord_ops'::app_role)
           OR public.has_role(auth.uid(), 'agent_ops'::app_role);
  IF NOT _allowed THEN
    RAISE EXCEPTION 'Not authorized to reopen rent requests';
  END IF;

  UPDATE public.rent_requests
     SET status = COALESCE(_row.rejected_at_stage, 'pending'),
         reopened_at = now(),
         reopened_by = auth.uid(),
         reopen_count = COALESCE(_row.reopen_count, 0) + 1,
         reopen_reason = trim(p_reason),
         updated_at = now()
   WHERE id = p_request_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
  VALUES (
    'rent_request_reopened',
    'rent_requests',
    p_request_id,
    auth.uid(),
    jsonb_build_object(
      'reason', trim(p_reason),
      'returned_to_status', COALESCE(_row.rejected_at_stage, 'pending'),
      'reopen_count', COALESCE(_row.reopen_count, 0) + 1,
      'previous_rejected_reason', _row.rejected_reason
    )
  );

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES (
    'rent_request.reopened',
    auth.uid(),
    'rent_request',
    p_request_id,
    jsonb_build_object(
      'reason', trim(p_reason),
      'returned_to_status', COALESCE(_row.rejected_at_stage, 'pending'),
      'reopen_count', COALESCE(_row.reopen_count, 0) + 1
    )
  );

  RETURN p_request_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.reopen_rent_request(uuid, text) TO authenticated;

-- ============================================================
-- 4) Force-approve RPC — manager/CFO only
-- ============================================================
CREATE OR REPLACE FUNCTION public.force_approve_rejected_rent_request(
  p_request_id uuid,
  p_reason text,
  p_payout_ref text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _row public.rent_requests%ROWTYPE;
  _next text;
  _stage text;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'manager'::app_role)
          OR public.has_role(auth.uid(), 'cfo'::app_role)) THEN
    RAISE EXCEPTION 'Only manager or CFO may force-approve a rejected request';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Override reason must be at least 10 characters';
  END IF;

  SELECT * INTO _row FROM public.rent_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rent request not found';
  END IF;
  IF _row.status <> 'rejected' THEN
    RAISE EXCEPTION 'Only rejected requests can be force-approved (current: %)', _row.status;
  END IF;

  _stage := COALESCE(_row.rejected_at_stage, 'pending');
  _next := CASE _stage
    WHEN 'pending'                THEN 'tenant_ops_approved'
    WHEN 'tenant_ops_approved'    THEN 'agent_verified'
    WHEN 'agent_verified'         THEN 'landlord_ops_approved'
    WHEN 'landlord_ops_approved'  THEN 'coo_approved'
    WHEN 'coo_approved'           THEN 'funded'
    ELSE 'tenant_ops_approved'
  END;

  -- For CFO-stage force-approve (advance to funded) require a TID
  IF _next = 'funded' AND (p_payout_ref IS NULL OR length(trim(p_payout_ref)) < 1) THEN
    RAISE EXCEPTION 'Transaction reference (TID) is required when force-funding a request';
  END IF;

  UPDATE public.rent_requests
     SET status = _next,
         reopened_at = now(),
         reopened_by = auth.uid(),
         reopen_count = COALESCE(_row.reopen_count, 0) + 1,
         reopen_reason = trim(p_reason),
         payout_transaction_reference = COALESCE(p_payout_ref, payout_transaction_reference),
         updated_at = now()
   WHERE id = p_request_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
  VALUES (
    'rent_request_force_approved',
    'rent_requests',
    p_request_id,
    auth.uid(),
    jsonb_build_object(
      'reason', trim(p_reason),
      'from_rejected_stage', _stage,
      'advanced_to', _next,
      'payout_ref', p_payout_ref,
      'previous_rejected_reason', _row.rejected_reason
    )
  );

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES (
    'rent_request.force_approved',
    auth.uid(),
    'rent_request',
    p_request_id,
    jsonb_build_object(
      'reason', trim(p_reason),
      'from_rejected_stage', _stage,
      'advanced_to', _next
    )
  );

  RETURN p_request_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.force_approve_rejected_rent_request(uuid, text, text) TO authenticated;