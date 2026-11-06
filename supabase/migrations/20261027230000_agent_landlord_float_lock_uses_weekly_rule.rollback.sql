-- Puts the agent's landlord float lock back on agent_payout_collection_rate (rolling 7 days unless landlord_gate_weekly_mode is on) with the flat 50% minimum.

CREATE OR REPLACE FUNCTION public.landlord_float_lock_message(p_agent_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE r record; d1 text; d2 text;
BEGIN
  SELECT * INTO r FROM public.agent_payout_collection_rate(p_agent_id);
  IF r.basis = 'rolling_7d' THEN
    RETURN 'Landlord float is locked. Your collection rate over the last 7 days is ' || r.rate_pct::text || '% (UGX ' || to_char(r.collected, 'FM999,999,999,999')
        || ' collected of UGX ' || to_char(r.expected, 'FM999,999,999,999') || ' due), below the 50% minimum. Collect UGX '
        || to_char(r.shortfall_to_50, 'FM999,999,999,999') || ' more to unlock it.';
  END IF;
  d1 := to_char(r.week_start, 'Dy DD Mon'); d2 := to_char(r.week_end, 'Dy DD Mon');
  IF r.basis = 'last_week_final' THEN
    RETURN 'Landlord float is locked. A new week started on ' || d1 || ' and your final rate for last week was ' || r.rate_pct::text
        || '%, below the 50% minimum. Your rate for this week is counted from 12:00 on Thursday or your first collection, whichever comes first. The week resets every Thursday.';
  END IF;
  RETURN 'Landlord float is locked. This week (' || d1 || chr(8211) || d2 || ') you have collected UGX ' || to_char(r.collected, 'FM999,999,999,999')
      || ' of UGX ' || to_char(r.expected, 'FM999,999,999,999') || ' due so far (' || r.rate_pct::text || '%), below the 50% minimum. Collect UGX '
      || to_char(r.shortfall_to_50, 'FM999,999,999,999') || ' more to unlock it. The week resets every Thursday.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.landlord_float_blocked_message(p_agent_id uuid, p_amount numeric)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE r record; amt text := to_char(COALESCE(p_amount, 0), 'FM999,999,999,999'); d1 text; d2 text;
BEGIN
  SELECT * INTO r FROM public.agent_payout_collection_rate(p_agent_id);
  IF r.basis = 'rolling_7d' THEN
    RETURN 'Management has not released your landlord payout' || CASE WHEN COALESCE(p_amount, 0) > 0 THEN ' of UGX ' || amt ELSE '' END || '. Your collection rate over the last 7 days is ' || r.rate_pct::text
        || '% (UGX ' || to_char(r.collected, 'FM999,999,999,999') || ' collected of UGX ' || to_char(r.expected, 'FM999,999,999,999')
        || ' expected). Management only releases landlord payouts to agents who collect at least 50% over the last 7 days. Collect more and your payout can be released.';
  END IF;
  d1 := to_char(r.week_start, 'Dy DD Mon'); d2 := to_char(r.week_end, 'Dy DD Mon');
  IF r.basis = 'last_week_final' THEN
    RETURN 'Management has not released your landlord payout' || CASE WHEN COALESCE(p_amount, 0) > 0 THEN ' of UGX ' || amt ELSE '' END || '. A new week started on ' || d1 || ' and your final rate for last week was '
        || r.rate_pct::text || '%, under the 50% minimum. Your rate for this week is counted from 12:00 on Thursday or your first collection, whichever comes first. Collect UGX '
        || to_char(r.shortfall_to_50, 'FM999,999,999,999') || ' or more this week and your payout can be released. The week resets every Thursday.';
  END IF;
  RETURN 'Management has not released your landlord payout' || CASE WHEN COALESCE(p_amount, 0) > 0 THEN ' of UGX ' || amt ELSE '' END || '. This week (' || d1 || chr(8211) || d2 || ') you have collected UGX '
      || to_char(r.collected, 'FM999,999,999,999') || ' of UGX ' || to_char(r.expected, 'FM999,999,999,999') || ' due so far (' || r.rate_pct::text
      || '%). Collect UGX ' || to_char(r.shortfall_to_50, 'FM999,999,999,999') || ' more to reach 50% and your payout can be released. The week resets every Thursday.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_landlord_float_performance_gate()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE r record;
BEGIN
  IF NEW.landlord_payout_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO r FROM public.agent_payout_collection_rate(NEW.user_id);
  IF r.rate_pct IS NULL OR r.rate_pct >= 50 THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.landlord_float_withdrawal_exceptions e
              WHERE e.agent_id = NEW.user_id AND e.week_start = public.current_welile_week_start(now())) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '%', public.landlord_float_blocked_message(NEW.user_id, NEW.amount) USING ERRCODE = 'P0001';
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_landlord_float_gate(p_agent_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(agent_id uuid, locked boolean, block_reason text, basis text, week_start date, week_end date, expected numeric, collected numeric, rate_pct numeric, shortfall_to_50 numeric, exception_reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_target uuid := COALESCE(p_agent_id, auth.uid());
  v_ex text;
  v_locked boolean;
  r record;
BEGIN
  IF v_target IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  IF v_target <> auth.uid() AND NOT (
       public.has_role(auth.uid(), 'cfo'::app_role) OR public.has_role(auth.uid(), 'ceo'::app_role) OR public.has_role(auth.uid(), 'coo'::app_role)
       OR public.has_role(auth.uid(), 'cto'::app_role) OR public.has_role(auth.uid(), 'manager'::app_role) OR public.has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO r FROM public.agent_payout_collection_rate(v_target);
  SELECT e.reason INTO v_ex FROM public.landlord_float_withdrawal_exceptions e
   WHERE e.agent_id = v_target AND e.week_start = public.current_welile_week_start(now());
  v_locked := r.rate_pct IS NOT NULL AND r.rate_pct < 50 AND v_ex IS NULL;

  RETURN QUERY SELECT v_target, v_locked,
                      CASE WHEN v_locked THEN public.landlord_float_lock_message(v_target) END,
                      r.basis, r.week_start, r.week_end, r.expected, r.collected, r.rate_pct, r.shortfall_to_50, v_ex;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_agent_landlord_float_status(p_agent_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(agent_id uuid, basis text, week_start date, week_end date, expected numeric, collected numeric, rate_pct numeric, shortfall_to_50 numeric, meets_minimum boolean, exception_reason text, can_withdraw boolean, message text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_target uuid := COALESCE(p_agent_id, auth.uid());
  v_ex text;
  r record;
BEGIN
  IF v_target IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  IF v_target <> auth.uid() AND NOT (
       public.has_role(auth.uid(), 'cfo'::app_role) OR public.has_role(auth.uid(), 'ceo'::app_role) OR public.has_role(auth.uid(), 'coo'::app_role)
       OR public.has_role(auth.uid(), 'cto'::app_role) OR public.has_role(auth.uid(), 'manager'::app_role) OR public.has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO r FROM public.agent_payout_collection_rate(v_target);
  SELECT e.reason INTO v_ex FROM public.landlord_float_withdrawal_exceptions e WHERE e.agent_id = v_target AND e.week_start = public.current_welile_week_start(now());
  RETURN QUERY SELECT v_target, r.basis, r.week_start, r.week_end, r.expected, r.collected, r.rate_pct, r.shortfall_to_50,
                      (r.rate_pct IS NULL OR r.rate_pct >= 50), v_ex,
                      (r.rate_pct IS NULL OR r.rate_pct >= 50 OR v_ex IS NOT NULL),
                      CASE WHEN r.rate_pct IS NULL OR r.rate_pct >= 50 OR v_ex IS NOT NULL THEN NULL
                           ELSE public.landlord_float_blocked_message(v_target, NULL) END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.allow_agent_landlord_float_withdrawal_unchecked(p_agent_id uuid, p_reason text)
RETURNS date
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), ''); v_ws date := public.current_welile_week_start(now()); v_rate record;
BEGIN
  IF NOT (public.has_role(v_uid, 'cto'::app_role) OR public.has_role(v_uid, 'cfo'::app_role) OR public.has_role(v_uid, 'super_admin'::app_role)) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  IF p_agent_id IS NULL THEN RAISE EXCEPTION 'Choose the agent.'; END IF;
  IF v_reason IS NULL OR char_length(v_reason) < 10 THEN RAISE EXCEPTION 'Give the reason for the exception (at least 10 characters).'; END IF;
  IF char_length(v_reason) > 600 THEN RAISE EXCEPTION 'The reason is too long (600 characters at most).'; END IF;
  SELECT * INTO v_rate FROM public.agent_payout_collection_rate(p_agent_id);
  INSERT INTO public.landlord_float_withdrawal_exceptions (agent_id, week_start, rate_pct, reason, granted_by) VALUES (p_agent_id, v_ws, v_rate.rate_pct, v_reason, v_uid)
  ON CONFLICT (agent_id, week_start) DO UPDATE SET reason = EXCLUDED.reason, granted_by = EXCLUDED.granted_by, granted_at = now(), rate_pct = EXCLUDED.rate_pct;
  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  VALUES (v_uid, 'landlord_float_withdrawal_exception', 'Allowed an agent under 50% to withdraw landlord float this week', 'profiles', p_agent_id::text,
          jsonb_build_object('week_start', v_ws, 'rate_pct', v_rate.rate_pct, 'basis', v_rate.basis, 'reason', v_reason));
  RETURN v_ws;
END;
$function$;

DROP FUNCTION IF EXISTS public._agent_weekly_shortfall(uuid);
