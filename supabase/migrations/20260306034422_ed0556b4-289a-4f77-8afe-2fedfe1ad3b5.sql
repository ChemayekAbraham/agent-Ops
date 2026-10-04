CREATE OR REPLACE FUNCTION public.boost_tenant_credit_on_agent_rent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_bonus      NUMERIC;
  v_agent_bonus       NUMERIC;
  v_current_bonus     NUMERIC;
  v_new_bonus         NUMERIC;
  v_new_total         NUMERIC;
  v_base_limit        NUMERIC;
  v_agent_name        TEXT;
  v_existing_limit    RECORD;
BEGIN
  IF NEW.status = 'funded'
     AND (OLD.status IS DISTINCT FROM 'funded')
     AND NEW.agent_id IS NOT NULL
     AND NEW.tenant_id IS NOT NULL
  THEN
    v_tenant_bonus := GREATEST(10000, LEAST(ROUND(NEW.rent_amount * 0.10), 300000));

    SELECT full_name INTO v_agent_name
    FROM public.profiles WHERE id = NEW.agent_id;

    SELECT * INTO v_existing_limit
    FROM public.credit_access_limits WHERE user_id = NEW.tenant_id;

    IF v_existing_limit IS NULL THEN
      INSERT INTO public.credit_access_limits (user_id, base_limit, bonus_from_rent_history)
      VALUES (NEW.tenant_id, 30000, v_tenant_bonus);
      v_new_total := 30000 + v_tenant_bonus;
    ELSE
      v_current_bonus := COALESCE(v_existing_limit.bonus_from_rent_history, 0);
      v_new_bonus     := v_current_bonus + v_tenant_bonus;
      v_base_limit    := COALESCE(v_existing_limit.base_limit, 30000);
      v_new_total     := v_base_limit + v_new_bonus
                         + COALESCE(v_existing_limit.bonus_from_ratings, 0)
                         + COALESCE(v_existing_limit.bonus_from_receipts, 0)
                         + COALESCE(v_existing_limit.bonus_from_landlord_rent, 0);
      UPDATE public.credit_access_limits
      SET bonus_from_rent_history = v_new_bonus, updated_at = now()
      WHERE user_id = NEW.tenant_id;
    END IF;

    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (NEW.tenant_id, '📈 Your Loan Limit Just Increased!',
      'Great news! Because your agent ' || COALESCE(v_agent_name, 'your agent')
        || ' paid UGX ' || TO_CHAR(NEW.rent_amount, 'FM999,999,999')
        || ' rent for you, your available loan limit has grown by UGX '
        || TO_CHAR(v_tenant_bonus, 'FM999,999,999')
        || '. Keep up timely rent payments to unlock even more credit!',
      'success',
      jsonb_build_object('type','credit_limit_increase','bonus_added',v_tenant_bonus,'new_total_limit',v_new_total,'rent_request_id',NEW.id,'rent_amount',NEW.rent_amount));

    v_agent_bonus := GREATEST(5000, LEAST(ROUND(NEW.rent_amount * 0.05), 150000));

    SELECT * INTO v_existing_limit
    FROM public.credit_access_limits WHERE user_id = NEW.agent_id;

    IF v_existing_limit IS NULL THEN
      INSERT INTO public.credit_access_limits (user_id, base_limit, bonus_from_rent_history)
      VALUES (NEW.agent_id, 30000, v_agent_bonus);
      v_new_total := 30000 + v_agent_bonus;
    ELSE
      v_current_bonus := COALESCE(v_existing_limit.bonus_from_rent_history, 0);
      v_new_bonus     := v_current_bonus + v_agent_bonus;
      v_base_limit    := COALESCE(v_existing_limit.base_limit, 30000);
      v_new_total     := v_base_limit + v_new_bonus
                         + COALESCE(v_existing_limit.bonus_from_ratings, 0)
                         + COALESCE(v_existing_limit.bonus_from_receipts, 0)
                         + COALESCE(v_existing_limit.bonus_from_landlord_rent, 0);
      UPDATE public.credit_access_limits
      SET bonus_from_rent_history = v_new_bonus, updated_at = now()
      WHERE user_id = NEW.agent_id;
    END IF;

    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (NEW.agent_id, '🎯 Agent Credit Boost!',
      'Your credit limit increased by UGX ' || TO_CHAR(v_agent_bonus, 'FM999,999,999')
        || ' for facilitating rent of UGX ' || TO_CHAR(NEW.rent_amount, 'FM999,999,999')
        || '. Your new limit: UGX ' || TO_CHAR(v_new_total, 'FM999,999,999') || '.',
      'success',
      jsonb_build_object('type','agent_credit_boost','bonus_added',v_agent_bonus,'new_total_limit',v_new_total,'rent_request_id',NEW.id,'rent_amount',NEW.rent_amount));
  END IF;
  RETURN NEW;
END;
$$;