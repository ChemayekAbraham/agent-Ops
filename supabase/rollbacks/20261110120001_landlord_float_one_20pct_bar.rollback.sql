-- Rollback of 20261110120000_landlord_float_one_20pct_bar.sql.
-- Puts landlord float back on the two-part 50/20 weekly rule, exactly as the
-- functions stood in production on 2026-11-10 before that migration.
-- Re-locks every agent it released, so expect agents to complain the moment it runs.

CREATE OR REPLACE FUNCTION public.landlord_float_lock_message(p_agent_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  r record;
  cur_ok boolean; exp_ok boolean; has_exp boolean;
  cur_need numeric; exp_need numeric;
  lines text := '';
  fmt constant text := 'FM999,999,999,990';
BEGIN
  SELECT * INTO r FROM public.agent_payout_weekly_performance(p_agent_id);
  IF r.in_window_required_pct IS NULL AND r.expired_required_pct IS NULL THEN
    RETURN 'Landlord float is locked. ' || COALESCE(r.reason, '') || ' Collect more to unlock it. The week resets every Thursday.';
  END IF;
  has_exp := COALESCE(r.expired_due, 0) > 0;
  cur_ok := COALESCE(r.in_window_pct, 0) >= COALESCE(r.in_window_required_pct, 0);
  exp_ok := NOT has_exp OR COALESCE(r.expired_pct, 0) >= COALESCE(r.expired_required_pct, 0);
  cur_need := GREATEST(0, ceil(COALESCE(r.in_window_due,0) * COALESCE(r.in_window_required_pct,0) / 100.0) - COALESCE(r.in_window_collected,0));
  exp_need := GREATEST(0, ceil(COALESCE(r.expired_due,0) * COALESCE(r.expired_required_pct,0) / 100.0) - COALESCE(r.expired_collected,0));

  lines := 'Landlord float is locked this week (' || to_char(r.week_start, 'FMDD Mon') || ' to ' || to_char(r.week_end, 'FMDD Mon') || '). ';
  lines := lines || 'Current Rent Plans: ' || COALESCE(r.in_window_pct, 0)::text || '% collected, target ' || COALESCE(r.in_window_required_pct, 0)::text || '% — '
    || CASE WHEN cur_ok THEN 'target met.' ELSE 'collect UGX ' || to_char(cur_need, fmt) || ' more.' END || ' ';
  IF has_exp THEN
    lines := lines || 'Expired Rent Plans: ' || COALESCE(r.expired_pct, 0)::text || '% collected (UGX ' || to_char(COALESCE(r.expired_collected,0), fmt) || ' of UGX ' || to_char(r.expired_due, fmt) || '), target ' || COALESCE(r.expired_required_pct, 0)::text || '% — '
      || CASE WHEN exp_ok THEN 'target met.' ELSE 'collect UGX ' || to_char(exp_need, fmt) || ' more.' END || ' ';
  END IF;
  RETURN lines || 'Both targets must be met to unlock. The week resets every Thursday.';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.landlord_float_blocked_message(p_agent_id uuid, p_amount numeric)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE r record; amt text := to_char(COALESCE(p_amount, 0), 'FM999,999,999,999');
BEGIN
  SELECT * INTO r FROM public.agent_payout_weekly_performance(p_agent_id);
  RETURN 'Management has not released your landlord payout' || CASE WHEN COALESCE(p_amount, 0) > 0 THEN ' of UGX ' || amt ELSE '' END || '. ' || COALESCE(r.reason, '')
      || ' Collect more and your payout can be released. The week resets every Thursday.';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.enforce_landlord_float_performance_gate()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE r record;
BEGIN
  IF NEW.landlord_payout_id IS NULL THEN RETURN NEW; END IF;

  -- Renewal payouts are not held by the weekly collection target (doc 250).
  IF public.landlord_payout_is_renewal(NEW.landlord_payout_id) THEN
    SELECT * INTO r FROM public.agent_payout_weekly_performance(NEW.user_id);
    IF r.passes IS FALSE THEN
      INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
      VALUES (NEW.user_id, 'landlord_gate_renewal_skip',
              'Renewal landlord payout let through while the agent was under the weekly collection target',
              'withdrawal_requests', NEW.id::text,
              jsonb_build_object('landlord_payout_id', NEW.landlord_payout_id, 'amount', NEW.amount,
                                 'rate_pct', r.rate_pct, 'basis', r.basis));
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO r FROM public.agent_payout_weekly_performance(NEW.user_id);
  IF r.passes IS NOT FALSE THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.landlord_float_withdrawal_exceptions e
              WHERE e.agent_id = NEW.user_id AND e.week_start = public.current_welile_week_start(now())) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '%', public.landlord_float_blocked_message(NEW.user_id, NEW.amount) USING ERRCODE = 'P0001';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.get_landlord_float_gate(p_agent_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(agent_id uuid, locked boolean, block_reason text, basis text, week_start date, week_end date, expected numeric, collected numeric, rate_pct numeric, shortfall_to_50 numeric, exception_reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
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
$fn$;

CREATE OR REPLACE FUNCTION public.get_agent_landlord_float_status(p_agent_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(agent_id uuid, basis text, week_start date, week_end date, expected numeric, collected numeric, rate_pct numeric, shortfall_to_50 numeric, meets_minimum boolean, exception_reason text, can_withdraw boolean, message text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
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
$fn$;

CREATE OR REPLACE FUNCTION public.get_landlord_payout_agent_rates()
RETURNS TABLE(agent_id uuid, expected numeric, collected numeric, rate_pct numeric, meets_minimum boolean, basis text, week_start date, week_end date, book text, in_window_due numeric, in_window_collected numeric, in_window_pct numeric, in_window_required_pct numeric, expired_due numeric, expired_collected numeric, expired_pct numeric, expired_required_pct numeric, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
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
$fn$;

CREATE OR REPLACE FUNCTION public.reject_landlord_payouts(p_withdrawal_ids uuid[], p_message text DEFAULT NULL::text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
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
  $fn$;

COMMENT ON FUNCTION public._agent_weekly_shortfall(uuid) IS NULL;

DROP FUNCTION IF EXISTS public._agent_landlord_float_check(uuid);

ALTER TABLE public.agent_posting_rule_settings
  DROP CONSTRAINT IF EXISTS agent_posting_rule_settings_landlord_float_pct_range;
ALTER TABLE public.agent_posting_rule_settings
  DROP COLUMN IF EXISTS landlord_float_required_pct;
