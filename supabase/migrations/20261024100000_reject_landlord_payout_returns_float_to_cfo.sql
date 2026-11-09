-- "Reject with message" on landlord payouts now sends the float back to the CFO.
--
-- BEFORE: reject_landlord_payouts only hid the payouts from the merchant queue and messaged the agent. The landlord float that funded each payout
-- stayed open with the agent (18 payouts rejected since 20 Oct = UGX 7,890,000 still sitting in open allocations).
--
-- NOW, for each rejected payout the agent's OPEN float allocation for that rent plan (nothing paid out of it yet) is returned to the CFO through
-- the existing allocation-return flow (agent_allocation_return_requests -> _complete_allocation_return: balanced ledger legs, funding reversal,
-- the agent's landlord float reduced, the allocation cancelled, the plan back from funded to agent_ops_approved):
--   * if the person rejecting is the CFO (or a super admin pinned for finance actions: can_act_pinned_finance_action), the float is returned at once;
--   * otherwise (the CTO, for example) a return request is FILED and the allocation is held as 'return_pending' so the agent cannot spend it, and the
--     CFO approves it in the usual place (cfo_decide_allocation_return). Returning landlord float is a CFO-only action in this system by design; a
--     rejection by anyone else does not bypass that.
-- An allocation that has had money paid out of it, is not open, or already has a pending return is left alone.
--
-- Also here: a one-off catch-up that FILES the same return requests (for the CFO to approve) for the payouts already rejected since 20 Oct.
-- Safe to re-run. Roll back with 20261024100000_reject_landlord_payout_returns_float_to_cfo.rollback.sql.

CREATE OR REPLACE FUNCTION public._file_allocation_return_for_rejected_payout(p_withdrawal_id uuid, p_decider uuid, p_reason text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_agent uuid; v_plan uuid; v_alloc public.agent_landlord_float_allocations%ROWTYPE; v_req uuid;
BEGIN
  SELECT w.user_id, lp.rent_request_id INTO v_agent, v_plan
    FROM public.withdrawal_requests w JOIN public.landlord_payouts lp ON lp.id = w.landlord_payout_id
   WHERE w.id = p_withdrawal_id;
  IF v_plan IS NULL THEN RETURN 'no_plan'; END IF;

  SELECT * INTO v_alloc FROM public.agent_landlord_float_allocations a
   WHERE a.rent_request_id = v_plan AND a.agent_id = v_agent AND a.status = 'open'
     AND COALESCE(a.paid_out_amount, 0) = 0 AND COALESCE(a.remaining_amount, 0) > 0
   ORDER BY a.created_at LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN 'no_open_allocation'; END IF;
  IF EXISTS (SELECT 1 FROM public.agent_allocation_return_requests q WHERE q.allocation_id = v_alloc.id AND q.status = 'pending') THEN
    RETURN 'already_pending';
  END IF;

  INSERT INTO public.agent_allocation_return_requests (agent_id, allocation_id, rent_request_id, landlord_id, landlord_name, amount, reason)
  VALUES (v_alloc.agent_id, v_alloc.id, v_alloc.rent_request_id, v_alloc.landlord_id, v_alloc.landlord_name, v_alloc.remaining_amount, left(p_reason, 500))
  RETURNING id INTO v_req;

  IF p_decider IS NOT NULL AND public.can_act_pinned_finance_action(p_decider) THEN
    PERFORM public._complete_allocation_return(v_req, p_decider, 'Landlord payout rejected by management', false);
    RETURN 'returned';
  END IF;

  UPDATE public.agent_landlord_float_allocations SET status = 'return_pending', updated_at = now() WHERE id = v_alloc.id;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (p_decider, 'landlord_payout_rejected_float_return_filed', 'agent_allocation_return_requests', v_req::text,
          jsonb_build_object('withdrawal_id', p_withdrawal_id, 'allocation_id', v_alloc.id, 'amount', v_alloc.remaining_amount));
  RETURN 'filed_for_cfo';
END;
$function$;
REVOKE ALL ON FUNCTION public._file_allocation_return_for_rejected_payout(uuid, uuid, text) FROM PUBLIC, anon, authenticated;

-- Reject with message: same as before, plus the float return for each rejected payout.
CREATE OR REPLACE FUNCTION public.reject_landlord_payouts(p_withdrawal_ids uuid[], p_message text DEFAULT NULL::text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  DECLARE
    v_uid uuid := auth.uid();
    v_custom text := NULLIF(btrim(COALESCE(p_message, '')), '');
    v_agent record;
    v_rate record;
    v_body text;
    v_count integer := 0;
    v_wd uuid;
  BEGIN
  PERFORM public.require_staff_aal2();
    IF NOT (public.has_role(v_uid, 'cto'::app_role) OR public.has_role(v_uid, 'cfo'::app_role) OR public.has_role(v_uid, 'super_admin'::app_role)) THEN
      RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
    END IF;
    IF p_withdrawal_ids IS NULL OR cardinality(p_withdrawal_ids) = 0 THEN RETURN 0; END IF;
    IF v_custom IS NOT NULL AND char_length(v_custom) > 600 THEN
      RAISE EXCEPTION 'The message is too long (600 characters at most).';
    END IF;

    FOR v_agent IN
      SELECT w.user_id, count(*) AS n, sum(w.amount) AS total, array_agg(w.id) AS ids
        FROM public.withdrawal_requests w
       WHERE w.id = ANY (p_withdrawal_ids) AND w.landlord_payout_id IS NOT NULL AND w.assigned_cashout_agent_id IS NULL
         AND w.processed_at IS NULL AND w.fin_ops_reference IS NULL AND w.landlord_block_exempt_at IS NULL
       GROUP BY w.user_id
    LOOP
      SELECT * INTO v_rate FROM public.agent_collection_rate_7d(v_agent.user_id);
      v_body := CASE WHEN v_agent.n = 1 THEN 'Management has not released your landlord payout of UGX ' ELSE 'Management has not released your ' || v_agent.n || ' landlord payouts, UGX ' END
                || to_char(v_agent.total, 'FM999,999,999,999') || '. '
                || COALESCE(
                     v_custom,
                     CASE WHEN v_rate.rate_pct IS NOT NULL
                          THEN 'Your collection rate over the last 7 days is ' || v_rate.rate_pct::text || '% (UGX ' || to_char(v_rate.collected, 'FM999,999,999,999')
                               || ' collected of UGX ' || to_char(v_rate.expected, 'FM999,999,999,999') || ' expected). Management only releases landlord payouts to agents who collect at least 50% over the last 7 days. Collect more and your payout can be released.'
                          ELSE 'You did not meet the requirements for landlord payouts to be released. Management only releases landlord payouts to agents who collect at least 50% over the last 7 days.'
                     END);
      INSERT INTO public.notifications (user_id, title, message, type, metadata, event_key)
      VALUES (v_agent.user_id, 'Landlord payout not released', v_body, 'warning',
              jsonb_build_object('kind', 'landlord_payout_rejected', 'withdrawal_ids', to_jsonb(v_agent.ids), 'rate_pct', v_rate.rate_pct, 'minimum_pct', 50, 'custom_message', v_custom IS NOT NULL),
              'landlord_payout_rejected:' || v_agent.user_id::text || ':' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'));
      INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
      SELECT v_uid, 'landlord_payout_rejected', 'Rejected landlord payout and told the agent why', 'withdrawal_requests', i::text,
             jsonb_build_object('agent_id', v_agent.user_id, 'rate_pct', v_rate.rate_pct, 'message', v_body)
        FROM unnest(v_agent.ids) AS i;
      UPDATE public.withdrawal_requests
         SET hidden_from_merchant_queue = true, hidden_from_merchant_queue_at = now(), hidden_from_merchant_queue_by = v_uid
       WHERE id = ANY (v_agent.ids);
      -- New: send the float that funded each rejected payout back to the CFO.
      FOREACH v_wd IN ARRAY v_agent.ids LOOP
        PERFORM public._file_allocation_return_for_rejected_payout(v_wd, v_uid, 'Landlord payout rejected by management. ' || COALESCE(v_custom, ''));
      END LOOP;
      v_count := v_count + v_agent.n;
    END LOOP;
    RETURN v_count;
  END;
  $function$;

-- One-off catch-up: FILE the returns (for the CFO to approve) for payouts already rejected since 20 Oct whose float is still open with the agent.
DO $catch$
DECLARE r record; v_out text; v_filed int := 0; v_skipped int := 0;
BEGIN
  FOR r IN
    SELECT w.id FROM public.withdrawal_requests w
     WHERE w.landlord_payout_id IS NOT NULL AND w.status = 'rejected' AND w.created_at >= '2026-10-20'
  LOOP
    v_out := public._file_allocation_return_for_rejected_payout(r.id, NULL, 'Landlord payout rejected by management');
    IF v_out = 'filed_for_cfo' THEN v_filed := v_filed + 1; ELSE v_skipped := v_skipped + 1; END IF;
  END LOOP;
  RAISE NOTICE 'Catch-up: % return requests filed for the CFO, % skipped', v_filed, v_skipped;
END
$catch$;
