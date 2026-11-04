-- "Allow selected" landlord payouts judges each agent on the money they collected against the money due, the same weekly rate the agent sees on
-- their Weekly Performance page (20261023130000 / 20261023140000), instead of the old 7-day rate with a flat 50% minimum.
--
-- WHICH WEEK: the rule week runs Thursday to Wednesday (Africa/Kampala). Payouts are allowed on Tuesday and Thursday.
--   * Friday to Wednesday (so every Tuesday): THIS WEEK SO FAR, Thursday up to today. Collected is capped per plan, due is what has been billed so far.
--     This is the "This week so far" card the agent sees.
--   * Thursday (the first day of a rule week): nothing has been billed yet this week, so the week that JUST ENDED is used. It reads the saved result the
--     posting gate uses (_agent_weekly_posting_result), so it is the agent's "Last week's result" card.
-- THE TARGET is the weekly posting rule's: current plans 50%; current plus expired plans 50% on current AND 20% on expired; only expired plans 70%;
-- nothing billed passes. Percentages are changed in agent_posting_rule_settings and flow through here.
--
-- WHAT CHANGES: the check that stops an under-target agent's payout being allowed (Allow selected) and the check that Allow with exception overrides,
-- the rate list the CTO screens read, and the rejection message each agent is sent. All now use agent_payout_weekly_performance(agent).
-- agent_collection_rate_7d is left as it was (other things may use it). The goal limit, claimability, approval codes and owner lock are untouched.
-- Needs 20261023130000, 20261023140000. Roll back with 20261025120000_landlord_payout_allow_uses_weekly_money_rate.rollback.sql.

CREATE OR REPLACE FUNCTION public.agent_payout_weekly_performance(p_agent_id uuid)
RETURNS TABLE(
  basis text, week_start date, week_end date, book text,
  in_window_due numeric, in_window_collected numeric, in_window_pct numeric, in_window_required_pct numeric,
  expired_due numeric, expired_collected numeric, expired_pct numeric, expired_required_pct numeric,
  expected numeric, collected numeric, rate_pct numeric, passes boolean, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_cur date := public._agent_rule_week_start((now() AT TIME ZONE 'Africa/Kampala')::date);
  v_s public.agent_posting_rule_settings;
  v_r public.agent_weekly_posting_eligibility;
  v_in_due numeric := 0; v_in_got numeric := 0; v_ex_due numeric := 0; v_ex_got numeric := 0;
  v_in_req numeric; v_ex_req numeric; v_wk date; v_basis text; v_pass boolean; v_book text; v_reason text; v_label text;
BEGIN
  SELECT * INTO v_s FROM public.agent_posting_rule_settings WHERE id;

  IF v_today = v_cur THEN
    -- First day of the rule week: nothing is billed yet, so judge the week that just ended, exactly as the posting gate does.
    v_basis := 'last_week'; v_wk := v_cur - 7;
    v_r := public._agent_weekly_posting_result(p_agent_id);
    IF v_r.agent_id IS NULL THEN
      v_in_due := 0; v_ex_due := 0; v_book := 'none'; v_pass := true;
      v_reason := 'Nothing was billed on your Rent Plans last week.';
    ELSE
      v_in_due := COALESCE(v_r.in_window_due, 0); v_in_got := COALESCE(v_r.in_window_collected, 0);
      v_ex_due := COALESCE(v_r.expired_due, 0);   v_ex_got := COALESCE(v_r.expired_collected, 0);
      v_in_req := v_r.in_window_required_pct; v_ex_req := v_r.expired_required_pct;
      v_book := v_r.book; v_pass := COALESCE(v_r.passes, true); v_reason := v_r.reason;
    END IF;
  ELSE
    v_basis := 'week_so_far'; v_wk := v_cur;
    SELECT COALESCE(sum(l.due) FILTER (WHERE NOT l.expired), 0), COALESCE(sum(l.collected) FILTER (WHERE NOT l.expired), 0),
           COALESCE(sum(l.due) FILTER (WHERE l.expired), 0),     COALESCE(sum(l.collected) FILTER (WHERE l.expired), 0)
      INTO v_in_due, v_in_got, v_ex_due, v_ex_got
      FROM public._agent_weekly_plan_lines(p_agent_id, v_cur, v_today) l;
    v_in_req := CASE WHEN v_in_due > 0 THEN v_s.in_window_required_pct END;
    v_ex_req := CASE WHEN v_ex_due > 0 AND v_in_due > 0 THEN v_s.expired_required_pct
                     WHEN v_ex_due > 0 THEN v_s.all_expired_required_pct END;
    v_book := CASE WHEN v_in_due > 0 AND v_ex_due > 0 THEN 'mixed' WHEN v_in_due > 0 THEN 'in_window_only'
                   WHEN v_ex_due > 0 THEN 'all_expired' ELSE 'none' END;
    v_pass := (v_in_due = 0 OR v_in_got >= v_in_req * v_in_due) AND (v_ex_due = 0 OR v_ex_got >= v_ex_req * v_ex_due);
    v_label := 'This week so far (' || to_char(v_cur, 'FMDD Mon') || ' to ' || to_char(v_today, 'FMDD Mon') || ')';
    v_reason := CASE WHEN v_book = 'none' THEN 'Nothing has been billed on your Rent Plans this week yet.' ELSE
        v_label || ' you collected '
        || CASE WHEN v_in_due > 0 THEN round(100 * v_in_got / v_in_due, 1)::text || '% of what your current Rent Plans were due (UGX '
             || to_char(v_in_got, 'FM999,999,999,999') || ' of UGX ' || to_char(v_in_due, 'FM999,999,999,999') || '). You need '
             || round(100 * v_in_req)::text || '%.' ELSE '' END
        || CASE WHEN v_in_due > 0 AND v_ex_due > 0 THEN ' On your expired Rent Plans you collected ' ELSE '' END
        || CASE WHEN v_ex_due > 0 THEN round(100 * v_ex_got / v_ex_due, 1)::text || '% of what they were due (UGX ' || to_char(v_ex_got, 'FM999,999,999,999')
             || ' of UGX ' || to_char(v_ex_due, 'FM999,999,999,999') || '). You need ' || round(100 * v_ex_req)::text || '%.' ELSE '' END
      END;
  END IF;

  RETURN QUERY SELECT v_basis, v_wk, v_wk + 6, v_book,
    v_in_due, v_in_got, CASE WHEN v_in_due > 0 THEN round(100.0 * v_in_got / v_in_due, 1) END, CASE WHEN v_in_due > 0 THEN round(100 * v_in_req, 1) END,
    v_ex_due, v_ex_got, CASE WHEN v_ex_due > 0 THEN round(100.0 * v_ex_got / v_ex_due, 1) END, CASE WHEN v_ex_due > 0 THEN round(100 * v_ex_req, 1) END,
    v_in_due + v_ex_due, v_in_got + v_ex_got,
    CASE WHEN v_in_due + v_ex_due > 0 THEN round(100.0 * (v_in_got + v_ex_got) / (v_in_due + v_ex_due), 1) END,
    v_pass, v_reason;
END;
$function$;
REVOKE ALL ON FUNCTION public.agent_payout_weekly_performance(uuid) FROM PUBLIC, anon, authenticated;

-- The rate list the CTO / CFO screens read. Old columns stay (rate_pct is now the weekly money rate, meets_minimum is "meets this week's target").
DROP FUNCTION IF EXISTS public.get_landlord_payout_agent_rates();
CREATE FUNCTION public.get_landlord_payout_agent_rates()
RETURNS TABLE(agent_id uuid, expected numeric, collected numeric, rate_pct numeric, meets_minimum boolean,
              basis text, week_start date, week_end date, book text,
              in_window_due numeric, in_window_collected numeric, in_window_pct numeric, in_window_required_pct numeric,
              expired_due numeric, expired_collected numeric, expired_pct numeric, expired_required_pct numeric, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'cto'::app_role)
       OR public.has_role(auth.uid(), 'cfo'::app_role)
       OR public.has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT a.user_id, r.expected, r.collected, r.rate_pct, r.passes,
         r.basis, r.week_start, r.week_end, r.book,
         r.in_window_due, r.in_window_collected, r.in_window_pct, r.in_window_required_pct,
         r.expired_due, r.expired_collected, r.expired_pct, r.expired_required_pct, r.reason
    FROM (SELECT DISTINCT w.user_id
            FROM public.withdrawal_requests w
           WHERE w.landlord_payout_id IS NOT NULL AND w.assigned_cashout_agent_id IS NULL
             AND w.processed_at IS NULL AND w.fin_ops_reference IS NULL) a
   CROSS JOIN LATERAL public.agent_payout_weekly_performance(a.user_id) r;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_landlord_payout_agent_rates() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_landlord_payout_agent_rates() TO authenticated;

-- Allow selected: an agent who is under this week's target is not allowed through and is told why.
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

-- Allow with exception: the payouts it overrides are the ones under this week's target; the audit row keeps the weekly figures.
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
    SELECT v_uid, 'landlord_payout_allowed_with_exception', 'Allowed landlord payout with exception: agent under the weekly collection target',
           'withdrawal_requests', w.id::text,
           jsonb_build_object('agent_id', w.user_id, 'rate_pct', r.rate_pct, 'expected', r.expected, 'collected', r.collected,
                              'basis', r.basis, 'week_start', r.week_start, 'detail', r.reason, 'reason', v_reason)
      FROM public.withdrawal_requests w
     CROSS JOIN LATERAL public.agent_payout_weekly_performance(w.user_id) r
     WHERE w.id = ANY (p_withdrawal_ids) AND w.landlord_payout_id IS NOT NULL AND w.assigned_cashout_agent_id IS NULL
       AND w.processed_at IS NULL AND w.fin_ops_reference IS NULL AND w.landlord_block_exempt_at IS NULL
       AND NOT r.passes;

    PERFORM set_config('welile.landlord_rate_exception', 'on', true);
    v_n := public.set_landlord_payout_block_exemption(p_withdrawal_ids, true);
    PERFORM set_config('welile.landlord_rate_exception', 'off', true);
    RETURN v_n;
  END;
  $function$;

-- Reject with message: the standard reason is now the agent's weekly money rate.
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
      SELECT * INTO v_rate FROM public.agent_payout_weekly_performance(v_agent.user_id);
      v_body := CASE WHEN v_agent.n = 1 THEN 'Management has not released your landlord payout of UGX ' ELSE 'Management has not released your ' || v_agent.n || ' landlord payouts, UGX ' END
                || to_char(v_agent.total, 'FM999,999,999,999') || '. '
                || COALESCE(
                     v_custom,
                     CASE WHEN v_rate.rate_pct IS NOT NULL
                          THEN v_rate.reason || ' Management only releases landlord payouts to agents who reach the weekly collection target. Collect more and your payout can be released.'
                          ELSE 'You did not meet the requirements for landlord payouts to be released. Management only releases landlord payouts to agents who reach the weekly collection target.'
                     END);
      INSERT INTO public.notifications (user_id, title, message, type, metadata, event_key)
      VALUES (v_agent.user_id, 'Landlord payout not released', v_body, 'warning',
              jsonb_build_object('kind', 'landlord_payout_rejected', 'withdrawal_ids', to_jsonb(v_agent.ids), 'rate_pct', v_rate.rate_pct, 'basis', v_rate.basis, 'custom_message', v_custom IS NOT NULL),
              'landlord_payout_rejected:' || v_agent.user_id::text || ':' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'));
      INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
      SELECT v_uid, 'landlord_payout_rejected', 'Rejected landlord payout and told the agent why', 'withdrawal_requests', i::text,
             jsonb_build_object('agent_id', v_agent.user_id, 'rate_pct', v_rate.rate_pct, 'basis', v_rate.basis, 'message', v_body)
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
