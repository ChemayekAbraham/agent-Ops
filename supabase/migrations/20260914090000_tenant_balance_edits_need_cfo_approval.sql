-- Tenant balance edits now wait for the CFO.
--
-- `ops_edit_tenant_balance` applied the change the moment tenant-ops pressed
-- save: it wrote rent_amount, total_repayment, amount_repaid and
-- daily_repayment straight onto rent_requests. A single member of tenant-ops
-- could move what a tenant owes with no second pair of eyes.
--
-- Every edit is now recorded as PENDING and changes nothing until the
-- designated CFO approver decides. No threshold, no exemptions.
--
-- STALE EDITS. An edit records the TARGET OUTSTANDING, not the amount_repaid
-- computed at submission. If the tenant pays while the edit is waiting,
-- approving it recomputes amount_repaid against the row as it stands at that
-- moment, so the plan lands on the outstanding figure the CFO actually
-- approved and the collection in between is not silently overwritten.
--
-- One pending edit per plan at a time — a second submission is refused rather
-- than queued, so two half-finished corrections cannot race each other.

-- 1. Approval state on the existing audit table ---------------------------
ALTER TABLE public.tenant_balance_edits
  ADD COLUMN IF NOT EXISTS status           text NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS target_outstanding numeric,
  ADD COLUMN IF NOT EXISTS target_rent_amount numeric,
  ADD COLUMN IF NOT EXISTS decided_by       uuid,
  ADD COLUMN IF NOT EXISTS decided_at       timestamptz,
  ADD COLUMN IF NOT EXISTS decision_note    text,
  ADD COLUMN IF NOT EXISTS applied_at       timestamptz;

COMMENT ON COLUMN public.tenant_balance_edits.status IS
  'pending | approved | rejected. Rows written before 2026-09-14 default to approved because they were applied on save.';
COMMENT ON COLUMN public.tenant_balance_edits.target_outstanding IS
  'What tenant-ops wants the outstanding balance to become. Re-applied against the CURRENT row at approval time, so a payment made while pending is not overwritten.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_balance_edits_status_check') THEN
    ALTER TABLE public.tenant_balance_edits
      ADD CONSTRAINT tenant_balance_edits_status_check
      CHECK (status IN ('pending', 'approved', 'rejected'));
  END IF;
END $$;

-- At most one edit awaiting a decision per plan.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_balance_edits_one_pending_per_plan
  ON public.tenant_balance_edits (rent_request_id)
  WHERE status = 'pending';

-- 2. Submitting an edit now only queues it --------------------------------
CREATE OR REPLACE FUNCTION public.ops_edit_tenant_balance(
  p_rent_request_id uuid,
  p_new_rent_amount numeric,
  p_new_outstanding numeric,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_editor_name text;
  r record;
  v_edit_id uuid;
  v_current_outstanding numeric;
BEGIN
  IF NOT public.is_tenant_ops_staff(v_uid) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) < 20 THEN
    RAISE EXCEPTION 'A reason of at least 20 characters is required';
  END IF;

  SELECT * INTO r FROM public.rent_requests WHERE id = p_rent_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rent request not found';
  END IF;

  IF p_new_rent_amount IS NOT NULL AND p_new_rent_amount <= 0 THEN
    RAISE EXCEPTION 'Rent amount must be greater than zero';
  END IF;
  IF p_new_outstanding IS NOT NULL AND p_new_outstanding < 0 THEN
    RAISE EXCEPTION 'Outstanding balance cannot be negative';
  END IF;
  IF p_new_rent_amount IS NULL AND p_new_outstanding IS NULL THEN
    RAISE EXCEPTION 'Nothing to change: give a new rent amount, a new outstanding balance, or both';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tenant_balance_edits
     WHERE rent_request_id = p_rent_request_id AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'This Rent Plan already has a balance change waiting for CFO approval. Withdraw it first.';
  END IF;

  v_current_outstanding := GREATEST(COALESCE(r.total_repayment,0) - COALESCE(r.amount_repaid,0), 0);
  SELECT full_name INTO v_editor_name FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.tenant_balance_edits (
    rent_request_id, tenant_id, agent_id, editor_id, editor_name,
    old_rent_amount, new_rent_amount,
    old_total_repayment, new_total_repayment,
    old_amount_repaid, new_amount_repaid,
    old_daily_repayment, new_daily_repayment,
    old_outstanding, new_outstanding,
    target_rent_amount, target_outstanding,
    reason, status
  ) VALUES (
    p_rent_request_id, r.tenant_id, COALESCE(r.assigned_agent_id, r.agent_id), v_uid, v_editor_name,
    r.rent_amount, COALESCE(p_new_rent_amount, r.rent_amount),
    r.total_repayment, NULL,
    COALESCE(r.amount_repaid,0), NULL,
    r.daily_repayment, NULL,
    v_current_outstanding, COALESCE(p_new_outstanding, v_current_outstanding),
    p_new_rent_amount, p_new_outstanding,
    btrim(p_reason), 'pending'
  )
  RETURNING id INTO v_edit_id;

  RETURN jsonb_build_object(
    'status', 'pending',
    'edit_id', v_edit_id,
    'rent_request_id', p_rent_request_id,
    'requested_rent_amount', p_new_rent_amount,
    'requested_outstanding', p_new_outstanding,
    'current_outstanding', v_current_outstanding,
    'message', 'Submitted for CFO approval. Nothing changes on the tenant''s plan until it is approved.'
  );
END;
$function$;

-- 3. The CFO decision -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.cfo_decide_tenant_balance_edit(
  p_edit_id uuid,
  p_approve boolean,
  p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  e record;
  r record;
  v_duration integer;
  v_new_rent numeric;
  v_new_access numeric;
  v_new_request numeric;
  v_new_total numeric;
  v_new_daily numeric;
  v_new_repaid numeric;
  v_new_outstanding numeric;
  v_target_outstanding numeric;
  v_status text;
BEGIN
  IF NOT public.is_cfo_approver(v_uid) THEN
    RAISE EXCEPTION 'Only the designated CFO approver may decide tenant balance changes';
  END IF;

  SELECT * INTO e FROM public.tenant_balance_edits WHERE id = p_edit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Balance change not found'; END IF;
  IF e.status <> 'pending' THEN
    RAISE EXCEPTION 'This balance change was already %', e.status;
  END IF;

  IF NOT p_approve THEN
    UPDATE public.tenant_balance_edits
       SET status = 'rejected', decided_by = v_uid, decided_at = now(),
           decision_note = NULLIF(btrim(COALESCE(p_note,'')), '')
     WHERE id = p_edit_id;
    RETURN jsonb_build_object('status', 'rejected', 'edit_id', p_edit_id);
  END IF;

  -- Recompute against the plan AS IT STANDS NOW, not as it stood at submission.
  SELECT * INTO r FROM public.rent_requests WHERE id = e.rent_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rent request not found'; END IF;

  v_duration := GREATEST(COALESCE(r.duration_days, 1), 1);
  v_new_rent := COALESCE(e.target_rent_amount, r.rent_amount);
  IF v_new_rent <= 0 THEN RAISE EXCEPTION 'Rent amount must be greater than zero'; END IF;

  IF e.target_rent_amount IS NOT NULL AND e.target_rent_amount <> r.rent_amount THEN
    IF COALESCE(r.rent_amount,0) > 0 THEN
      v_new_access := round(COALESCE(r.access_fee,0) * v_new_rent / r.rent_amount);
    ELSE
      v_new_access := round(v_new_rent * (power(1.33, v_duration::numeric / 30) - 1));
    END IF;
    v_new_request := CASE WHEN v_new_rent <= 200000 THEN 10000 ELSE 20000 END;
    v_new_total := v_new_rent + v_new_access + v_new_request;
    v_new_daily := ceil(v_new_total / v_duration);
  ELSE
    v_new_access := r.access_fee;
    v_new_request := r.request_fee;
    v_new_total := r.total_repayment;
    v_new_daily := r.daily_repayment;
  END IF;

  -- The approved intent is an OUTSTANDING figure. Land on it.
  v_target_outstanding := e.target_outstanding;
  IF v_target_outstanding IS NOT NULL THEN
    v_new_repaid := LEAST(GREATEST(v_new_total - v_target_outstanding, 0), v_new_total);
  ELSE
    v_new_repaid := LEAST(COALESCE(r.amount_repaid,0), v_new_total);
  END IF;
  v_new_outstanding := GREATEST(v_new_total - v_new_repaid, 0);

  UPDATE public.rent_requests
     SET rent_amount = v_new_rent,
         access_fee = v_new_access,
         request_fee = v_new_request,
         total_repayment = v_new_total,
         daily_repayment = v_new_daily,
         amount_repaid = v_new_repaid,
         updated_at = now()
   WHERE id = e.rent_request_id;

  INSERT INTO public.rent_amount_change_log (
    rent_request_id, tenant_id, agent_id,
    old_rent_amount, new_rent_amount,
    old_total_repayment, new_total_repayment,
    old_amount_repaid, new_amount_repaid,
    old_duration_days, new_duration_days,
    old_access_fee, new_access_fee,
    old_request_fee, new_request_fee,
    old_daily_repayment, new_daily_repayment,
    changed_fields, status, changed_by
  ) VALUES (
    e.rent_request_id, r.tenant_id, COALESCE(r.assigned_agent_id, r.agent_id),
    r.rent_amount, v_new_rent,
    r.total_repayment, v_new_total,
    COALESCE(r.amount_repaid,0), v_new_repaid,
    r.duration_days, r.duration_days,
    r.access_fee, v_new_access,
    r.request_fee, v_new_request,
    r.daily_repayment, v_new_daily,
    ARRAY['manual_balance_edit'::text, 'cfo_approved'::text, 'amount_repaid'::text,
          'rent_amount'::text, ('reason: ' || COALESCE(e.reason,''))::text],
    r.status,
    e.editor_id
  );

  UPDATE public.tenant_balance_edits
     SET status = 'approved',
         decided_by = v_uid, decided_at = now(), applied_at = now(),
         decision_note = NULLIF(btrim(COALESCE(p_note,'')), ''),
         -- Record what was ACTUALLY applied, which may differ from the figures
         -- captured at submission if the tenant paid while this was waiting.
         old_rent_amount = r.rent_amount,
         new_rent_amount = v_new_rent,
         old_total_repayment = r.total_repayment,
         new_total_repayment = v_new_total,
         old_amount_repaid = COALESCE(r.amount_repaid,0),
         new_amount_repaid = v_new_repaid,
         old_daily_repayment = r.daily_repayment,
         new_daily_repayment = v_new_daily,
         old_outstanding = GREATEST(COALESCE(r.total_repayment,0) - COALESCE(r.amount_repaid,0), 0),
         new_outstanding = v_new_outstanding
   WHERE id = p_edit_id;

  PERFORM public.ops_sync_rent_request_status_to_balance(e.rent_request_id);
  SELECT status INTO v_status FROM public.rent_requests WHERE id = e.rent_request_id;

  RETURN jsonb_build_object(
    'status', 'approved',
    'edit_id', p_edit_id,
    'rent_request_id', e.rent_request_id,
    'rent_amount', v_new_rent,
    'total_repayment', v_new_total,
    'amount_repaid', v_new_repaid,
    'daily_repayment', v_new_daily,
    'outstanding', v_new_outstanding,
    'plan_status', v_status
  );
END;
$function$;

-- 4. Tenant-ops may withdraw their own pending edit ------------------------
CREATE OR REPLACE FUNCTION public.ops_withdraw_tenant_balance_edit(p_edit_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); e record;
BEGIN
  IF NOT public.is_tenant_ops_staff(v_uid) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  SELECT * INTO e FROM public.tenant_balance_edits WHERE id = p_edit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Balance change not found'; END IF;
  IF e.status <> 'pending' THEN RAISE EXCEPTION 'This balance change was already %', e.status; END IF;

  UPDATE public.tenant_balance_edits
     SET status = 'rejected', decided_by = v_uid, decided_at = now(),
         decision_note = 'Withdrawn by the submitter before CFO review'
   WHERE id = p_edit_id;
  RETURN jsonb_build_object('status', 'withdrawn', 'edit_id', p_edit_id);
END;
$function$;

-- 5. The queue ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tenant_balance_edits_pending()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_out jsonb;
BEGIN
  IF NOT (public.is_cfo_approver(v_uid)
          OR public.has_role(v_uid, 'cfo'::app_role)
          OR public.is_tenant_ops_staff(v_uid)) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'edit_id', e.id,
           'rent_request_id', e.rent_request_id,
           'tenant_name', tp.full_name,
           'tenant_phone', tp.phone,
           'agent_name', ap.full_name,
           'editor_name', e.editor_name,
           'submitted_at', e.created_at,
           'reason', e.reason,
           'current_rent_amount', rr.rent_amount,
           'current_outstanding', GREATEST(COALESCE(rr.total_repayment,0) - COALESCE(rr.amount_repaid,0), 0),
           'target_rent_amount', e.target_rent_amount,
           'target_outstanding', e.target_outstanding,
           'can_decide', public.is_cfo_approver(v_uid)
         ) ORDER BY e.created_at), '[]'::jsonb)
    INTO v_out
    FROM public.tenant_balance_edits e
    JOIN public.rent_requests rr ON rr.id = e.rent_request_id
    LEFT JOIN public.profiles tp ON tp.id = e.tenant_id
    LEFT JOIN public.profiles ap ON ap.id = e.agent_id
   WHERE e.status = 'pending';

  RETURN v_out;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.cfo_decide_tenant_balance_edit(uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_withdraw_tenant_balance_edit(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_balance_edits_pending() TO authenticated;

-- 6. Post-condition -------------------------------------------------------
DO $verify$
BEGIN
  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='ops_edit_tenant_balance')
     ILIKE '%UPDATE public.rent_requests%' THEN
    RAISE EXCEPTION 'ops_edit_tenant_balance still writes to rent_requests - it must only queue';
  END IF;
END
$verify$;
