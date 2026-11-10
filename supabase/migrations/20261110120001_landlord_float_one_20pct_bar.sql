-- Landlord float: one bar of 20%, and it may never be stricter than posting.
--
-- Two changes to how an agent's landlord float is judged. Josh's call, 2026-11-10.
--
-- CHANGE 1 — ONE BAR. Float followed the same two-part weekly rule as posting:
-- 50% of what current Rent Plans were billed AND 20% of what expired Rent Plans
-- were billed, scored as separate legs. For landlord float the bar is now 20% of
-- the whole bill, current and expired counted together. The expired leg is what
-- was biting: that money is older, the tenants are harder to reach, and a strong
-- week on current plans could not offset it. Of the 93 agents with a bill in the
-- week 5-9 Nov only 7 could touch float, and not one of the 46 agents holding a
-- mixed book passed.
--
--   ALPHA SSEMA      current 65.5% (495,152 of 756,113)  expired  0.6% (2,000 of 314,250)   whole bill 46.4%
--   Kakooza Charles  current 63.2% (200,448 of 317,210)  expired 13.1% (97,035 of 741,020)  whole bill 28.1%
--
-- CHANGE 2 — THE SAME WEEK AS POSTING. This is the one that matters more, and it
-- came from Josh spotting that Kakooza Charles can post a rent request today
-- while his float is locked. The two gates were reading different weeks:
--
--   posting  reads the SETTLED verdict for the closed week (_agent_weekly_posting_result)
--   float    read THIS WEEK SO FAR, live, still moving
--
-- Kakooza passed the closed week 29 Oct - 4 Nov (current 55.7%, expired 22.9%),
-- so he may take on a new tenant today — but could not draw the float to pay that
-- tenant's landlord. Twelve agents were in that position on 2026-11-10. It is the
-- wrong way round: posting creates a new obligation, float funds one already
-- taken on, so float must never be the stricter of the two.
--
-- THE RULE NOW: an agent has landlord float if they collected at least 20% of
-- everything billed — current and expired Rent Plans together — in EITHER the
-- closed week the posting gate judges OR this week so far. The first leg reads
-- `_agent_weekly_posting_result`, the very row posting reads, so the two gates
-- cannot drift apart. The second leg keeps the way back open mid-week: an agent
-- who lost last week can still earn float on Thursday by collecting this week,
-- instead of being locked out until the week resets.
--
-- Because the old bars are 50% and 20%, an agent meeting both necessarily
-- collected at least 20% of the combined bill, so passing the posting gate
-- implies passing the float gate. The contradiction is now impossible by
-- construction, not merely absent today. The DO block at the end asserts it.
--
-- NOBODY LOSES ACCESS: every agent who passes today passes under this rule.
-- Effect on 2026-11-10: 8 agents with float -> 41. ALPHA SSEMA is released on
-- last week's 64.0% of his whole bill, Kakooza Charles on 47.2% of his.
--
-- WHAT IS NOT CHANGED. `agent_payout_weekly_performance` keeps the 50/20 rule
-- untouched — fifteen other functions read it, among them
-- `enforce_rent_disbursement_collection_gate`, a different gate on a different
-- flow. The posting rule itself is untouched. An agent released for float here
-- may still be unable to post, which is the intended direction.
--
-- Roll back with 20261110120000_landlord_float_one_20pct_bar.rollback.sql.

-- 1. The threshold, beside the three it belongs with.
ALTER TABLE public.agent_posting_rule_settings
  ADD COLUMN IF NOT EXISTS landlord_float_required_pct numeric NOT NULL DEFAULT 0.20;

DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_posting_rule_settings_landlord_float_pct_range') THEN
    ALTER TABLE public.agent_posting_rule_settings
      ADD CONSTRAINT agent_posting_rule_settings_landlord_float_pct_range
      CHECK (landlord_float_required_pct >= 0 AND landlord_float_required_pct <= 1);
  END IF;
END
$c$;

COMMENT ON COLUMN public.agent_posting_rule_settings.landlord_float_required_pct IS
  'Landlord float only: the share of the whole weekly bill (current plus expired Rent Plans together) an agent must collect, in either the judged closed week or this week so far. The posting gate still uses in_window_required_pct / expired_required_pct / all_expired_required_pct.';

-- 2. One place that decides the landlord float verdict. Private: it takes any
--    agent id and checks no caller, so only the SECURITY DEFINER functions
--    below may call it.
--
--    DROPPED, not replaced: an earlier form of this file went out with change 1
--    only, creating this function without the two judged-week columns. Postgres
--    refuses to widen a function's OUT list in place ("cannot change return type
--    of existing function"), so it has to go first. Dropping resets the ACL to
--    the database default, which grants EXECUTE to anon and authenticated — the
--    REVOKE below is what takes it back, and must stay directly after the CREATE.
DROP FUNCTION IF EXISTS public._agent_landlord_float_check(uuid);

CREATE OR REPLACE FUNCTION public._agent_landlord_float_check(p_agent_id uuid)
RETURNS TABLE(basis text, week_start date, week_end date, book text,
              expected numeric, collected numeric, rate_pct numeric,
              required_pct numeric, shortfall numeric, passes boolean, reason text,
              in_window_due numeric, in_window_collected numeric, in_window_pct numeric,
              expired_due numeric, expired_collected numeric, expired_pct numeric,
              judged_week_start date, judged_due numeric, judged_collected numeric,
              judged_ok boolean, this_week_ok boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  r record;                                        -- this week so far (or, on a Thursday, the week that just ended)
  w public.agent_weekly_posting_eligibility;       -- the closed week the posting gate judges
  v_req numeric;
  v_j_due numeric := 0;
  v_j_got numeric := 0;
  v_j_ok boolean;
  v_t_ok boolean;
  v_need numeric;
  v_reason text;
  v_label text;
  v_through date := ((now() AT TIME ZONE 'Africa/Kampala')::date) - 1;
  fmt constant text := 'FM999,999,999,990';
BEGIN
  SELECT * INTO r FROM public.agent_payout_weekly_performance(p_agent_id);
  -- The same row the posting gate reads, not a parallel calculation of it.
  w := public._agent_weekly_posting_result(p_agent_id);
  SELECT s.landlord_float_required_pct INTO v_req FROM public.agent_posting_rule_settings s WHERE s.id;
  v_req := COALESCE(v_req, 0.20);

  IF w.agent_id IS NOT NULL THEN
    v_j_due := COALESCE(w.in_window_due, 0) + COALESCE(w.expired_due, 0);
    v_j_got := COALESCE(w.in_window_collected, 0) + COALESCE(w.expired_collected, 0);
  END IF;

  -- Nothing billed in a week is a pass for that week, exactly as the posting rule treats it.
  v_j_ok := v_j_due = 0 OR v_j_got >= v_req * v_j_due;
  v_t_ok := COALESCE(r.expected, 0) = 0 OR COALESCE(r.collected, 0) >= v_req * r.expected;

  -- What is still needed is always measured on the week the agent can still
  -- change. The closed week cannot be collected into any more.
  v_need := GREATEST(0, ceil(v_req * COALESCE(r.expected, 0)) - COALESCE(r.collected, 0));

  v_label := CASE WHEN r.basis = 'week_so_far'
                  THEN 'This week so far (' || to_char(r.week_start, 'FMDD Mon') || ' to ' || to_char(v_through, 'FMDD Mon') || ')'
                  ELSE 'Last week (' || to_char(r.week_start, 'FMDD Mon') || ' to ' || to_char(r.week_end, 'FMDD Mon') || ')'
             END;

  -- No call to action here: each message below adds its own, because unlocking
  -- float and releasing a payout already requested are not the same thing.
  v_reason := CASE
    WHEN COALESCE(r.expected, 0) = 0 AND v_j_due = 0
      THEN 'Nothing has been billed on your Rent Plans this week yet.'
    ELSE
      CASE WHEN v_j_due > 0 AND r.basis = 'week_so_far'
           THEN 'Last week (' || to_char(w.week_start, 'FMDD Mon') || ' to ' || to_char(w.week_end, 'FMDD Mon') || ') you collected UGX '
                || to_char(v_j_got, fmt) || ' of the UGX ' || to_char(v_j_due, fmt) || ' billed — '
                || to_char(round(100.0 * v_j_got / v_j_due, 1), 'FM990.0') || '%. '
           ELSE '' END
      || CASE WHEN COALESCE(r.expected, 0) > 0
              THEN v_label || ' you collected UGX ' || to_char(r.collected, fmt) || ' of the UGX ' || to_char(r.expected, fmt)
                   || ' billed on your Rent Plans — ' || to_char(round(100.0 * r.collected / r.expected, 1), 'FM990.0') || '%. '
              ELSE '' END
      || 'Landlord float needs ' || to_char(round(100 * v_req), 'FM990')
      || '% of everything billed, current and expired Rent Plans counted together, in either week.'
  END;

  RETURN QUERY SELECT r.basis, r.week_start, r.week_end, r.book,
    COALESCE(r.expected, 0), COALESCE(r.collected, 0), r.rate_pct,
    round(100 * v_req, 1), v_need, (v_j_ok OR v_t_ok), v_reason,
    r.in_window_due, r.in_window_collected, r.in_window_pct,
    r.expired_due, r.expired_collected, r.expired_pct,
    w.week_start, v_j_due, v_j_got, v_j_ok, v_t_ok;
END;
$fn$;
REVOKE ALL ON FUNCTION public._agent_landlord_float_check(uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._agent_landlord_float_check(uuid) IS
  'The landlord float verdict. Passes on 20% (agent_posting_rule_settings.landlord_float_required_pct) of the whole weekly bill in EITHER the closed week the posting gate judges or this week so far. Reads _agent_weekly_posting_result for the first leg so float can never be stricter than posting.';

COMMENT ON FUNCTION public._agent_weekly_shortfall(uuid) IS
  'Shortfall against the two-part 50/20 posting rule. Superseded for landlord float by _agent_landlord_float_check(uuid).shortfall; still here for the rent disbursement side.';

-- 3. The agent's own card.
CREATE OR REPLACE FUNCTION public.landlord_float_lock_message(p_agent_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE c record; fmt constant text := 'FM999,999,999,990';
BEGIN
  SELECT * INTO c FROM public._agent_landlord_float_check(p_agent_id);
  RETURN 'Landlord float is locked. ' || c.reason
      || CASE WHEN COALESCE(c.shortfall, 0) > 0 THEN ' Collect UGX ' || to_char(c.shortfall, fmt) || ' more this week to unlock it.' ELSE '' END
      || ' The week resets every Thursday.';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.landlord_float_blocked_message(p_agent_id uuid, p_amount numeric)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE c record; amt text := to_char(COALESCE(p_amount, 0), 'FM999,999,999,999'); fmt constant text := 'FM999,999,999,990';
BEGIN
  SELECT * INTO c FROM public._agent_landlord_float_check(p_agent_id);
  RETURN 'Management has not released your landlord payout'
      || CASE WHEN COALESCE(p_amount, 0) > 0 THEN ' of UGX ' || amt ELSE '' END || '. ' || c.reason
      || CASE WHEN COALESCE(c.shortfall, 0) > 0 THEN ' Collect UGX ' || to_char(c.shortfall, fmt) || ' more this week and your payout can be released.' ELSE '' END
      || ' The week resets every Thursday.';
END;
$fn$;

-- 4. The gate that actually stops the money.
CREATE OR REPLACE FUNCTION public.enforce_landlord_float_performance_gate()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE c record;
BEGIN
  IF NEW.landlord_payout_id IS NULL THEN RETURN NEW; END IF;

  -- Renewal payouts are not held by the weekly collection target (doc 250).
  IF public.landlord_payout_is_renewal(NEW.landlord_payout_id) THEN
    SELECT * INTO c FROM public._agent_landlord_float_check(NEW.user_id);
    IF c.passes IS FALSE THEN
      INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
      VALUES (NEW.user_id, 'landlord_gate_renewal_skip',
              'Renewal landlord payout let through while the agent was under the weekly collection target',
              'withdrawal_requests', NEW.id::text,
              jsonb_build_object('landlord_payout_id', NEW.landlord_payout_id, 'amount', NEW.amount,
                                 'rate_pct', c.rate_pct, 'required_pct', c.required_pct, 'basis', c.basis));
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO c FROM public._agent_landlord_float_check(NEW.user_id);
  IF c.passes IS NOT FALSE THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.landlord_float_withdrawal_exceptions e
              WHERE e.agent_id = NEW.user_id AND e.week_start = public.current_welile_week_start(now())) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '%', public.landlord_float_blocked_message(NEW.user_id, NEW.amount) USING ERRCODE = 'P0001';
END;
$fn$;

-- 5. What the agent's screen reads. Signatures unchanged, so the generated types
--    and every caller stay as they are. `shortfall_to_50` keeps its name because
--    the frontend reads it by name; it now carries the shortfall to the one bar.
CREATE OR REPLACE FUNCTION public.get_landlord_float_gate(p_agent_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(agent_id uuid, locked boolean, block_reason text, basis text, week_start date, week_end date, expected numeric, collected numeric, rate_pct numeric, shortfall_to_50 numeric, exception_reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_target uuid := COALESCE(p_agent_id, auth.uid());
  v_ex text;
  v_locked boolean;
  c record;
BEGIN
  IF v_target IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  IF v_target <> auth.uid() AND NOT (
       public.has_role(auth.uid(), 'cfo'::app_role) OR public.has_role(auth.uid(), 'ceo'::app_role) OR public.has_role(auth.uid(), 'coo'::app_role)
       OR public.has_role(auth.uid(), 'cto'::app_role) OR public.has_role(auth.uid(), 'manager'::app_role) OR public.has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO c FROM public._agent_landlord_float_check(v_target);
  SELECT e.reason INTO v_ex FROM public.landlord_float_withdrawal_exceptions e
   WHERE e.agent_id = v_target AND e.week_start = public.current_welile_week_start(now());
  v_locked := c.passes IS FALSE AND v_ex IS NULL;

  RETURN QUERY SELECT v_target, v_locked,
                      CASE WHEN v_locked THEN public.landlord_float_lock_message(v_target) END,
                      c.basis, c.week_start, c.week_end, c.expected, c.collected, c.rate_pct, c.shortfall, v_ex;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.get_agent_landlord_float_status(p_agent_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(agent_id uuid, basis text, week_start date, week_end date, expected numeric, collected numeric, rate_pct numeric, shortfall_to_50 numeric, meets_minimum boolean, exception_reason text, can_withdraw boolean, message text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_target uuid := COALESCE(p_agent_id, auth.uid());
  v_ex text;
  c record;
BEGIN
  IF v_target IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  IF v_target <> auth.uid() AND NOT (
       public.has_role(auth.uid(), 'cfo'::app_role) OR public.has_role(auth.uid(), 'ceo'::app_role) OR public.has_role(auth.uid(), 'coo'::app_role)
       OR public.has_role(auth.uid(), 'cto'::app_role) OR public.has_role(auth.uid(), 'manager'::app_role) OR public.has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO c FROM public._agent_landlord_float_check(v_target);
  SELECT e.reason INTO v_ex FROM public.landlord_float_withdrawal_exceptions e WHERE e.agent_id = v_target AND e.week_start = public.current_welile_week_start(now());
  RETURN QUERY SELECT v_target, c.basis, c.week_start, c.week_end, c.expected, c.collected, c.rate_pct, c.shortfall,
                      (c.passes IS NOT FALSE), v_ex,
                      (c.passes IS NOT FALSE OR v_ex IS NOT NULL),
                      CASE WHEN c.passes IS NOT FALSE OR v_ex IS NOT NULL THEN NULL
                           ELSE public.landlord_float_blocked_message(v_target, NULL) END;
END;
$fn$;

-- 6. The CFO / CTO landlord payout queue must agree with the agent's card, or
--    staff reject payouts the agent has been told are fine. That split is the
--    bug 20261027230000 was written to close; keep it closed.
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

  -- meets_minimum and reason are the landlord float rule. The per-leg columns
  -- stay on the row as the breakdown staff read, and keep carrying the posting
  -- rule's own targets, which is why they still come from r.
  RETURN QUERY
  SELECT a.user_id, c.expected, c.collected, c.rate_pct, c.passes,
         c.basis, c.week_start, c.week_end, c.book,
         r.in_window_due, r.in_window_collected, r.in_window_pct, r.in_window_required_pct,
         r.expired_due, r.expired_collected, r.expired_pct, r.expired_required_pct, c.reason
    FROM (SELECT DISTINCT w.user_id
            FROM public.withdrawal_requests w
           WHERE w.landlord_payout_id IS NOT NULL AND w.assigned_cashout_agent_id IS NULL
             AND w.processed_at IS NULL AND w.fin_ops_reference IS NULL) a
   CROSS JOIN LATERAL public.agent_payout_weekly_performance(a.user_id) r
   CROSS JOIN LATERAL public._agent_landlord_float_check(a.user_id) c;
END;
$fn$;

-- 7. The rejection the agent is sent must quote the rule they were judged on.
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
      SELECT * INTO v_rate FROM public._agent_landlord_float_check(v_agent.user_id);
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

-- 8. Assert both properties on the live book before this is allowed to commit:
--    nobody loses float, and nobody who may post is denied float.
DO $verify$
DECLARE v_lost int; v_contra int; v_now int; v_new int;
BEGIN
  WITH agents AS (
    SELECT DISTINCT agent_id FROM public.agent_expected_day_plans
     WHERE day >= public.current_welile_week_start(now()) - 14
  ), m AS (
    SELECT r.passes AS old_pass, c.passes AS new_pass,
           COALESCE((public._agent_weekly_posting_result(a.agent_id)).passes, true) AS can_post
      FROM agents a
     CROSS JOIN LATERAL public.agent_payout_weekly_performance(a.agent_id) r
     CROSS JOIN LATERAL public._agent_landlord_float_check(a.agent_id) c
  )
  SELECT count(*) FILTER (WHERE old_pass AND NOT new_pass),
         count(*) FILTER (WHERE can_post AND NOT new_pass),
         count(*) FILTER (WHERE old_pass),
         count(*) FILTER (WHERE new_pass)
    INTO v_lost, v_contra, v_now, v_new FROM m;

  IF v_lost > 0 THEN
    RAISE EXCEPTION 'Refusing: % agent(s) would lose landlord float under the new rule', v_lost;
  END IF;
  IF v_contra > 0 THEN
    RAISE EXCEPTION 'Refusing: % agent(s) could post a rent request but still have no landlord float', v_contra;
  END IF;
  RAISE NOTICE 'Landlord float: % agent(s) had it under the old rule, % have it now. No agent who may post is locked out.', v_now, v_new;
END
$verify$;
