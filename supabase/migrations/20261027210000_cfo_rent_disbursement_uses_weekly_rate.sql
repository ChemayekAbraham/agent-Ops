-- The CFO's landlord float / rent funding gate judges each agent on the same weekly money-collected rate as "Allow selected" landlord payouts
-- (agent_payout_weekly_performance, 20261025120000), instead of the old rolling 7-day rate with a flat 50% minimum.
--
-- WHY: an agent who passes the weekly rule (for example 50.0% on current plans, 24.7% on expired plans, 22 to 27 Oct) was still stopped at the CFO
-- gate, because it read agent_collection_rate_7d: every payment over the last 7 days, uncapped per plan, against everything billed in those days
-- (42.0%). The two gates disagreed about the same agent.
--
-- THE WEEK: the rule week runs Thursday to Wednesday (Africa/Kampala). Friday to Wednesday it is THIS WEEK SO FAR, Thursday up to today, collected
-- capped per plan against what has been billed. On Thursday, the week that just ended. THE TARGET is the weekly posting rule's: current plans 50%;
-- current plus expired plans 50% on current AND 20% on expired; only expired plans 70%; nothing billed passes. Percentages are changed in
-- agent_posting_rule_settings and flow through here.
--
-- WHAT CHANGES (same signatures, same callers):
--   * enforce_rent_disbursement_collection_gate: the CFO funding trigger passes when the agent meets this week's target (or has an exception).
--   * get_rent_disbursement_agent_rates: the rate list the CFO screen reads (rate_pct and meets_minimum are now the weekly figures).
--   * cfo_allow_rent_disbursement_exception_unchecked: the exception row records the weekly figures.
--   * cfo_notify_agent_rent_not_disbursed: the message the agent is sent states the weekly figures.
-- The exception approval code, roles, and the landlord float gate (landlord_gate_weekly_mode) are untouched.
-- Needs 20261025120000. Roll back with 20261027210000_cfo_rent_disbursement_uses_weekly_rate.rollback.sql.

CREATE OR REPLACE FUNCTION public.enforce_rent_disbursement_collection_gate()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_status text; v_rate record; v_name text;
BEGIN
  IF NEW.source IS DISTINCT FROM 'cfo_disbursement' OR NEW.rent_request_id IS NULL THEN RETURN NEW; END IF;
  SELECT r.status INTO v_status FROM public.rent_requests r WHERE r.id = NEW.rent_request_id;
  IF v_status IS NULL OR v_status NOT IN ('approved', 'coo_approved') THEN RETURN NEW; END IF;
  SELECT * INTO v_rate FROM public.agent_payout_weekly_performance(NEW.agent_id);
  IF v_rate.passes IS NOT FALSE THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.rent_disbursement_rate_exceptions x WHERE x.rent_request_id = NEW.rent_request_id) THEN RETURN NEW; END IF;
  SELECT COALESCE(p.full_name, 'The agent') INTO v_name FROM public.profiles p WHERE p.id = NEW.agent_id;
  RAISE EXCEPTION 'Rent not funded: % is under the weekly collection target. % Rent is only funded to agents who reach the weekly target. Ask the agent to collect more, or allow an exception with a reason.',
    COALESCE(v_name, 'The agent'), COALESCE(v_rate.reason, '')
    USING ERRCODE = 'P0001';
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_rent_disbursement_agent_rates(p_rent_request_ids uuid[])
RETURNS TABLE(rent_request_id uuid, agent_id uuid, agent_name text, rent_amount numeric, expected numeric, collected numeric, rate_pct numeric, meets_minimum boolean, exception_reason text, exception_by uuid, exception_at timestamp with time zone)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'cfo'::app_role) OR public.has_role(auth.uid(), 'ceo'::app_role) OR public.has_role(auth.uid(), 'coo'::app_role)
          OR public.has_role(auth.uid(), 'cto'::app_role) OR public.has_role(auth.uid(), 'manager'::app_role) OR public.has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT r.id, a.aid, p.full_name, r.rent_amount, rt.expected, rt.collected, rt.rate_pct,
         (rt.passes OR x.rent_request_id IS NOT NULL),
         x.reason, x.granted_by, x.granted_at
    FROM public.rent_requests r
   CROSS JOIN LATERAL (SELECT COALESCE(r.assigned_agent_id, r.agent_id) AS aid) a
    LEFT JOIN public.profiles p ON p.id = a.aid
   CROSS JOIN LATERAL public.agent_payout_weekly_performance(a.aid) rt
    LEFT JOIN public.rent_disbursement_rate_exceptions x ON x.rent_request_id = r.id
   WHERE r.id = ANY (p_rent_request_ids) AND a.aid IS NOT NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cfo_allow_rent_disbursement_exception_unchecked(p_rent_request_ids uuid[], p_reason text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), ''); v_n integer;
BEGIN
  IF NOT (public.is_cfo_approver(v_uid) OR public.has_role(v_uid, 'super_admin'::app_role)) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  IF p_rent_request_ids IS NULL OR cardinality(p_rent_request_ids) = 0 THEN RETURN 0; END IF;
  IF v_reason IS NULL OR char_length(v_reason) < 10 THEN RAISE EXCEPTION 'Give the reason for the exception (at least 10 characters).'; END IF;
  IF char_length(v_reason) > 600 THEN RAISE EXCEPTION 'The reason is too long (600 characters at most).'; END IF;
  WITH ins AS (
    INSERT INTO public.rent_disbursement_rate_exceptions (rent_request_id, agent_id, rate_pct, expected, collected, reason, granted_by)
    SELECT r.id, a.aid, rt.rate_pct, rt.expected, rt.collected, v_reason, v_uid
      FROM public.rent_requests r
     CROSS JOIN LATERAL (SELECT COALESCE(r.assigned_agent_id, r.agent_id) AS aid) a
     CROSS JOIN LATERAL public.agent_payout_weekly_performance(a.aid) rt
     WHERE r.id = ANY (p_rent_request_ids) AND r.status IN ('approved', 'coo_approved') AND a.aid IS NOT NULL
    ON CONFLICT (rent_request_id) DO UPDATE SET reason = EXCLUDED.reason, granted_by = EXCLUDED.granted_by, granted_at = now(),
                                                rate_pct = EXCLUDED.rate_pct, expected = EXCLUDED.expected, collected = EXCLUDED.collected
    RETURNING rent_request_id, agent_id, rate_pct
  ), logged AS (
    INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
    SELECT v_uid, 'rent_disbursement_rate_exception', 'Allowed rent disbursement with exception: agent under the weekly collection target',
           'rent_requests', i.rent_request_id::text, jsonb_build_object('agent_id', i.agent_id, 'rate_pct', i.rate_pct, 'reason', v_reason)
      FROM ins i RETURNING 1
  )
  SELECT count(*) INTO v_n FROM ins;
  RETURN COALESCE(v_n, 0);
END;
$function$;

CREATE OR REPLACE FUNCTION public.cfo_notify_agent_rent_not_disbursed(p_rent_request_ids uuid[], p_message text DEFAULT NULL::text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_custom text := NULLIF(btrim(COALESCE(p_message, '')), ''); v_agent record; v_rate record; v_body text; v_count integer := 0;
BEGIN
  IF NOT (public.is_cfo_approver(v_uid) OR public.has_role(v_uid, 'super_admin'::app_role)) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  IF p_rent_request_ids IS NULL OR cardinality(p_rent_request_ids) = 0 THEN RETURN 0; END IF;
  IF v_custom IS NOT NULL AND char_length(v_custom) > 600 THEN RAISE EXCEPTION 'The message is too long (600 characters at most).'; END IF;
  FOR v_agent IN
    SELECT COALESCE(r.assigned_agent_id, r.agent_id) AS agent_id, count(*) AS n, sum(r.rent_amount) AS total, array_agg(r.id) AS ids
      FROM public.rent_requests r
     WHERE r.id = ANY (p_rent_request_ids) AND r.status IN ('approved', 'coo_approved') AND COALESCE(r.assigned_agent_id, r.agent_id) IS NOT NULL
     GROUP BY COALESCE(r.assigned_agent_id, r.agent_id)
  LOOP
    SELECT * INTO v_rate FROM public.agent_payout_weekly_performance(v_agent.agent_id);
    v_body := CASE WHEN v_agent.n = 1 THEN 'Management has not released the landlord float for your rent request of UGX '
                   ELSE 'Management has not released the landlord float for your ' || v_agent.n || ' rent requests, UGX ' END
              || to_char(v_agent.total, 'FM999,999,999,999') || '. '
              || COALESCE(v_custom,
                   CASE WHEN v_rate.rate_pct IS NOT NULL
                        THEN v_rate.reason || ' Management only releases landlord float to agents who reach the weekly collection target. Collect more and it can be released.'
                        ELSE 'You did not meet the requirements for landlord float to be released. Management only releases landlord float to agents who reach the weekly collection target.' END);
    INSERT INTO public.notifications (user_id, title, message, type, metadata, event_key)
    VALUES (v_agent.agent_id, 'Landlord float not released', v_body, 'warning',
            jsonb_build_object('kind', 'rent_disbursement_rejected', 'rent_request_ids', to_jsonb(v_agent.ids), 'rate_pct', v_rate.rate_pct, 'minimum_pct', 50, 'custom_message', v_custom IS NOT NULL),
            'rent_disbursement_rejected:' || v_agent.agent_id::text || ':' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'));
    INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
    SELECT v_uid, 'rent_disbursement_agent_notified', 'Told the agent why the rent was not funded', 'rent_requests', i::text,
           jsonb_build_object('agent_id', v_agent.agent_id, 'rate_pct', v_rate.rate_pct, 'message', v_body)
      FROM unnest(v_agent.ids) AS i;
    v_count := v_count + v_agent.n;
  END LOOP;
  RETURN v_count;
END;
$function$;
