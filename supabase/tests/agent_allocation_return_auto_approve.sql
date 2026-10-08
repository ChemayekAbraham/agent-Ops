-- Rolled-back verification for 20261008110000_agent_allocation_return_auto_approve.sql
--
-- Run against the live database. Everything happens inside one transaction that ends in
-- RAISE EXCEPTION, so nothing is kept (no ledger rows, no float movement). The error text
-- IS the report: a JSON list of steps, each with "pass": true/false. Every step must pass.
--
-- Cases (each in its own sub-transaction so they cannot affect each other):
--   0   short reason is refused
--   1   automatic success: ledger pair, float, status moves, audit, event, notice
--   3   double tap: second call refused, still exactly one reversal
--   4   the agent who sent the float back cannot approve Agent Ops / Tenant Ops / Landlord Ops
--   7   amount edit goes back to Agent Ops review ('pending') and stays unapprovable by the agent
--   2   payout already started (existing payout AND a freshly started one) falls back to the CFO
--   2b  CFO approve of that fallback still posts the reversal through the shared helper
DO $test$
DECLARE
  r      jsonb := '[]'::jsonb;
  e      record;   -- eligible plan (funded, open float, nothing paid, no payout)
  p      record;   -- plan that already has a landlord payout
  v_res  jsonb;
  v_res2 jsonb;
  v_res3 jsonb;
  v_req  record;
  v_cnt  int;
  v_cnt2 int;
  v_plan_status text;
  v_alloc_status text;
  v_before numeric;
  v_after  numeric;
  v_ok   boolean;
  v_ll   uuid;
  v_phone text;
  v_lname text;
  v_cfo  uuid;
  v_old_rent numeric;
BEGIN
  SELECT al.id AS alloc_id, al.rent_request_id AS plan_id, al.agent_id, al.remaining_amount AS amt
    INTO e
    FROM public.agent_landlord_float_allocations al
    JOIN public.rent_requests rr ON rr.id = al.rent_request_id
   WHERE al.status = 'open' AND rr.status = 'funded' AND COALESCE(al.paid_out_amount,0) = 0
     AND NOT EXISTS (SELECT 1 FROM public.landlord_payouts lp
                      WHERE lp.rent_request_id = al.rent_request_id OR lp.allocation_applied_id = al.id)
     AND NOT EXISTS (SELECT 1 FROM public.agent_allocation_return_requests x
                      WHERE x.allocation_id = al.id AND x.status = 'pending')
   ORDER BY al.created_at DESC LIMIT 1;

  SELECT al.id AS alloc_id, al.rent_request_id AS plan_id, al.agent_id, al.remaining_amount AS amt
    INTO p
    FROM public.agent_landlord_float_allocations al
    JOIN public.rent_requests rr ON rr.id = al.rent_request_id
   WHERE al.status = 'open' AND rr.status = 'funded' AND COALESCE(al.paid_out_amount,0) = 0
     AND EXISTS (SELECT 1 FROM public.landlord_payouts lp
                  WHERE lp.rent_request_id = al.rent_request_id OR lp.allocation_applied_id = al.id)
     AND NOT EXISTS (SELECT 1 FROM public.agent_allocation_return_requests x
                      WHERE x.allocation_id = al.id AND x.status = 'pending')
   ORDER BY al.created_at DESC LIMIT 1;

  r := r || jsonb_build_object('step', 'setup', 'pass', e.alloc_id IS NOT NULL,
        'detail', jsonb_build_object('eligible_plan', e.plan_id, 'payout_plan', p.plan_id));

  -- ── 0: short reason refused ────────────────────────────────────────────
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', e.agent_id, 'role', 'authenticated')::text, true);
    v_res := public.request_allocation_return(e.alloc_id, 'too short');
    r := r || jsonb_build_object('step', '0 short reason refused',
          'pass', (v_res->>'success')::boolean IS FALSE, 'detail', v_res);
    RAISE EXCEPTION 'case_done';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'case_done' THEN
      r := r || jsonb_build_object('step', '0 short reason refused', 'pass', false, 'detail', SQLERRM);
    END IF;
  END;

  -- ── 1 + 3 + 4 + 7: automatic success, double tap, self-approval, amount edit ──
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', e.agent_id, 'role', 'authenticated')::text, true);
    SELECT COALESCE(balance, 0) INTO v_before FROM public.agent_landlord_float WHERE agent_id = e.agent_id;
    SELECT rent_amount INTO v_old_rent FROM public.rent_requests WHERE id = e.plan_id;

    v_res := public.request_allocation_return(e.alloc_id, 'Test: tenant changed their mind about the unit');
    SELECT * INTO v_req FROM public.agent_allocation_return_requests WHERE id = (v_res->>'request_id')::uuid;
    SELECT status INTO v_plan_status FROM public.rent_requests WHERE id = e.plan_id;
    SELECT status INTO v_alloc_status FROM public.agent_landlord_float_allocations WHERE id = e.alloc_id;
    SELECT COALESCE(balance, 0) INTO v_after FROM public.agent_landlord_float WHERE agent_id = e.agent_id;
    SELECT count(*) INTO v_cnt FROM public.general_ledger
     WHERE source_table = 'rent_requests' AND source_id = e.plan_id
       AND description ILIKE '%auto-approved agent send-back%';

    r := r || jsonb_build_object('step', '1a auto success: response',
          'pass', (v_res->>'success')::boolean AND (v_res->>'auto_approved')::boolean
                  AND v_res->>'message' = 'Float returned. You can now edit the Rent Plan.',
          'detail', v_res);
    r := r || jsonb_build_object('step', '1b row approved by the system',
          'pass', v_req.status = 'approved' AND v_req.auto_approved AND v_req.cfo_id IS NULL
                  AND v_req.cfo_note = 'auto-approved agent send-back'
                  AND v_req.reversal_transaction_group IS NOT NULL,
          'detail', to_jsonb(v_req));
    r := r || jsonb_build_object('step', '1c plan NOT cancelled, back to agent_ops_approved; float cancelled',
          'pass', v_plan_status = 'agent_ops_approved' AND v_alloc_status = 'cancelled',
          'detail', jsonb_build_object('plan', v_plan_status, 'float', v_alloc_status));
    r := r || jsonb_build_object('step', '1d two balanced ledger legs; agent float not increased',
          'pass', v_cnt = 2 AND v_after <= v_before,
          'detail', jsonb_build_object('legs', v_cnt, 'float_before', v_before, 'float_after', v_after));
    r := r || jsonb_build_object('step', '1e audit log has action + 10+ char reason',
          'pass', EXISTS (SELECT 1 FROM public.audit_logs
                           WHERE action = 'auto_approve_allocation_return'
                             AND record_id = v_req.id::text AND char_length(reason) >= 10));
    r := r || jsonb_build_object('step', '1f system event carries auto: true',
          'pass', EXISTS (SELECT 1 FROM public.system_events
                           WHERE event_type = 'agent.allocation_return.approved'
                             AND metadata->>'request_id' = v_req.id::text
                             AND (metadata->>'auto')::boolean));
    r := r || jsonb_build_object('step', '1g agent notice written; login restored after the system step',
          'pass', EXISTS (SELECT 1 FROM public.notifications
                           WHERE user_id = e.agent_id AND message = 'Float returned. You can now edit the Rent Plan.'
                             AND metadata->>'request_id' = v_req.id::text)
                  AND auth.uid() = e.agent_id);

    -- 3: double tap
    v_res2 := public.request_allocation_return(e.alloc_id, 'Test: tenant changed their mind about the unit');
    SELECT count(*) INTO v_cnt2 FROM public.general_ledger
     WHERE source_table = 'rent_requests' AND source_id = e.plan_id
       AND description ILIKE '%auto-approved agent send-back%';
    SELECT count(*) INTO v_cnt FROM public.agent_allocation_return_requests WHERE allocation_id = e.alloc_id;
    r := r || jsonb_build_object('step', '3 double tap: refused, one reversal, one request row',
          'pass', (v_res2->>'success')::boolean IS FALSE AND v_cnt2 = 2 AND v_cnt = 1,
          'detail', jsonb_build_object('second_call', v_res2, 'ledger_legs', v_cnt2, 'request_rows', v_cnt));

    -- 4: the agent who sent it back cannot approve any of the three stages
    v_ok := true;
    BEGIN
      UPDATE public.rent_requests SET status = 'tenant_ops_approved' WHERE id = e.plan_id;
      v_ok := false;
    EXCEPTION WHEN OTHERS THEN
      v_ok := (SQLSTATE = '42501' AND SQLERRM LIKE '%You sent this float back%');
    END;
    r := r || jsonb_build_object('step', '4a agent cannot approve Tenant Ops on own send-back', 'pass', v_ok);
    v_ok := true;
    BEGIN
      UPDATE public.rent_requests SET agent_ops_reviewed_by = e.agent_id, agent_ops_reviewed_at = now() WHERE id = e.plan_id;
      v_ok := false;
    EXCEPTION WHEN OTHERS THEN
      v_ok := (SQLSTATE = '42501' AND SQLERRM LIKE '%You sent this float back%');
    END;
    r := r || jsonb_build_object('step', '4b agent cannot stamp an Agent Ops review on own send-back', 'pass', v_ok);
    v_ok := true;
    BEGIN
      UPDATE public.rent_requests SET status = 'landlord_ops_approved' WHERE id = e.plan_id;
      v_ok := false;
    EXCEPTION WHEN OTHERS THEN
      v_ok := (SQLSTATE = '42501' AND SQLERRM LIKE '%You sent this float back%');
    END;
    r := r || jsonb_build_object('step', '4c agent cannot approve Landlord Ops on own send-back', 'pass', v_ok);

    -- 7: raising the amount sends the plan back to Agent Ops review
    v_res3 := public.agent_edit_sent_back_rent_plan(e.plan_id, v_old_rent + 50000, 'Test: corrected rent after the landlord visit');
    SELECT status INTO v_plan_status FROM public.rent_requests WHERE id = e.plan_id;
    r := r || jsonb_build_object('step', '7a raised amount goes back to Agent Ops review (pending)',
          'pass', (v_res3->>'success')::boolean AND v_plan_status = 'pending'
                  AND (SELECT rent_amount FROM public.rent_requests WHERE id = e.plan_id) = v_old_rent + 50000,
          'detail', v_res3);
    v_ok := true;
    BEGIN
      UPDATE public.rent_requests SET status = 'agent_ops_approved' WHERE id = e.plan_id;
      v_ok := false;
    EXCEPTION WHEN OTHERS THEN
      v_ok := (SQLSTATE = '42501');
    END;
    r := r || jsonb_build_object('step', '7b agent cannot approve the edited plan back through Agent Ops', 'pass', v_ok);
    v_res3 := public.agent_edit_sent_back_rent_plan(e.plan_id, v_old_rent + 90000, 'Test: second edit should be refused now');
    r := r || jsonb_build_object('step', '7c a second edit is refused once the plan is back in review',
          'pass', (v_res3->>'success')::boolean IS FALSE, 'detail', v_res3);

    RAISE EXCEPTION 'case_done';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'case_done' THEN
      r := r || jsonb_build_object('step', '1/3/4/7 block', 'pass', false, 'detail', SQLERRM);
    END IF;
  END;

  -- ── 2: payout already started -> falls back to the CFO ───────────────────
  IF p.alloc_id IS NOT NULL THEN
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', p.agent_id, 'role', 'authenticated')::text, true);
      v_res := public.request_allocation_return(p.alloc_id, 'Test: landlord asked for a different payout arrangement');
      SELECT * INTO v_req FROM public.agent_allocation_return_requests WHERE id = (v_res->>'request_id')::uuid;
      SELECT status INTO v_plan_status FROM public.rent_requests WHERE id = p.plan_id;
      SELECT status INTO v_alloc_status FROM public.agent_landlord_float_allocations WHERE id = p.alloc_id;
      SELECT count(*) INTO v_cnt FROM public.general_ledger
       WHERE source_table = 'rent_requests' AND source_id = p.plan_id AND description ILIKE '%send-back%';
      r := r || jsonb_build_object('step', '2a existing payout: pending for the CFO, nothing moved',
            'pass', (v_res->>'success')::boolean AND (v_res->>'auto_approved')::boolean IS FALSE
                    AND v_req.status = 'pending' AND NOT v_req.auto_approved
                    AND v_plan_status = 'funded' AND v_alloc_status = 'return_pending' AND v_cnt = 0
                    AND v_res->>'auto_approve_blocked_by' = 'payout_started',
            'detail', v_res);

      -- 2b: the CFO approve still works, through the shared helper
      SELECT st.user_id INTO v_cfo
        FROM public.hr_assignments a JOIN public.hr_staff st ON st.id = a.staff_id
       WHERE a.position_id = 'c0985816-85c2-41ea-ae89-a8d8a9c44e69'::uuid AND st.active
         AND a.started_on <= current_date AND (a.ended_on IS NULL OR a.ended_on > current_date)
       LIMIT 1;
      IF v_cfo IS NULL THEN
        SELECT s.user_id INTO v_cfo FROM public.pinned_finance_action_super_admins s
         WHERE public.has_role(s.user_id, 'super_admin'::public.app_role) LIMIT 1;
      END IF;
      IF v_cfo IS NULL THEN
        r := r || jsonb_build_object('step', '2b CFO approve through the helper', 'pass', NULL,
              'detail', 'skipped: no user passes can_act_pinned_finance_action');
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('sub', v_cfo, 'role', 'authenticated')::text, true);
        v_res2 := public.cfo_decide_allocation_return(v_req.id, 'approve', 'Test CFO approve');
        SELECT * INTO v_req FROM public.agent_allocation_return_requests WHERE id = v_req.id;
        SELECT status INTO v_plan_status FROM public.rent_requests WHERE id = p.plan_id;
        SELECT count(*) INTO v_cnt FROM public.general_ledger
         WHERE source_table = 'rent_requests' AND source_id = p.plan_id
           AND description LIKE '%CFO-approved allocation return%';
        r := r || jsonb_build_object('step', '2b CFO approve through the helper',
              'pass', (v_res2->>'success')::boolean AND v_req.status = 'approved' AND NOT v_req.auto_approved
                      AND v_req.cfo_id = v_cfo AND v_plan_status = 'agent_ops_approved' AND v_cnt = 2
                      AND EXISTS (SELECT 1 FROM public.audit_logs
                                   WHERE action_type = 'cfo_approve_allocation_return' AND record_id = v_req.id::text),
              'detail', v_res2);
      END IF;
      RAISE EXCEPTION 'case_done';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'case_done' THEN
        r := r || jsonb_build_object('step', '2 block', 'pass', false, 'detail', SQLERRM);
      END IF;
    END;
  ELSE
    r := r || jsonb_build_object('step', '2a existing payout', 'pass', NULL, 'detail', 'skipped: no funded plan with a payout found');
  END IF;

  -- ── 2c: a payout that was only started (otp_verified) also falls back ────
  BEGIN
    SELECT al.landlord_id, l.phone, COALESCE(l.name, 'Test landlord') INTO v_ll, v_phone, v_lname
      FROM public.agent_landlord_float_allocations al
      LEFT JOIN public.landlords l ON l.id = al.landlord_id WHERE al.id = e.alloc_id;
    INSERT INTO public.landlord_payouts (agent_id, landlord_id, rent_request_id, amount, landlord_phone,
                                         landlord_name, mobile_money_provider, status)
    VALUES (e.agent_id, v_ll, e.plan_id, e.amt, v_phone, v_lname, 'MTN', 'otp_verified');
    PERFORM set_config('request.jwt.claims', json_build_object('sub', e.agent_id, 'role', 'authenticated')::text, true);
    v_res := public.request_allocation_return(e.alloc_id, 'Test: payout was started but the agent wants to stop');
    r := r || jsonb_build_object('step', '2c started-only payout (otp_verified): pending for the CFO',
          'pass', (v_res->>'success')::boolean AND (v_res->>'auto_approved')::boolean IS FALSE,
          'detail', v_res);
    RAISE EXCEPTION 'case_done';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'case_done' THEN
      r := r || jsonb_build_object('step', '2c block', 'pass', false, 'detail', SQLERRM);
    END IF;
  END;

  RAISE EXCEPTION 'ROLLED BACK REPORT: %', jsonb_pretty(r);
END
$test$;
