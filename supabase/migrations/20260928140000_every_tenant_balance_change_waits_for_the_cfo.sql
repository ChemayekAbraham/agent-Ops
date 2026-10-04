-- Every change to a tenant's Rent Plan money now waits for the CFO.
--
-- WHY THIS EXISTS WHEN 20260914090000 ALREADY SAID SO
--
-- 20260914090000 wrote the approval queue and was never applied to production.
-- Checked 2026-09-28: `cfo_decide_tenant_balance_edit`,
-- `ops_withdraw_tenant_balance_edit` and `tenant_balance_edits_pending` do not
-- exist in the live database, `tenant_balance_edits` has none of the approval
-- columns, and `ops_edit_tenant_balance` is still the version that writes
-- rent_amount, total_repayment, amount_repaid and daily_repayment straight onto
-- the row. The CFO screen (`CFOTenantBalanceApprovals.tsx`) has been shipped and
-- calling functions that do not exist.
--
-- So the rule was real, written down, reviewed — and unenforced. This migration
-- applies it, and closes the two doors it never covered.
--
-- THE DOOR NOBODY USED WAS THE GUARDED ONE
--
-- `tenant_balance_edits` holds ZERO rows. `ops_edit_tenant_balance` — the
-- function 20260914090000 was written to gate — has never been called in
-- production. Every real balance change went through the two ungated paths:
--
--   tenant_ops_correct_rent_request   261 edits changed amount_repaid,
--                                     219 of them upward, net +201,096,194
--                                     between 17 July and 25 September
--   ops_record_payment_edit           83 edits ('outstanding_balance' and
--                                     'rent_amount' rewrite the row on save)
--
-- Gating only `ops_edit_tenant_balance` would have changed nothing at all.
-- All three doors now lead to the same queue.
--
-- WHAT A PENDING EDIT STORES, AND WHY IT IS A TARGET
--
-- An edit records what the plan should BECOME, not a delta and not the
-- amount_repaid computed at submission. If the tenant pays while the edit
-- waits, approving it recomputes against the row as it stands at that moment,
-- so the plan lands on the figure the CFO actually approved and the collection
-- in between is not silently overwritten.
--
-- `tenant_ops_correct_rent_request` has a wider surface than the other two
-- (duration, access fee, request fee, totals), so its request is carried in a
-- `target` jsonb rather than forced into two columns. `source` records which
-- door it came through, which is also what lets the rent-fee email say who
-- changed what.
--
-- One pending edit per plan. A second submission is refused rather than queued,
-- so two half-finished corrections cannot race each other.
--
-- THE APPROVER EXISTS. `cfo_approval_approvers` holds one CFO with the `cfo`
-- role (Angwen Sarah), so nothing is queued into a room with nobody in it.

-- 1. Approval state on the existing audit table ---------------------------
ALTER TABLE public.tenant_balance_edits
  ADD COLUMN IF NOT EXISTS status             text NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS target_outstanding numeric,
  ADD COLUMN IF NOT EXISTS target_rent_amount numeric,
  ADD COLUMN IF NOT EXISTS target             jsonb,
  ADD COLUMN IF NOT EXISTS source             text NOT NULL DEFAULT 'tenant_ops_balance',
  ADD COLUMN IF NOT EXISTS decided_by         uuid,
  ADD COLUMN IF NOT EXISTS decided_at         timestamptz,
  ADD COLUMN IF NOT EXISTS decision_note      text,
  ADD COLUMN IF NOT EXISTS applied_at         timestamptz;

COMMENT ON COLUMN public.tenant_balance_edits.status IS
  'pending | approved | rejected. Rows written before this migration default to approved because they were applied on save.';
COMMENT ON COLUMN public.tenant_balance_edits.target_outstanding IS
  'What the submitter wants the outstanding balance to become. Re-applied against the CURRENT row at approval time, so a payment made while pending is not overwritten.';
COMMENT ON COLUMN public.tenant_balance_edits.target IS
  'Full requested correction for the wider tenant_ops_correction door: rent_amount, duration_days, access_fee, request_fee, total_repayment, daily_repayment, amount_repaid. NULL members mean "leave alone".';
COMMENT ON COLUMN public.tenant_balance_edits.source IS
  'Which door the change came through: tenant_ops_balance | tenant_ops_correction | ops_payment_edit.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_balance_edits_status_check') THEN
    ALTER TABLE public.tenant_balance_edits
      ADD CONSTRAINT tenant_balance_edits_status_check
      CHECK (status IN ('pending', 'approved', 'rejected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_balance_edits_source_check') THEN
    ALTER TABLE public.tenant_balance_edits
      ADD CONSTRAINT tenant_balance_edits_source_check
      CHECK (source IN ('tenant_ops_balance', 'tenant_ops_correction', 'ops_payment_edit'));
  END IF;
END $$;

-- At most one edit awaiting a decision per plan.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_balance_edits_one_pending_per_plan
  ON public.tenant_balance_edits (rent_request_id)
  WHERE status = 'pending';

-- 2. Door one: the tenant-ops balance panel -------------------------------
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

  IF EXISTS (SELECT 1 FROM public.tenant_balance_edits
              WHERE rent_request_id = p_rent_request_id AND status = 'pending') THEN
    RAISE EXCEPTION 'This Rent Plan already has a change waiting for CFO approval. Withdraw it first.';
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
    reason, status, source
  ) VALUES (
    p_rent_request_id, r.tenant_id, COALESCE(r.assigned_agent_id, r.agent_id), v_uid, v_editor_name,
    r.rent_amount, COALESCE(p_new_rent_amount, r.rent_amount),
    r.total_repayment, NULL,
    COALESCE(r.amount_repaid,0), NULL,
    r.daily_repayment, NULL,
    v_current_outstanding, COALESCE(p_new_outstanding, v_current_outstanding),
    p_new_rent_amount, p_new_outstanding,
    btrim(p_reason), 'pending', 'tenant_ops_balance'
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

-- 3. Door two: the tenant-ops rent plan correction ------------------------
--    This is the door that carried 201,096,194. It kept its signature and its
--    return shape so the Tenant Ops screen does not break; it now returns the
--    plan UNCHANGED, because nothing has changed yet.
CREATE OR REPLACE FUNCTION public.tenant_ops_correct_rent_request(
  -- Defaults must be repeated: the live signature carries them and Postgres
  -- refuses a CREATE OR REPLACE that drops them.
  p_rent_request_id uuid,
  p_rent_amount     numeric DEFAULT NULL::numeric,
  p_duration_days   integer DEFAULT NULL::integer,
  p_access_fee      numeric DEFAULT NULL::numeric,
  p_request_fee     numeric DEFAULT NULL::numeric,
  p_total_repayment numeric DEFAULT NULL::numeric,
  p_daily_repayment numeric DEFAULT NULL::numeric,
  p_amount_repaid   numeric DEFAULT NULL::numeric,
  p_reason          text    DEFAULT NULL::text
)
RETURNS TABLE (
  id uuid, rent_amount numeric, duration_days integer, access_fee numeric,
  request_fee numeric, total_repayment numeric, daily_repayment numeric,
  amount_repaid numeric, status text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_actor  uuid := auth.uid();
  v_before public.rent_requests%ROWTYPE;
  v_reason text := trim(coalesce(p_reason, ''));
  v_name   text;
  v_edit_id uuid;
  v_current_outstanding numeric;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;

  IF NOT (
    public.has_role(v_actor, 'manager'::public.app_role)
    OR public.has_role(v_actor, 'operations'::public.app_role)
    OR public.has_role(v_actor, 'coo'::public.app_role)
    OR public.has_role(v_actor, 'cfo'::public.app_role)
    OR public.has_role(v_actor, 'ceo'::public.app_role)
    OR public.has_role(v_actor, 'super_admin'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized to correct rent requests';
  END IF;

  SELECT * INTO v_before FROM public.rent_requests rr
   WHERE rr.id = p_rent_request_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rent request not found';
  END IF;

  IF lower(coalesce(v_before.status, '')) IN ('deleted_by_agent', 'rejected', 'cancelled', 'closed') THEN
    RAISE EXCEPTION 'This rent request is % and can no longer be corrected', v_before.status;
  END IF;

  IF p_amount_repaid IS NOT NULL AND p_amount_repaid < 0 THEN
    RAISE EXCEPTION 'Amount repaid cannot be negative';
  END IF;

  -- Nobody approves their own correction on a plan they collect on. The two
  -- editors who did this moved 79,980,321 across 45 plans; see
  -- docs/plan-balance-unbacked-investigation.md.
  IF v_actor = COALESCE(v_before.assigned_agent_id, v_before.agent_id) THEN
    RAISE EXCEPTION 'You are the agent on this Rent Plan. Someone else in Tenant Ops must submit this correction.'
      USING ERRCODE = '42501';
  END IF;

  IF p_rent_amount IS NULL AND p_duration_days IS NULL AND p_access_fee IS NULL
     AND p_request_fee IS NULL AND p_total_repayment IS NULL
     AND p_daily_repayment IS NULL AND p_amount_repaid IS NULL THEN
    RAISE EXCEPTION 'Nothing to correct';
  END IF;

  -- `status` is also an OUT column of this function, so the table must be named.
  IF EXISTS (SELECT 1 FROM public.tenant_balance_edits tbe
              WHERE tbe.rent_request_id = p_rent_request_id AND tbe.status = 'pending') THEN
    RAISE EXCEPTION 'This Rent Plan already has a change waiting for CFO approval. Withdraw it first.';
  END IF;

  SELECT full_name INTO v_name FROM public.profiles WHERE profiles.id = v_actor;
  v_current_outstanding := GREATEST(COALESCE(v_before.total_repayment,0) - COALESCE(v_before.amount_repaid,0), 0);

  INSERT INTO public.tenant_balance_edits (
    rent_request_id, tenant_id, agent_id, editor_id, editor_name,
    old_rent_amount, old_total_repayment, old_amount_repaid, old_daily_repayment,
    old_outstanding,
    target_rent_amount, target, reason, status, source
  ) VALUES (
    p_rent_request_id, v_before.tenant_id,
    COALESCE(v_before.assigned_agent_id, v_before.agent_id), v_actor, v_name,
    v_before.rent_amount, v_before.total_repayment,
    COALESCE(v_before.amount_repaid,0), v_before.daily_repayment,
    v_current_outstanding,
    p_rent_amount,
    jsonb_strip_nulls(jsonb_build_object(
      'rent_amount',     p_rent_amount,
      'duration_days',   p_duration_days,
      'access_fee',      p_access_fee,
      'request_fee',     p_request_fee,
      'total_repayment', p_total_repayment,
      'daily_repayment', p_daily_repayment,
      'amount_repaid',   p_amount_repaid
    )),
    v_reason, 'pending', 'tenant_ops_correction'
  ) RETURNING tenant_balance_edits.id INTO v_edit_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
  VALUES (
    'tenant_ops_rent_request_correction_submitted', 'rent_requests',
    p_rent_request_id::text, v_actor,
    jsonb_build_object('reason', v_reason, 'edit_id', v_edit_id, 'awaiting', 'cfo_approval')
  );

  -- Deliberately the CURRENT row: the correction has not been applied.
  RETURN QUERY
  SELECT rr.id, rr.rent_amount, rr.duration_days, rr.access_fee, rr.request_fee,
         rr.total_repayment, rr.daily_repayment, rr.amount_repaid, rr.status
  FROM public.rent_requests rr
  WHERE rr.id = p_rent_request_id;
END;
$function$;

-- 4. Door three: ops_record_payment_edit ----------------------------------
--    'landlord_payout' is not a tenant balance and keeps applying on save.
CREATE OR REPLACE FUNCTION public.ops_record_payment_edit(
  p_edit_type text, p_target_id uuid, p_new_amount numeric, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_old numeric;
  v_tenant uuid;
  v_agent uuid;
  v_landlord_name text;
  v_rent_request_id uuid;
  v_payout_id uuid;
  v_edit_id uuid;
  v_total numeric;
  v_pending_id uuid;
  r record;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF NOT public.is_ops_role(v_actor) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;
  IF p_edit_type NOT IN ('rent_amount','landlord_payout','outstanding_balance') THEN
    RAISE EXCEPTION 'Invalid edit type';
  END IF;
  IF p_new_amount IS NULL OR (p_edit_type = 'outstanding_balance' AND p_new_amount < 0)
     OR (p_edit_type <> 'outstanding_balance' AND p_new_amount <= 0) THEN
    RAISE EXCEPTION 'Amount is invalid';
  END IF;

  SELECT full_name INTO v_actor_name FROM public.profiles WHERE profiles.id = v_actor;

  IF p_edit_type = 'landlord_payout' THEN
    SELECT amount, tenant_id, agent_id, landlord_name, rent_request_id
      INTO v_old, v_tenant, v_agent, v_landlord_name, v_rent_request_id
      FROM public.agent_landlord_payouts WHERE agent_landlord_payouts.id = p_target_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Landlord payout not found'; END IF;
    v_payout_id := p_target_id;

    UPDATE public.agent_landlord_payouts
       SET amount = p_new_amount, updated_at = now()
     WHERE agent_landlord_payouts.id = p_target_id;
  ELSE
    SELECT * INTO r FROM public.rent_requests WHERE rent_requests.id = p_target_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Rent request not found'; END IF;

    v_rent_request_id := p_target_id;
    v_tenant := r.tenant_id;
    v_agent  := COALESCE(r.assigned_agent_id, r.agent_id);
    v_total  := COALESCE(r.total_repayment, 0);
    v_old    := CASE WHEN p_edit_type = 'rent_amount' THEN r.rent_amount
                     ELSE GREATEST(v_total - COALESCE(r.amount_repaid,0), 0) END;

    IF v_actor = v_agent THEN
      RAISE EXCEPTION 'You are the agent on this Rent Plan. Someone else must submit this edit.'
        USING ERRCODE = '42501';
    END IF;

    IF EXISTS (SELECT 1 FROM public.tenant_balance_edits
                WHERE rent_request_id = p_target_id AND status = 'pending') THEN
      RAISE EXCEPTION 'This Rent Plan already has a change waiting for CFO approval. Withdraw it first.';
    END IF;

    INSERT INTO public.tenant_balance_edits (
      rent_request_id, tenant_id, agent_id, editor_id, editor_name,
      old_rent_amount, old_total_repayment, old_amount_repaid, old_daily_repayment,
      old_outstanding,
      target_rent_amount, target_outstanding, reason, status, source
    ) VALUES (
      p_target_id, v_tenant, v_agent, v_actor, v_actor_name,
      r.rent_amount, r.total_repayment, COALESCE(r.amount_repaid,0), r.daily_repayment,
      GREATEST(v_total - COALESCE(r.amount_repaid,0), 0),
      CASE WHEN p_edit_type = 'rent_amount'         THEN p_new_amount END,
      CASE WHEN p_edit_type = 'outstanding_balance' THEN p_new_amount END,
      trim(p_reason), 'pending', 'ops_payment_edit'
    ) RETURNING tenant_balance_edits.id INTO v_pending_id;
  END IF;

  INSERT INTO public.landlord_payment_edits (
    edit_type, rent_request_id, payout_id, tenant_id, agent_id, landlord_name,
    old_amount, new_amount, reason, edited_by, edited_by_name
  ) VALUES (
    p_edit_type, v_rent_request_id, v_payout_id, v_tenant, v_agent, v_landlord_name,
    COALESCE(v_old, 0), p_new_amount, trim(p_reason), v_actor, v_actor_name
  ) RETURNING landlord_payment_edits.id INTO v_edit_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_actor, 'ops.record_payment_edit',
    CASE WHEN p_edit_type = 'landlord_payout' THEN 'agent_landlord_payouts' ELSE 'rent_requests' END,
    p_target_id::text,
    jsonb_build_object(
      'edit_type', p_edit_type, 'reason', trim(p_reason),
      'old_amount', COALESCE(v_old, 0), 'new_amount', p_new_amount,
      'agent_id', v_agent, 'edit_id', v_edit_id,
      'applied', (p_edit_type = 'landlord_payout'),
      'pending_edit_id', v_pending_id)
  );

  BEGIN
    INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
    VALUES (
      'payment_edit.recorded', v_agent, 'landlord_payment_edits', v_edit_id,
      jsonb_build_object('edit_id', v_edit_id, 'edit_type', p_edit_type,
        'old_amount', COALESCE(v_old,0), 'new_amount', p_new_amount,
        'tenant_id', v_tenant, 'edited_by', v_actor,
        'applied', (p_edit_type = 'landlord_payout'))
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'edit_id', v_edit_id,
    'old_amount', COALESCE(v_old, 0),
    'new_amount', p_new_amount,
    'agent_id', v_agent,
    'status', CASE WHEN p_edit_type = 'landlord_payout' THEN 'applied' ELSE 'pending' END,
    'pending_edit_id', v_pending_id,
    'message', CASE WHEN p_edit_type = 'landlord_payout'
                    THEN 'Applied.'
                    ELSE 'Submitted for CFO approval. Nothing changes on the tenant''s plan until it is approved.' END
  );
END;
$function$;

-- 5. The CFO decision -----------------------------------------------------
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
  t jsonb;
BEGIN
  IF NOT public.is_cfo_approver(v_uid) THEN
    RAISE EXCEPTION 'Only the designated CFO approver may decide tenant balance changes';
  END IF;

  SELECT * INTO e FROM public.tenant_balance_edits WHERE tenant_balance_edits.id = p_edit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Balance change not found'; END IF;
  IF e.status <> 'pending' THEN
    RAISE EXCEPTION 'This balance change was already %', e.status;
  END IF;

  IF NOT p_approve THEN
    UPDATE public.tenant_balance_edits
       SET status = 'rejected', decided_by = v_uid, decided_at = now(),
           decision_note = NULLIF(btrim(COALESCE(p_note,'')), '')
     WHERE tenant_balance_edits.id = p_edit_id;
    RETURN jsonb_build_object('status', 'rejected', 'edit_id', p_edit_id);
  END IF;

  -- Recompute against the plan AS IT STANDS NOW, not as it stood at submission.
  SELECT * INTO r FROM public.rent_requests WHERE rent_requests.id = e.rent_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rent request not found'; END IF;

  t := COALESCE(e.target, '{}'::jsonb);
  v_duration := GREATEST(COALESCE((t->>'duration_days')::int, r.duration_days, 1), 1);

  IF e.source = 'tenant_ops_correction' THEN
    -- The wider door: take exactly what was asked for, leave the rest alone.
    v_new_rent    := COALESCE((t->>'rent_amount')::numeric, r.rent_amount);
    v_new_access  := COALESCE((t->>'access_fee')::numeric, r.access_fee);
    v_new_request := COALESCE((t->>'request_fee')::numeric, r.request_fee);
    v_new_total   := COALESCE((t->>'total_repayment')::numeric, r.total_repayment);
    v_new_daily   := COALESCE((t->>'daily_repayment')::numeric, r.daily_repayment);
    v_new_repaid  := COALESCE((t->>'amount_repaid')::numeric, r.amount_repaid);
  ELSE
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
  END IF;

  v_new_outstanding := GREATEST(v_new_total - v_new_repaid, 0);

  -- Stamps the log row this UPDATE is about to trigger, so the rent-fee email
  -- can say which door it came through and who submitted it.
  PERFORM set_config('welile.balance_edit_source', e.source, true);

  UPDATE public.rent_requests
     SET rent_amount     = v_new_rent,
         access_fee      = v_new_access,
         request_fee     = v_new_request,
         total_repayment = v_new_total,
         daily_repayment = v_new_daily,
         amount_repaid   = v_new_repaid,
         duration_days   = v_duration,
         updated_at      = now()
   WHERE rent_requests.id = e.rent_request_id;

  UPDATE public.tenant_balance_edits
     SET status = 'approved',
         decided_by = v_uid, decided_at = now(), applied_at = now(),
         decision_note = NULLIF(btrim(COALESCE(p_note,'')), ''),
         -- What was ACTUALLY applied, which may differ from the figures captured
         -- at submission if the tenant paid while this was waiting.
         old_rent_amount = r.rent_amount,           new_rent_amount = v_new_rent,
         old_total_repayment = r.total_repayment,   new_total_repayment = v_new_total,
         old_amount_repaid = COALESCE(r.amount_repaid,0), new_amount_repaid = v_new_repaid,
         old_daily_repayment = r.daily_repayment,   new_daily_repayment = v_new_daily,
         old_outstanding = GREATEST(COALESCE(r.total_repayment,0) - COALESCE(r.amount_repaid,0), 0),
         new_outstanding = v_new_outstanding
   WHERE tenant_balance_edits.id = p_edit_id;

  PERFORM public.ops_sync_rent_request_status_to_balance(e.rent_request_id);
  SELECT rent_requests.status INTO v_status FROM public.rent_requests WHERE rent_requests.id = e.rent_request_id;

  RETURN jsonb_build_object(
    'status', 'approved', 'edit_id', p_edit_id, 'rent_request_id', e.rent_request_id,
    'rent_amount', v_new_rent, 'total_repayment', v_new_total,
    'amount_repaid', v_new_repaid, 'daily_repayment', v_new_daily,
    'outstanding', v_new_outstanding, 'plan_status', v_status
  );
END;
$function$;

-- 6. The submitter may withdraw their own pending edit ---------------------
CREATE OR REPLACE FUNCTION public.ops_withdraw_tenant_balance_edit(p_edit_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); e record;
BEGIN
  IF NOT public.is_tenant_ops_staff(v_uid) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  SELECT * INTO e FROM public.tenant_balance_edits WHERE tenant_balance_edits.id = p_edit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Balance change not found'; END IF;
  IF e.status <> 'pending' THEN RAISE EXCEPTION 'This balance change was already %', e.status; END IF;

  UPDATE public.tenant_balance_edits
     SET status = 'rejected', decided_by = v_uid, decided_at = now(),
         decision_note = 'Withdrawn by the submitter before CFO review'
   WHERE tenant_balance_edits.id = p_edit_id;
  RETURN jsonb_build_object('status', 'withdrawn', 'edit_id', p_edit_id);
END;
$function$;

-- 7. The queue ------------------------------------------------------------
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
           'source', e.source,
           'submitted_at', e.created_at,
           'reason', e.reason,
           'current_rent_amount', rr.rent_amount,
           'current_outstanding', GREATEST(COALESCE(rr.total_repayment,0) - COALESCE(rr.amount_repaid,0), 0),
           'target_rent_amount', e.target_rent_amount,
           'target_outstanding', e.target_outstanding,
           'target', e.target,
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

REVOKE ALL ON FUNCTION public.cfo_decide_tenant_balance_edit(uuid, boolean, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.ops_withdraw_tenant_balance_edit(uuid) FROM public, anon;
REVOKE ALL ON FUNCTION public.tenant_balance_edits_pending() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.cfo_decide_tenant_balance_edit(uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_withdraw_tenant_balance_edit(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_balance_edits_pending() TO authenticated;

-- 8. Label the change log so the rent-fee email can tell the doors apart ---
ALTER TABLE public.rent_amount_change_log
  ADD COLUMN IF NOT EXISTS source text;

COMMENT ON COLUMN public.rent_amount_change_log.source IS
  'Which door moved the money: cfo_approved_<door> for an approved balance edit, '
  'agent_rent_plan_edit for an agent correcting a rejected or renewal plan, '
  'NULL for an ordinary collection or an unlabelled direct write.';

CREATE OR REPLACE FUNCTION public.log_rent_amount_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  fields text[] := ARRAY[]::text[];
  v_source text := NULLIF(current_setting('welile.balance_edit_source', true), '');
BEGIN
  IF NEW.rent_amount IS DISTINCT FROM OLD.rent_amount THEN fields := array_append(fields, 'rent_amount'::text); END IF;
  IF NEW.duration_days IS DISTINCT FROM OLD.duration_days THEN fields := array_append(fields, 'duration_days'::text); END IF;
  IF NEW.access_fee IS DISTINCT FROM OLD.access_fee THEN fields := array_append(fields, 'access_fee'::text); END IF;
  IF NEW.request_fee IS DISTINCT FROM OLD.request_fee THEN fields := array_append(fields, 'request_fee'::text); END IF;
  IF NEW.total_repayment IS DISTINCT FROM OLD.total_repayment THEN fields := array_append(fields, 'total_repayment'::text); END IF;
  IF NEW.daily_repayment IS DISTINCT FROM OLD.daily_repayment THEN fields := array_append(fields, 'daily_repayment'::text); END IF;
  IF NEW.amount_repaid IS DISTINCT FROM OLD.amount_repaid THEN fields := array_append(fields, 'amount_repaid'::text); END IF;

  IF array_length(fields, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.rent_amount_change_log (
    rent_request_id, tenant_id, agent_id,
    old_rent_amount, new_rent_amount,
    old_total_repayment, new_total_repayment,
    old_amount_repaid, new_amount_repaid,
    old_duration_days, new_duration_days,
    old_access_fee, new_access_fee,
    old_request_fee, new_request_fee,
    old_daily_repayment, new_daily_repayment,
    changed_fields, status, changed_by, source
  ) VALUES (
    NEW.id, NEW.tenant_id, COALESCE(NEW.assigned_agent_id, NEW.agent_id),
    OLD.rent_amount, NEW.rent_amount,
    OLD.total_repayment, NEW.total_repayment,
    OLD.amount_repaid, NEW.amount_repaid,
    OLD.duration_days, NEW.duration_days,
    OLD.access_fee, NEW.access_fee,
    OLD.request_fee, NEW.request_fee,
    OLD.daily_repayment, NEW.daily_repayment,
    fields, NEW.status, auth.uid(),
    CASE WHEN v_source IS NULL THEN NULL
         WHEN v_source LIKE 'agent_%' THEN v_source
         ELSE 'cfo_approved_' || v_source END
  );

  IF NOT (array_length(fields, 1) = 1 AND fields[1] = 'amount_repaid') THEN
    INSERT INTO public.system_events (event_type, user_id, metadata)
    VALUES (
      'rent_request_created',
      NEW.tenant_id,
      jsonb_build_object(
        'change', 'rent_fees_changed',
        'changed_fields', to_jsonb(fields),
        'rent_request_id', NEW.id,
        'old_rent_amount', OLD.rent_amount,
        'new_rent_amount', NEW.rent_amount,
        'old_duration_days', OLD.duration_days,
        'new_duration_days', NEW.duration_days,
        'old_total_repayment', OLD.total_repayment,
        'new_total_repayment', NEW.total_repayment,
        'changed_by', auth.uid(),
        'source', v_source
      )
    );
  END IF;

  RETURN NEW;
END;
$function$;

-- 9. Post-condition -------------------------------------------------------
DO $check$
DECLARE v_missing text := '';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='cfo_decide_tenant_balance_edit') THEN
    v_missing := v_missing || ' cfo_decide_tenant_balance_edit';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='tenant_balance_edits' AND column_name='status') THEN
    v_missing := v_missing || ' tenant_balance_edits.status';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cfo_approval_approvers) THEN
    RAISE WARNING 'No CFO approver is configured. Balance edits will queue with nobody able to decide them.';
  END IF;
  IF v_missing <> '' THEN
    RAISE EXCEPTION 'Migration incomplete, missing:%', v_missing;
  END IF;
END
$check$;
