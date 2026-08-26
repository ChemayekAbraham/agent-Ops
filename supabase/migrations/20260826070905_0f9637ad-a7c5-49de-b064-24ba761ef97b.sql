ALTER TABLE public.promissory_notes
  ADD COLUMN IF NOT EXISTS support_mode text NOT NULL DEFAULT 'existing_support';

UPDATE public.promissory_notes n
SET support_mode = 'self_support'
WHERE EXISTS (
  SELECT 1 FROM public.promissory_note_plan_intents i WHERE i.note_id = n.id
);

ALTER TABLE public.promissory_notes
  DROP CONSTRAINT IF EXISTS promissory_notes_support_mode_check;
ALTER TABLE public.promissory_notes
  ADD CONSTRAINT promissory_notes_support_mode_check
  CHECK (support_mode IN ('self_support','existing_support'));

CREATE OR REPLACE FUNCTION public.promissory_self_support_context(p_user uuid)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'required', COUNT(DISTINCT n.id) FILTER (
      WHERE n.support_mode = 'self_support'
         OR EXISTS (
           SELECT 1 FROM public.promissory_note_plan_intents ix
           WHERE ix.note_id = n.id AND ix.status IN ('reserved','funded')
         )
    ) > 0,
    'plans', COUNT(i.id) FILTER (WHERE i.status IN ('reserved','funded')),
    'amount', COALESCE(SUM(i.amount) FILTER (WHERE i.status IN ('reserved','funded')), 0),
    'note_ids', COALESCE(
      jsonb_agg(DISTINCT n.id) FILTER (
        WHERE n.support_mode = 'self_support'
           OR EXISTS (
             SELECT 1 FROM public.promissory_note_plan_intents ix
             WHERE ix.note_id = n.id AND ix.status IN ('reserved','funded')
           )
      ), '[]'::jsonb
    )
  )
  FROM public.promissory_notes n
  LEFT JOIN public.promissory_note_plan_intents i ON i.note_id = n.id
  WHERE p_user IS NOT NULL
    AND n.partner_user_id = p_user
    AND n.status <> 'cancelled';
$$;

CREATE OR REPLACE FUNCTION public.assert_no_promissory_self_support(p_user uuid, p_path text)
RETURNS void
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v jsonb := public.promissory_self_support_context(p_user);
BEGIN
  IF COALESCE((v->>'required')::boolean, false) THEN
    RAISE EXCEPTION
      'PROMISSORY_SELF_SUPPORT_REQUIRED: this partner is attached to a self-support promissory note with % tenant plan(s) (UGX %). Their capital must use the self-support flow, not normal portfolio creation.',
      v->>'plans', v->>'amount'
      USING ERRCODE = 'check_violation',
            HINT = 'path=' || COALESCE(p_path,'unknown') || '; notes=' || (v->>'note_ids');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_promissory_portfolio_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.investor_id IS NOT NULL
     AND COALESCE(current_setting('psm.self_support_insert', true), '') <> 'on' THEN
    PERFORM public.assert_no_promissory_self_support(NEW.investor_id, 'investor_portfolios_trigger');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_promissory_portfolio_insert ON public.investor_portfolios;
CREATE TRIGGER trg_guard_promissory_portfolio_insert
BEFORE INSERT ON public.investor_portfolios
FOR EACH ROW EXECUTE FUNCTION public.guard_promissory_portfolio_insert();

CREATE OR REPLACE FUNCTION public.agent_create_promissory_note(
  p_payload jsonb,
  p_rent_request_ids uuid[] DEFAULT '{}'::uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ids uuid[] := COALESCE(p_rent_request_ids, '{}'::uuid[]);
  v_amount numeric := COALESCE((p_payload->>'amount')::numeric, 0);
  v_name text := btrim(COALESCE(p_payload->>'partner_name', ''));
  v_whatsapp text := btrim(COALESCE(p_payload->>'whatsapp_number', ''));
  v_type text := COALESCE(NULLIF(btrim(p_payload->>'contribution_type'), ''), 'once_off');
  v_support_mode text := COALESCE(NULLIF(btrim(p_payload->>'support_mode'), ''), 'existing_support');
  v_note public.promissory_notes;
  v_valid integer := 0;
  v_sum numeric := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF NOT (
    public.has_role(v_uid, 'agent') OR public.has_role(v_uid, 'senior_agent')
    OR public.has_role(v_uid, 'sub_agent') OR public.is_ops_role(v_uid)
  ) THEN
    RAISE EXCEPTION 'Not authorised to create promissory notes' USING ERRCODE = '42501';
  END IF;
  IF length(v_name) < 3 THEN RAISE EXCEPTION 'Partner name is required' USING ERRCODE = '22023'; END IF;
  IF length(regexp_replace(v_whatsapp, '\D', '', 'g')) < 9 THEN RAISE EXCEPTION 'A valid WhatsApp number is required' USING ERRCODE = '22023'; END IF;
  IF v_amount <= 0 THEN RAISE EXCEPTION 'Promised amount must be greater than zero' USING ERRCODE = '22023'; END IF;
  IF v_support_mode NOT IN ('self_support','existing_support') THEN
    RAISE EXCEPTION 'INVALID_SUPPORT_MODE' USING ERRCODE = '22023';
  END IF;
  IF v_support_mode = 'self_support' AND COALESCE(array_length(v_ids,1),0) = 0 THEN
    RAISE EXCEPTION 'SELF_SUPPORT_PLANS_REQUIRED: select at least one tenant rent plan for self support.' USING ERRCODE = '23514';
  END IF;
  IF v_support_mode = 'existing_support' AND COALESCE(array_length(v_ids,1),0) > 0 THEN
    RAISE EXCEPTION 'EXISTING_SUPPORT_HAS_PLANS: tenant plan selections belong to self support.' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.promissory_notes (
    agent_id, partner_name, whatsapp_number, phone_number, email,
    amount, contribution_type, deduction_day, next_deduction_date, support_mode
  ) VALUES (
    v_uid, v_name, v_whatsapp,
    NULLIF(btrim(COALESCE(p_payload->>'phone_number','')), ''),
    NULLIF(btrim(COALESCE(p_payload->>'email','')), ''),
    v_amount,
    CASE WHEN v_type = 'monthly' THEN 'monthly' ELSE 'once_off' END,
    CASE WHEN v_type = 'monthly' THEN NULLIF(p_payload->>'deduction_day','')::integer END,
    CASE WHEN v_type = 'monthly' THEN NULLIF(p_payload->>'next_deduction_date','')::date END,
    v_support_mode
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

    SELECT COUNT(*), COALESCE(SUM(amount),0) INTO v_valid, v_sum
    FROM public.promissory_note_plan_intents
    WHERE note_id = v_note.id AND status = 'reserved';

    IF v_valid <> array_length(v_ids,1) THEN
      RAISE EXCEPTION 'PLANS_UNAVAILABLE: some selected rent plans are no longer ready to fund. Refresh and try again.' USING ERRCODE = '23514';
    END IF;
    IF v_sum > v_amount THEN
      RAISE EXCEPTION 'PLANS_EXCEED_AMOUNT: attached plans total more than the promised amount.' USING ERRCODE = '23514';
    END IF;
  END IF;

  PERFORM public.psm_queue_promissory_pledge_notice(v_note.id);

  RETURN jsonb_build_object(
    'note', to_jsonb(v_note), 'support_mode', v_support_mode,
    'attached_count', v_valid, 'attached_amount', v_sum,
    'monthly_return', round(v_amount * 0.15), 'annual_return', round(v_amount * 0.15 * 12)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.psm_mark_self_support_insert()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM set_config('psm.self_support_insert', 'on', true);
END;
$$;
REVOKE ALL ON FUNCTION public.psm_mark_self_support_insert() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.psm_mark_self_support_insert() TO service_role;

CREATE OR REPLACE FUNCTION public.smoke_promissory_support_modes()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_result jsonb := '[]'::jsonb;
  v_self_user uuid := '00000000-0000-4000-8000-00000000d101';
  v_existing_user uuid := '00000000-0000-4000-8000-00000000d102';
  v_agent uuid := '00000000-0000-4000-8000-00000000d103';
  v_self_note uuid := '00000000-0000-4000-8000-00000000d104';
  v_existing_note uuid := '00000000-0000-4000-8000-00000000d105';
  v_self_context jsonb;
  v_existing_context jsonb;
BEGIN
  BEGIN
    INSERT INTO public.profiles(id, full_name, phone, email) VALUES
      (v_self_user, 'Rollback Self Partner', '0709999701', 'rollback-self@example.invalid'),
      (v_existing_user, 'Rollback Existing Partner', '0709999702', 'rollback-existing@example.invalid'),
      (v_agent, 'Rollback Agent', '0709999703', 'rollback-agent@example.invalid');

    INSERT INTO public.promissory_notes(id, agent_id, partner_name, whatsapp_number, amount, status, partner_user_id, support_mode)
    VALUES
      (v_self_note, v_agent, 'Rollback Self Partner', '0709999701', 100000, 'pending', v_self_user, 'self_support'),
      (v_existing_note, v_agent, 'Rollback Existing Partner', '0709999702', 100000, 'pending', v_existing_user, 'existing_support');

    v_self_context := public.promissory_self_support_context(v_self_user);
    v_existing_context := public.promissory_self_support_context(v_existing_user);
    v_result := v_result || jsonb_build_object(
      'step','support_mode_context',
      'pass', COALESCE((v_self_context->>'required')::boolean,false)
              AND NOT COALESCE((v_existing_context->>'required')::boolean,false),
      'self',v_self_context,'existing',v_existing_context
    );

    BEGIN
      INSERT INTO public.investor_portfolios(
        investor_id,agent_id,portfolio_code,investment_amount,duration_months,roi_percentage,roi_mode,status,portfolio_pin,activation_token
      ) VALUES (v_self_user,v_agent,'SMOKE-SELF',100000,1,15,'monthly_payout','pending_ops_approval','0000',gen_random_uuid());
      v_result := v_result || jsonb_build_object('step','normal_portfolio_blocked','pass',false);
    EXCEPTION WHEN check_violation THEN
      v_result := v_result || jsonb_build_object('step','normal_portfolio_blocked','pass',SQLERRM LIKE 'PROMISSORY_SELF_SUPPORT_REQUIRED%','error',SQLERRM);
    END;

    INSERT INTO public.investor_portfolios(
      investor_id,agent_id,portfolio_code,investment_amount,duration_months,roi_percentage,roi_mode,status,portfolio_pin,activation_token
    ) VALUES (v_existing_user,v_agent,'SMOKE-EXISTING',100000,1,15,'monthly_payout','pending_ops_approval','0000',gen_random_uuid());
    v_result := v_result || jsonb_build_object('step','existing_support_normal_portfolio_allowed','pass',true);

    PERFORM set_config('psm.self_support_insert','on',true);
    INSERT INTO public.investor_portfolios(
      investor_id,agent_id,portfolio_code,investment_amount,duration_months,roi_percentage,roi_mode,status,portfolio_pin,activation_token
    ) VALUES (v_self_user,v_agent,'SMOKE-SELF-OK',100000,1,15,'monthly_payout','pending_ops_approval','0000',gen_random_uuid());
    v_result := v_result || jsonb_build_object('step','dedicated_self_support_insert_allowed','pass',true);

    RAISE EXCEPTION 'SMOKE_ROLLBACK' USING DETAIL = v_result::text;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'SMOKE_ROLLBACK' THEN
      RETURN jsonb_build_object('rolled_back',true,'results',PG_EXCEPTION_DETAIL::jsonb);
    END IF;
    RETURN jsonb_build_object('rolled_back',true,'pass',false,'error',SQLERRM,'results',v_result);
  END;
END;
$$;
REVOKE ALL ON FUNCTION public.smoke_promissory_support_modes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.smoke_promissory_support_modes() TO service_role;

GRANT EXECUTE ON FUNCTION public.promissory_self_support_context(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assert_no_promissory_self_support(uuid,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agent_create_promissory_note(jsonb,uuid[]) TO authenticated, service_role;