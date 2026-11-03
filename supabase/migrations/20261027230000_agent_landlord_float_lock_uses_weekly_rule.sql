-- The agent's own landlord float lock (and the block on requesting a landlord payout) judges the agent on the same weekly money-collected rule the CFO and
-- CTO screens use (agent_payout_weekly_performance, 20261025120000), instead of the rolling 7-day rate with a flat 50% minimum.
--
-- WHY: agents saw something different from staff. On 27 Oct, Shafeeq Ssenabulya passed the weekly rule (50.0% on current plans, 24.7% on expired plans) but
-- his own screen said "Landlord float is locked ... 42.0% over the last 7 days"; Nattu Sharifah failed the weekly rule (46.8% on current plans) but her own
-- screen said she was fine (51.3% over 7 days). The agent side still read agent_payout_collection_rate, which is rolling 7 days while the switch
-- treasury_controls.landlord_gate_weekly_mode is off.
--
-- THE RULE (unchanged, set in agent_posting_rule_settings): the rule week runs Thursday to Wednesday. Friday to Wednesday it is THIS WEEK SO FAR, Thursday up
-- to today, collected capped per plan against what has been billed. On Thursday, the week that just ended. Current plans 50%; current plus expired plans
-- 50% on current AND 20% on expired; only expired plans 70%; nothing billed passes.
--
-- WHAT CHANGES (same signatures, same callers):
--   * enforce_landlord_float_performance_gate: the trigger that stops an under-target agent's landlord payout request now uses pass or fail.
--   * get_landlord_float_gate / get_agent_landlord_float_status: locked, meets_minimum and can_withdraw follow pass or fail; shortfall_to_50 is what is still
--     needed to reach the target on current and on expired plans.
--   * landlord_float_lock_message / landlord_float_blocked_message: say the weekly figures ("This week so far (22 Oct to 27 Oct) you collected ...").
--   * allow_agent_landlord_float_withdrawal_unchecked: records the weekly figure on the exception row and in the audit log.
-- The exception tables, the approval codes and the weekly-mode switch are untouched. request_exception_otp still words its email from the old rate: it
-- is an email for the approver only and is not changed here.
-- Needs 20261025120000. Roll back with 20261027230000_agent_landlord_float_lock_uses_weekly_rule.rollback.sql.

-- What is still needed to pass: on current plans to reach their target plus on expired plans to reach theirs. Zero when nothing is needed.
CREATE OR REPLACE FUNCTION public._agent_weekly_shortfall(p_agent_id uuid)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE(GREATEST(0, ceil(COALESCE(r.in_window_required_pct, 0) / 100.0 * r.in_window_due - r.in_window_collected)), 0)
       + COALESCE(GREATEST(0, ceil(COALESCE(r.expired_required_pct, 0) / 100.0 * r.expired_due - r.expired_collected)), 0)
    FROM public.agent_payout_weekly_performance(p_agent_id) r;
$function$;
REVOKE ALL ON FUNCTION public._agent_weekly_shortfall(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.landlord_float_lock_message(p_agent_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.agent_payout_weekly_performance(p_agent_id);
  RETURN 'Landlord float is locked. ' || COALESCE(r.reason, '') || ' Collect more to unlock it. The week resets every Thursday.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.landlord_float_blocked_message(p_agent_id uuid, p_amount numeric)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE r record; amt text := to_char(COALESCE(p_amount, 0), 'FM999,999,999,999');
BEGIN
  SELECT * INTO r FROM public.agent_payout_weekly_performance(p_agent_id);
  RETURN 'Management has not released your landlord payout' || CASE WHEN COALESCE(p_amount, 0) > 0 THEN ' of UGX ' || amt ELSE '' END || '. ' || COALESCE(r.reason, '')
      || ' Collect more and your payout can be released. The week resets every Thursday.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_landlord_float_performance_gate()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
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

  SELECT * INTO r FROM public.agent_payout_weekly_performance(v_target);
  SELECT e.reason INTO v_ex FROM public.landlord_float_withdrawal_exceptions e
   WHERE e.agent_id = v_target AND e.week_start = public.current_welile_week_start(now());
  v_locked := r.passes IS FALSE AND v_ex IS NULL;

  RETURN QUERY SELECT v_target, v_locked,
                      CASE WHEN v_locked THEN public.landlord_float_lock_message(v_target) END,
                      r.basis, r.week_start, r.week_end, r.expected, r.collected, r.rate_pct, public._agent_weekly_shortfall(v_target), v_ex;
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
  SELECT * INTO r FROM public.agent_payout_weekly_performance(v_target);
  SELECT e.reason INTO v_ex FROM public.landlord_float_withdrawal_exceptions e WHERE e.agent_id = v_target AND e.week_start = public.current_welile_week_start(now());
  RETURN QUERY SELECT v_target, r.basis, r.week_start, r.week_end, r.expected, r.collected, r.rate_pct, public._agent_weekly_shortfall(v_target),
                      (r.passes IS NOT FALSE), v_ex,
                      (r.passes IS NOT FALSE OR v_ex IS NOT NULL),
                      CASE WHEN r.passes IS NOT FALSE OR v_ex IS NOT NULL THEN NULL
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
  SELECT * INTO v_rate FROM public.agent_payout_weekly_performance(p_agent_id);
  INSERT INTO public.landlord_float_withdrawal_exceptions (agent_id, week_start, rate_pct, reason, granted_by) VALUES (p_agent_id, v_ws, v_rate.rate_pct, v_reason, v_uid)
  ON CONFLICT (agent_id, week_start) DO UPDATE SET reason = EXCLUDED.reason, granted_by = EXCLUDED.granted_by, granted_at = now(), rate_pct = EXCLUDED.rate_pct;
  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  VALUES (v_uid, 'landlord_float_withdrawal_exception', 'Allowed an agent under the weekly collection target to withdraw landlord float this week', 'profiles', p_agent_id::text,
          jsonb_build_object('week_start', v_ws, 'rate_pct', v_rate.rate_pct, 'basis', v_rate.basis, 'reason', v_reason));
  RETURN v_ws;
END;
$function$;
