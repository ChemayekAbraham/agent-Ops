-- Landlord Float card lock: an agent under 50% performance cannot open the landlord float withdrawal, and is told why.
--
-- This is the same pattern as the money withdrawal lock. A withdrawal of money asks ONE server function (get_withdraw_context) for
-- gates {can_submit, block_reason}; the screens lock the button and show block_reason, and a database rule refuses the submit with the
-- same text, so the screen and the database cannot disagree. Landlord float gets the same two halves:
--
--   1. get_landlord_float_gate()  (this file)  returns {locked, block_reason, ...} for the signed-in agent. The Landlord Float card
--      locks and shows block_reason; it does not open the withdrawal dialogs.
--   2. The submit-side rule that already exists (aaa_00_landlord_float_performance_gate on withdrawal_requests, from
--      20261022150000_landlord_float_withdrawal_performance_gate.sql) refuses a landlord float withdrawal from an agent under 50%,
--      so a locked card cannot be bypassed by calling the function directly.
--
-- Same rule and same numbers as that gate: agent_payout_collection_rate() (the last 7 days, or the Thursday-Wednesday week once
-- landlord_gate_weekly_mode is on), the 50% minimum, and the CTO/CFO exception for the week (landlord_float_withdrawal_exceptions).
-- An agent with no collection target has no rate and is never locked. An exception unlocks the card for the week.
--
-- Needs 20261022150000_landlord_float_withdrawal_performance_gate.sql to be applied first.
-- Roll back with 20261023100000_landlord_float_card_lock.rollback.sql.

-- The sentence on the locked card.
CREATE OR REPLACE FUNCTION public.landlord_float_lock_message(p_agent_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
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

REVOKE ALL ON FUNCTION public.landlord_float_lock_message(uuid) FROM PUBLIC, anon, authenticated;

-- What the card reads. An agent reads their own; the CTO, CFO and other executives can read anyone's.
CREATE OR REPLACE FUNCTION public.get_landlord_float_gate(p_agent_id uuid DEFAULT NULL)
RETURNS TABLE(agent_id uuid, locked boolean, block_reason text, basis text, week_start date, week_end date, expected numeric, collected numeric,
              rate_pct numeric, shortfall_to_50 numeric, exception_reason text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
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

REVOKE ALL ON FUNCTION public.get_landlord_float_gate(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_landlord_float_gate(uuid) TO authenticated;
