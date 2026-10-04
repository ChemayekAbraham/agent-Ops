
-- Function: boost tenant credit limit when an agent-submitted rent request is funded
CREATE OR REPLACE FUNCTION public.boost_tenant_credit_on_agent_rent()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_bonus_increment NUMERIC;
  v_current_bonus NUMERIC;
  v_new_bonus NUMERIC;
  v_new_total NUMERIC;
  v_base_limit NUMERIC;
  v_agent_name TEXT;
  v_existing_limit RECORD;
BEGIN
  -- Only trigger when status changes TO 'funded' and there is an agent_id
  IF NEW.status = 'funded' 
     AND (OLD.status IS DISTINCT FROM 'funded')
     AND NEW.agent_id IS NOT NULL
     AND NEW.tenant_id IS NOT NULL
  THEN
    -- Sustainable bonus: 10% of rent amount, minimum 10,000, maximum 300,000 per request
    v_bonus_increment := GREATEST(10000, LEAST(ROUND(NEW.rent_amount * 0.10), 300000));

    -- Get agent name for notification
    SELECT full_name INTO v_agent_name
    FROM public.profiles
    WHERE id = NEW.agent_id;

    -- Upsert credit_access_limits for the tenant
    SELECT * INTO v_existing_limit
    FROM public.credit_access_limits
    WHERE user_id = NEW.tenant_id;

    IF v_existing_limit IS NULL THEN
      -- Create a new record
      INSERT INTO public.credit_access_limits (
        user_id, base_limit, bonus_from_rent_history, total_limit
      )
      VALUES (
        NEW.tenant_id,
        30000,
        v_bonus_increment,
        30000 + v_bonus_increment
      );
      v_new_total := 30000 + v_bonus_increment;
    ELSE
      -- Accumulate onto existing bonus
      v_current_bonus := COALESCE(v_existing_limit.bonus_from_rent_history, 0);
      v_new_bonus := v_current_bonus + v_bonus_increment;
      v_base_limit := COALESCE(v_existing_limit.base_limit, 30000);
      v_new_total := v_base_limit
                     + v_new_bonus
                     + COALESCE(v_existing_limit.bonus_from_ratings, 0)
                     + COALESCE(v_existing_limit.bonus_from_receipts, 0)
                     + COALESCE(v_existing_limit.bonus_from_landlord_rent, 0);

      UPDATE public.credit_access_limits
      SET bonus_from_rent_history = v_new_bonus,
          total_limit = v_new_total,
          updated_at = now()
      WHERE user_id = NEW.tenant_id;
    END IF;

    -- Notify the tenant about their credit limit increase
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      NEW.tenant_id,
      '📈 Your Loan Limit Just Increased!',
      'Great news! Because your agent ' || COALESCE(v_agent_name, 'your agent') || ' paid UGX ' 
        || TO_CHAR(NEW.rent_amount, 'FM999,999,999') 
        || ' rent for you, your available loan limit has grown by UGX ' 
        || TO_CHAR(v_bonus_increment, 'FM999,999,999')
        || '. Keep up timely rent payments to unlock even more credit!',
      'success',
      jsonb_build_object(
        'type', 'credit_limit_increase',
        'bonus_added', v_bonus_increment,
        'new_total_limit', COALESCE(v_new_total, 30000 + v_bonus_increment),
        'rent_request_id', NEW.id,
        'rent_amount', NEW.rent_amount
      )
    );

    RAISE LOG '[boost_tenant_credit] Tenant % credit boosted by % (rent_amount=%, request=%)',
      NEW.tenant_id, v_bonus_increment, NEW.rent_amount, NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

-- Drop old trigger if exists
DROP TRIGGER IF EXISTS trg_boost_tenant_credit_on_agent_rent ON public.rent_requests;

-- Create the trigger on rent_requests status change
CREATE TRIGGER trg_boost_tenant_credit_on_agent_rent
  AFTER UPDATE OF status ON public.rent_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.boost_tenant_credit_on_agent_rent();
