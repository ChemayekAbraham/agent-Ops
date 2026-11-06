-- Puts the CFO rent funding gate back on the rolling 7-day collection rate with the flat 50% minimum.

CREATE OR REPLACE FUNCTION public.enforce_rent_disbursement_collection_gate()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_status text; v_rate record; v_name text;
BEGIN
  IF NEW.source IS DISTINCT FROM 'cfo_disbursement' OR NEW.rent_request_id IS NULL THEN RETURN NEW; END IF;
  SELECT r.status INTO v_status FROM public.rent_requests r WHERE r.id = NEW.rent_request_id;
  IF v_status IS NULL OR v_status NOT IN ('approved', 'coo_approved') THEN RETURN NEW; END IF;
  SELECT * INTO v_rate FROM public.agent_collection_rate_7d(NEW.agent_id);
  IF v_rate.rate_pct IS NULL OR v_rate.rate_pct >= 50 THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.rent_disbursement_rate_exceptions x WHERE x.rent_request_id = NEW.rent_request_id) THEN RETURN NEW; END IF;
  SELECT COALESCE(p.full_name, 'The agent') INTO v_name FROM public.profiles p WHERE p.id = NEW.agent_id;
  RAISE EXCEPTION 'Rent not funded: % collected % in the last 7 days (UGX % of UGX % expected). Rent is only funded to agents who collect at least 50%% over 7 days. Ask the agent to collect more, or allow an exception with a reason.',
    COALESCE(v_name, 'The agent'), v_rate.rate_pct::text || '%', to_char(v_rate.collected, 'FM999,999,999,999'), to_char(v_rate.expected, 'FM999,999,999,999')
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
         (rt.rate_pct IS NULL OR rt.rate_pct >= 50 OR x.rent_request_id IS NOT NULL),
         x.reason, x.granted_by, x.granted_at
    FROM public.rent_requests r
   CROSS JOIN LATERAL (SELECT COALESCE(r.assigned_agent_id, r.agent_id) AS aid) a
    LEFT JOIN public.profiles p ON p.id = a.aid
   CROSS JOIN LATERAL public.agent_collection_rate_7d(a.aid) rt
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
     CROSS JOIN LATERAL public.agent_collection_rate_7d(a.aid) rt
     WHERE r.id = ANY (p_rent_request_ids) AND r.status IN ('approved', 'coo_approved') AND a.aid IS NOT NULL
    ON CONFLICT (rent_request_id) DO UPDATE SET reason = EXCLUDED.reason, granted_by = EXCLUDED.granted_by, granted_at = now(),
                                                rate_pct = EXCLUDED.rate_pct, expected = EXCLUDED.expected, collected = EXCLUDED.collected
    RETURNING rent_request_id, agent_id, rate_pct
  ), logged AS (
    INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
    SELECT v_uid, 'rent_disbursement_rate_exception', 'Allowed rent disbursement with exception: agent below 50% collection over 7 days',
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
    SELECT * INTO v_rate FROM public.agent_collection_rate_7d(v_agent.agent_id);
    v_body := CASE WHEN v_agent.n = 1 THEN 'Management has not released the landlord float for your rent request of UGX '
                   ELSE 'Management has not released the landlord float for your ' || v_agent.n || ' rent requests, UGX ' END
              || to_char(v_agent.total, 'FM999,999,999,999') || '. '
              || COALESCE(v_custom,
                   CASE WHEN v_rate.rate_pct IS NOT NULL
                        THEN 'Your collection rate over the last 7 days is ' || v_rate.rate_pct::text || '% (UGX ' || to_char(v_rate.collected, 'FM999,999,999,999')
                             || ' collected of UGX ' || to_char(v_rate.expected, 'FM999,999,999,999') || ' expected). Management only releases landlord float to agents who collect at least 50% over the last 7 days. Collect more and it can be released.'
                        ELSE 'You did not meet the requirements for landlord float to be released. Management only releases landlord float to agents who collect at least 50% over the last 7 days.' END);
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
