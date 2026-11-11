-- Self-support agent facilitation fee, Phase 5: agent promissory notes are self-support only
-- (owner design 2026-11-10: "we shall remove the company managed option when creating a note").
--
-- While self_support_fee_policy is on, agent_create_promissory_note refuses support_mode
-- 'existing_support' (company-managed) with COMPANY_MANAGED_NOTES_CLOSED. Unchanged: NeexaBot auto
-- notes (neexabot_ensure_partner_note, company-managed by design), house notes
-- (agent_create_promissory_note_for_houses, already self-support) and every note already recorded,
-- including the pending company-managed ones.
-- The promised amount must cover what the partner will pay for the attached plans: rent + the agent
-- fee (equal to the rent while the policy is off). attached_partner_pays is returned for the screen.

CREATE OR REPLACE FUNCTION public.agent_create_promissory_note(p_payload jsonb, p_rent_request_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_ids uuid[] := COALESCE(p_rent_request_ids, '{}'::uuid[]);
  v_amount numeric := COALESCE((p_payload->>'amount')::numeric, 0);
  v_name text := btrim(COALESCE(p_payload->>'partner_name', ''));
  v_whatsapp text := btrim(COALESCE(p_payload->>'whatsapp_number', ''));
  v_email text := lower(btrim(COALESCE(p_payload->>'email', '')));
  v_type text := COALESCE(NULLIF(btrim(p_payload->>'contribution_type'), ''), 'once_off');
  v_support_mode text := COALESCE(NULLIF(btrim(p_payload->>'support_mode'), ''), 'existing_support');
  v_recorded_on date := COALESCE(NULLIF(btrim(COALESCE(p_payload->>'recorded_on','')), '')::date, CURRENT_DATE);
  v_fulfil_on date := NULLIF(btrim(COALESCE(p_payload->>'fulfilment_due_on','')), '')::date;
  v_note public.promissory_notes;
  v_valid integer := 0;
  v_sum numeric := 0;
  v_pay numeric := 0;  -- what the partner will pay for the attached plans (rent + agent fee)
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF NOT (
    public.has_role(v_uid, 'agent') OR public.has_role(v_uid, 'senior_agent')
    OR public.has_role(v_uid, 'sub_agent') OR public.is_ops_role(v_uid)
    OR EXISTS (
      SELECT 1
      FROM public.partner_lead_assignments pla
      WHERE pla.agent_id = v_uid
        AND pla.detached_at IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'Not authorised to create promissory notes' USING ERRCODE = '42501';
  END IF;
  IF length(v_name) < 3 THEN RAISE EXCEPTION 'Partner name is required' USING ERRCODE = '22023'; END IF;
  IF length(regexp_replace(v_whatsapp, '\D', '', 'g')) < 9 THEN RAISE EXCEPTION 'A valid WhatsApp number is required' USING ERRCODE = '22023'; END IF;
  -- Email is optional; validate only when one was supplied.
  IF v_email <> '' AND (length(v_email) > 255 OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') THEN
    RAISE EXCEPTION 'EMAIL_INVALID: enter a valid email address or leave it blank.' USING ERRCODE = '22023';
  END IF;
  IF v_amount <= 0 THEN RAISE EXCEPTION 'Promised amount must be greater than zero' USING ERRCODE = '22023'; END IF;
  IF v_fulfil_on IS NOT NULL AND v_fulfil_on < v_recorded_on THEN
    RAISE EXCEPTION 'FULFILMENT_BEFORE_RECORDED: the fulfilment date cannot be earlier than the recording date.' USING ERRCODE = '22023';
  END IF;
  IF v_support_mode NOT IN ('self_support','existing_support') THEN
    RAISE EXCEPTION 'INVALID_SUPPORT_MODE' USING ERRCODE = '22023';
  END IF;
  -- Owner design 2026-11-10: while the self-support agent fee is on, agents record self-support notes
  -- only. NeexaBot notes (neexabot_ensure_partner_note) and notes already recorded are unaffected.
  IF v_support_mode = 'existing_support' AND public.self_support_topups_closed() THEN
    RAISE EXCEPTION 'COMPANY_MANAGED_NOTES_CLOSED: promissory notes are self-support only. Select the tenant rent plans the partner will support.'
      USING ERRCODE = '23514';
  END IF;
  IF v_support_mode = 'self_support' AND COALESCE(array_length(v_ids,1),0) = 0 THEN
    RAISE EXCEPTION 'SELF_SUPPORT_PLANS_REQUIRED: select at least one tenant rent plan for self support.' USING ERRCODE = '23514';
  END IF;
  IF v_support_mode = 'existing_support' AND COALESCE(array_length(v_ids,1),0) > 0 THEN
    RAISE EXCEPTION 'EXISTING_SUPPORT_HAS_PLANS: tenant plan selections belong to self support.' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.promissory_notes (
    agent_id, partner_name, whatsapp_number, phone_number, email,
    amount, contribution_type, deduction_day, next_deduction_date, support_mode,
    recorded_on, fulfilment_due_on
  ) VALUES (
    v_uid, v_name, v_whatsapp,
    NULLIF(btrim(COALESCE(p_payload->>'phone_number','')), ''),
    NULLIF(v_email, ''),
    v_amount,
    CASE WHEN v_type = 'monthly' THEN 'monthly' ELSE 'once_off' END,
    CASE WHEN v_type = 'monthly' THEN NULLIF(p_payload->>'deduction_day','')::integer END,
    CASE WHEN v_type = 'monthly' THEN NULLIF(p_payload->>'next_deduction_date','')::date END,
    v_support_mode,
    v_recorded_on, v_fulfil_on
  ) RETURNING * INTO v_note;

  IF COALESCE(array_length(v_ids,1),0) > 0 THEN
    INSERT INTO public.promissory_note_plan_intents (note_id, rent_request_id, agent_id, amount)
    SELECT v_note.id, p.rent_request_id, v_uid, p.funding_amount
    FROM public.v_partner_self_fundable_plans p
    WHERE p.rent_request_id = ANY(v_ids)
      AND p.held_by IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.promissory_note_plan_intents i
        WHERE i.rent_request_id = p.rent_request_id AND i.status = 'reserved'
      );

    SELECT COUNT(*), COALESCE(SUM(amount),0), COALESCE(SUM(public.self_support_gross(amount)),0)
      INTO v_valid, v_sum, v_pay
    FROM public.promissory_note_plan_intents
    WHERE note_id = v_note.id AND status = 'reserved';

    IF v_valid <> array_length(v_ids,1) THEN
      RAISE EXCEPTION 'PLANS_UNAVAILABLE: some selected rent plans are no longer ready to fund. Refresh and try again.' USING ERRCODE = '23514';
    END IF;
    IF v_pay > v_amount THEN
      RAISE EXCEPTION 'PLANS_EXCEED_AMOUNT: attached plans total more than the promised amount.' USING ERRCODE = '23514';
    END IF;
  END IF;

  PERFORM public.psm_queue_promissory_pledge_notice(v_note.id);

  RETURN jsonb_build_object(
    'support_mode', v_support_mode, 'attached_count', v_valid, 'attached_amount', v_sum,
    'attached_partner_pays', v_pay
  ) || public._promissory_note_rate_json(v_note, v_uid);
END;
$function$;
