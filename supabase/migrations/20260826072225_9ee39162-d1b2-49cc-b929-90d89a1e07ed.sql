CREATE OR REPLACE FUNCTION public.enforce_signup_verification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_role text := coalesce(current_setting('app.signup_actor_role', true), '');
  v_has_auth_user boolean := false;
  v_has_email boolean := false;
  v_actor_is_auth_admin boolean := session_user IN ('supabase_auth_admin','service_role');
BEGIN
  IF v_actor_role IN (
    'agent','senior_agent','sub_agent','manager','ceo','coo','cfo','cto','cmo',
    'super_admin','admin','tenant_ops','landlord_ops','agent_ops','financial_ops',
    'partner_ops','hr','employee','crm','service_role'
  ) THEN
    RETURN NEW;
  END IF;

  SELECT true, (u.email IS NOT NULL AND length(btrim(u.email)) > 0)
  INTO v_has_auth_user, v_has_email
  FROM auth.users u
  WHERE u.id = NEW.id;

  -- Profiles created from a verified auth identity are allowed. This keeps the
  -- normal auth/profile sync and promissory activation paths working without
  -- the retired phone_verifications table.
  IF COALESCE(v_has_auth_user,false) AND (COALESCE(v_has_email,false) OR v_actor_is_auth_admin) THEN
    RETURN NEW;
  END IF;

  IF NEW.phone IS NOT NULL AND length(btrim(NEW.phone)) > 0 THEN
    RAISE EXCEPTION 'signup_otp_required: phone-only signups must complete OTP verification through auth'
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_partner_self_commitments_promissory_note
ON public.partner_self_commitments(promissory_note_id)
WHERE promissory_note_id IS NOT NULL AND status <> 'cancelled';

CREATE UNIQUE INDEX IF NOT EXISTS ux_funder_pending_portfolios_promissory_note
ON public.funder_pending_portfolios(promissory_note_id)
WHERE promissory_note_id IS NOT NULL AND status <> 'rejected';

CREATE OR REPLACE FUNCTION public.guard_promissory_portfolio_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.investor_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.partner_self_commitments c
       WHERE c.partner_id = NEW.investor_id
         AND c.status = 'pending_ops_approval'
         AND c.promissory_note_id IS NOT NULL
     ) THEN
    PERFORM public.assert_no_promissory_self_support(NEW.investor_id, 'investor_portfolios_trigger');
  END IF;
  RETURN NEW;
END;
$$;

DROP FUNCTION IF EXISTS public.psm_mark_self_support_insert();

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
    INSERT INTO public.promissory_notes(id, agent_id, partner_name, whatsapp_number, amount, status, partner_user_id, support_mode)
    VALUES
      (v_self_note, v_agent, 'Rollback Self Partner', '0709999701', 100000, 'pending', v_self_user, 'self_support'),
      (v_existing_note, v_agent, 'Rollback Existing Partner', '0709999702', 100000, 'pending', v_existing_user, 'existing_support');

    v_self_context := public.promissory_self_support_context(v_self_user);
    v_existing_context := public.promissory_self_support_context(v_existing_user);
    v_result := v_result || jsonb_build_object(
      'step','support_mode_context',
      'pass', COALESCE((v_self_context->>'required')::boolean,false)
              AND NOT COALESCE((v_existing_context->>'required')::boolean,false)
    );

    BEGIN
      INSERT INTO public.investor_portfolios(
        investor_id,agent_id,portfolio_code,investment_amount,duration_months,roi_percentage,roi_mode,status,portfolio_pin,activation_token
      ) VALUES (v_self_user,v_agent,'SMOKE-SELF',100000,1,15,'monthly_payout','pending_ops_approval','0000',gen_random_uuid());
      v_result := v_result || jsonb_build_object('step','normal_portfolio_blocked','pass',false);
    EXCEPTION WHEN check_violation THEN
      v_result := v_result || jsonb_build_object('step','normal_portfolio_blocked','pass',SQLERRM LIKE 'PROMISSORY_SELF_SUPPORT_REQUIRED%');
    END;

    INSERT INTO public.investor_portfolios(
      investor_id,agent_id,portfolio_code,investment_amount,duration_months,roi_percentage,roi_mode,status,portfolio_pin,activation_token
    ) VALUES (v_existing_user,v_agent,'SMOKE-EXISTING',100000,1,15,'monthly_payout','pending_ops_approval','0000',gen_random_uuid());
    v_result := v_result || jsonb_build_object('step','existing_support_normal_portfolio_allowed','pass',true);

    INSERT INTO public.partner_self_commitments(
      partner_id, committed_amount, term_months, monthly_rate, lines_count,
      idempotency_key, status, promissory_note_id
    ) VALUES (
      v_self_user, 100000, 1, 15, 1,
      'smoke-self-support-' || v_self_note::text, 'pending_ops_approval', v_self_note
    );

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
REVOKE ALL ON FUNCTION public.guard_promissory_portfolio_insert() FROM PUBLIC, anon, authenticated;