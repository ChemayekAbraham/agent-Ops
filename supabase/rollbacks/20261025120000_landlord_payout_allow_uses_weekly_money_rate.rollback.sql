-- Puts the old 7-day rate (flat 50% minimum, agent_collection_rate_7d) back behind Allow selected, Allow with exception, Reject with message
-- and the rate list. Bodies are the ones that were live before 20261025120000.

DROP FUNCTION IF EXISTS public.get_landlord_payout_agent_rates();
CREATE FUNCTION public.get_landlord_payout_agent_rates()
RETURNS TABLE(agent_id uuid, expected numeric, collected numeric, rate_pct numeric, meets_minimum boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'cto'::app_role) OR public.has_role(auth.uid(), 'cfo'::app_role) OR public.has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT a.user_id, r.expected, r.collected, r.rate_pct, (r.rate_pct IS NULL OR r.rate_pct >= 50)
    FROM (SELECT DISTINCT w.user_id FROM public.withdrawal_requests w
           WHERE w.landlord_payout_id IS NOT NULL AND w.assigned_cashout_agent_id IS NULL AND w.processed_at IS NULL AND w.fin_ops_reference IS NULL) a
   CROSS JOIN LATERAL public.agent_collection_rate_7d(a.user_id) r;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_landlord_payout_agent_rates() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_landlord_payout_agent_rates() TO authenticated;

CREATE OR REPLACE FUNCTION public.set_landlord_payout_block_exemption_unchecked(p_withdrawal_ids uuid[], p_allow boolean)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
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
        SELECT w.id, w.user_id, w.amount, r.rate_pct, r.expected, r.collected
          FROM public.withdrawal_requests w
         CROSS JOIN LATERAL public.agent_collection_rate_7d(w.user_id) r
         WHERE w.id = ANY (p_withdrawal_ids) AND w.landlord_payout_id IS NOT NULL AND w.assigned_cashout_agent_id IS NULL
           AND w.processed_at IS NULL AND w.fin_ops_reference IS NULL AND w.landlord_block_exempt_at IS NULL
           AND r.rate_pct IS NOT NULL AND r.rate_pct < 50
           AND COALESCE(current_setting('welile.landlord_rate_exception', true), '') <> 'on'
      LOOP
        v_target := array_remove(v_target, v_rejected.id);
        INSERT INTO public.notifications (user_id, title, message, type, metadata, event_key)
        VALUES (
          v_rejected.user_id,
          'Landlord payout not released',
          'Management has not released your landlord payout of UGX ' || to_char(v_rejected.amount, 'FM999,999,999,999') || '. Your collection rate over the last 7 days is '
            || v_rejected.rate_pct::text || '% (UGX ' || to_char(v_rejected.collected, 'FM999,999,999,999') || ' collected of UGX '
            || to_char(v_rejected.expected, 'FM999,999,999,999') || ' expected). Management only releases landlord payouts to agents who collect at least 50% over the last 7 days. Collect more and your payout can be released.',
          'warning',
          jsonb_build_object('kind', 'landlord_payout_rejected', 'withdrawal_id', v_rejected.id, 'rate_pct', v_rejected.rate_pct, 'minimum_pct', 50),
          'landlord_payout_rejected:' || v_rejected.id::text || ':' || to_char(now() AT TIME ZONE 'Africa/Kampala', 'YYYY-MM-DD')
        );
        INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
        VALUES (v_uid, 'landlord_payout_block_rejected', 'Landlord payout not allowed: agent below 50% collection over 7 days',
                'withdrawal_requests', v_rejected.id::text,
                jsonb_build_object('agent_id', v_rejected.user_id, 'rate_pct', v_rejected.rate_pct, 'expected', v_rejected.expected, 'collected', v_rejected.collected));
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

CREATE OR REPLACE FUNCTION public.allow_landlord_payouts_with_exception_unchecked(p_withdrawal_ids uuid[], p_reason text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
  DECLARE
    v_uid uuid := auth.uid();
    v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
    v_n integer;
  BEGIN
    IF NOT (public.has_role(v_uid, 'cto'::app_role) OR public.has_role(v_uid, 'cfo'::app_role) OR public.has_role(v_uid, 'super_admin'::app_role)) THEN
      RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
    END IF;
    IF p_withdrawal_ids IS NULL OR cardinality(p_withdrawal_ids) = 0 THEN RETURN 0; END IF;
    IF v_reason IS NULL OR char_length(v_reason) < 5 THEN
      RAISE EXCEPTION 'Give the reason for the exception (at least 5 characters).';
    END IF;
    IF char_length(v_reason) > 600 THEN
      RAISE EXCEPTION 'The reason is too long (600 characters at most).';
    END IF;

    INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
    SELECT v_uid, 'landlord_payout_allowed_with_exception', 'Allowed landlord payout with exception: agent below 50% collection over 7 days',
           'withdrawal_requests', w.id::text,
           jsonb_build_object('agent_id', w.user_id, 'rate_pct', r.rate_pct, 'expected', r.expected, 'collected', r.collected, 'reason', v_reason)
      FROM public.withdrawal_requests w
     CROSS JOIN LATERAL public.agent_collection_rate_7d(w.user_id) r
     WHERE w.id = ANY (p_withdrawal_ids) AND w.landlord_payout_id IS NOT NULL AND w.assigned_cashout_agent_id IS NULL
       AND w.processed_at IS NULL AND w.fin_ops_reference IS NULL AND w.landlord_block_exempt_at IS NULL
       AND r.rate_pct IS NOT NULL AND r.rate_pct < 50;

    PERFORM set_config('welile.landlord_rate_exception', 'on', true);
    v_n := public.set_landlord_payout_block_exemption(p_withdrawal_ids, true);
    PERFORM set_config('welile.landlord_rate_exception', 'off', true);
    RETURN v_n;
  END;
  $function$;

CREATE OR REPLACE FUNCTION public.reject_landlord_payouts(p_withdrawal_ids uuid[], p_message text DEFAULT NULL::text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
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
      FOREACH v_wd IN ARRAY v_agent.ids LOOP
        PERFORM public._file_allocation_return_for_rejected_payout(v_wd, v_uid, 'Landlord payout rejected by management. ' || COALESCE(v_custom, ''));
      END LOOP;
      v_count := v_count + v_agent.n;
    END LOOP;
    RETURN v_count;
  END;
  $function$;

DROP FUNCTION IF EXISTS public.agent_payout_weekly_performance(uuid);
