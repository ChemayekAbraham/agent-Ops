CREATE OR REPLACE FUNCTION public.tg_refresh_wallet_projection_on_wr()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid;
  v_old uuid;
BEGIN
  -- Short-circuit: a pure merchant-claim UPDATE only touches
  -- assigned_cashout_agent_id / dispatched_at. Wallet buckets are
  -- unaffected, so skip the expensive projection refresh that was
  -- making the Claim button hang under load.
  IF TG_OP = 'UPDATE'
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.amount IS NOT DISTINCT FROM OLD.amount
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.agent_id IS NOT DISTINCT FROM OLD.agent_id
     AND NEW.proxy_partner_id IS NOT DISTINCT FROM OLD.proxy_partner_id
     AND NEW.reason IS NOT DISTINCT FROM OLD.reason
  THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_user := CASE
      WHEN OLD.proxy_partner_id IS NOT NULL AND OLD.agent_id IS NOT NULL THEN OLD.agent_id
      ELSE OLD.user_id
    END;
  ELSE
    v_user := CASE
      WHEN NEW.proxy_partner_id IS NOT NULL AND NEW.agent_id IS NOT NULL THEN NEW.agent_id
      ELSE NEW.user_id
    END;
  END IF;

  IF v_user IS NOT NULL THEN
    PERFORM public.refresh_wallet_projection_for(v_user);
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_old := CASE
      WHEN OLD.proxy_partner_id IS NOT NULL AND OLD.agent_id IS NOT NULL THEN OLD.agent_id
      ELSE OLD.user_id
    END;
    IF v_old IS NOT NULL AND v_old IS DISTINCT FROM v_user THEN
      PERFORM public.refresh_wallet_projection_for(v_old);
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;