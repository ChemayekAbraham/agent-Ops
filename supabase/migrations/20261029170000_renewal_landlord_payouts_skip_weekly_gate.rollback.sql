-- Rollback of 20261029170000_renewal_landlord_payouts_skip_weekly_gate.sql (doc 250).
-- Restores the two function bodies exactly as production had them on 2026-10-29, then drops the helper.
-- Audit rows already written (landlord_gate_renewal_skip) stay: audit_logs is append-only history.

CREATE OR REPLACE FUNCTION public.enforce_landlord_float_performance_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r record;
BEGIN
  IF NEW.landlord_payout_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO r FROM public.agent_payout_weekly_performance(NEW.user_id);
  IF r.passes IS NOT FALSE THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.landlord_float_withdrawal_exceptions e
              WHERE e.agent_id = NEW.user_id AND e.week_start = public.current_welile_week_start(now())) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '%', public.landlord_float_blocked_message(NEW.user_id, NEW.amount) USING ERRCODE = 'P0001';
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_landlord_payout_block_exemption_unchecked(p_withdrawal_ids uuid[], p_allow boolean)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  DECLARE
    v_uid uuid := auth.uid();
    v_ids uuid[]; v_enabled boolean; v_value text; v_budget numeric; v_allowed numeric; v_selected numeric; v_since text;
    v_target uuid[] := p_withdrawal_ids;
    v_rejected record;
  BEGIN
  PERFORM public.require_staff_aal2();
    IF NOT (public.has_role(v_uid, 'cto'::app_role) OR public.has_role(v_uid, 'cfo'::app_role) OR public.has_role(v_uid, 'super_admin'::app_role)) THEN
      RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
    END IF;
    IF p_withdrawal_ids IS NULL OR cardinality(p_withdrawal_ids) = 0 THEN RETURN 0; END IF;

    IF p_allow THEN
      FOR v_rejected IN
        SELECT w.id, w.user_id, w.amount, r.rate_pct, r.expected, r.collected, r.reason, r.basis
          FROM public.withdrawal_requests w
         CROSS JOIN LATERAL public.agent_payout_weekly_performance(w.user_id) r
         WHERE w.id = ANY (p_withdrawal_ids) AND w.landlord_payout_id IS NOT NULL AND w.assigned_cashout_agent_id IS NULL
           AND w.processed_at IS NULL AND w.fin_ops_reference IS NULL AND w.landlord_block_exempt_at IS NULL
           AND NOT r.passes
           AND COALESCE(current_setting('welile.landlord_rate_exception', true), '') <> 'on'
      LOOP
        v_target := array_remove(v_target, v_rejected.id);
        INSERT INTO public.notifications (user_id, title, message, type, metadata, event_key)
        VALUES (
          v_rejected.user_id,
          'Landlord payout not released',
          'Management has not released your landlord payout of UGX ' || to_char(v_rejected.amount, 'FM999,999,999,999') || '. ' || v_rejected.reason
            || ' Management only releases landlord payouts to agents who reach the weekly collection target. Collect more and your payout can be released.',
          'warning',
          jsonb_build_object('kind', 'landlord_payout_rejected', 'withdrawal_id', v_rejected.id, 'rate_pct', v_rejected.rate_pct, 'basis', v_rejected.basis),
          'landlord_payout_rejected:' || v_rejected.id::text || ':' || to_char(now() AT TIME ZONE 'Africa/Kampala', 'YYYY-MM-DD')
        );
        INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
        VALUES (v_uid, 'landlord_payout_block_rejected', 'Landlord payout not allowed: agent under the weekly collection target',
                'withdrawal_requests', v_rejected.id::text,
                jsonb_build_object('agent_id', v_rejected.user_id, 'rate_pct', v_rejected.rate_pct, 'expected', v_rejected.expected,
                                   'collected', v_rejected.collected, 'basis', v_rejected.basis, 'reason', v_rejected.reason));
      END LOOP;
      IF cardinality(v_target) = 0 THEN RETURN 0; END IF;

      SELECT c.enabled, c.value INTO v_enabled, v_value FROM public.treasury_controls c WHERE c.control_key = 'landlord_payout_daily_budget' FOR UPDATE;
      v_budget := NULLIF(btrim(COALESCE(v_value, '')), '')::numeric;
      IF COALESCE(v_enabled, false) AND v_budget IS NOT NULL AND v_budget > 0 THEN
        v_allowed := public.landlord_payout_goal_allowed();
        v_since := to_char(public.landlord_payout_goal_started_at() AT TIME ZONE 'Africa/Kampala', 'DD Mon YYYY');
        SELECT COALESCE(SUM(w.amount), 0) INTO v_selected FROM public.withdrawal_requests w
         WHERE w.id = ANY (v_target) AND w.landlord_payout_id IS NOT NULL AND w.assigned_cashout_agent_id IS NULL
           AND w.processed_at IS NULL AND w.fin_ops_reference IS NULL AND w.landlord_block_exempt_at IS NULL;
        IF v_selected > 0 AND v_allowed + v_selected > v_budget THEN
          IF v_allowed >= v_budget THEN
            RAISE EXCEPTION 'The landlord payout goal of UGX % is reached (UGX % allowed since %). No more payouts can be allowed until you raise the goal, start a new one, or re-block some to free room.',
              to_char(v_budget, 'FM999,999,999,999'), to_char(v_allowed, 'FM999,999,999,999'), v_since;
          END IF;
          RAISE EXCEPTION 'Over the landlord payout goal: UGX % of UGX % is already allowed (since %), so only UGX % is left, and this selection is UGX %. Allow fewer payouts, or raise the goal.',
            to_char(v_allowed, 'FM999,999,999,999'), to_char(v_budget, 'FM999,999,999,999'), v_since,
            to_char(v_budget - v_allowed, 'FM999,999,999,999'), to_char(v_selected, 'FM999,999,999,999');
        END IF;
      END IF;
    END IF;

    WITH upd AS (
      UPDATE public.withdrawal_requests w
         SET landlord_block_exempt_at = CASE WHEN p_allow THEN now() ELSE NULL END,
             landlord_block_exempt_by = CASE WHEN p_allow THEN v_uid ELSE NULL END
       WHERE w.id = ANY (v_target) AND w.landlord_payout_id IS NOT NULL AND w.assigned_cashout_agent_id IS NULL
         AND w.processed_at IS NULL AND w.fin_ops_reference IS NULL AND (w.landlord_block_exempt_at IS NULL) = p_allow
      RETURNING w.id
    )
    SELECT array_agg(id) INTO v_ids FROM upd;
    IF v_ids IS NOT NULL THEN
      INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
      SELECT v_uid,
             CASE WHEN p_allow THEN 'landlord_payout_block_exempt' ELSE 'landlord_payout_block_unexempt' END,
             CASE WHEN p_allow THEN 'Allowed landlord payout through queue block' ELSE 'Re-blocked landlord payout' END,
             'withdrawal_requests', id::text,
             jsonb_build_object('landlord_payouts_blocked', public.landlord_payouts_blocked_from_queue())
        FROM unnest(v_ids) AS id;
    END IF;
    RETURN COALESCE(cardinality(v_ids), 0);
  END;
  $function$;

DROP FUNCTION IF EXISTS public.landlord_payout_is_renewal(uuid);
