
CREATE OR REPLACE FUNCTION public.trg_welile_home_auto_collect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_sub uuid;
  v_out numeric;
  v_avail numeric;
  v_amt numeric;
BEGIN
  IF NEW.event_type NOT IN ('deposit_approved','funds_added') THEN RETURN NEW; END IF;
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;

  SELECT id, outstanding_balance
  INTO v_sub, v_out
  FROM public.welile_homes_subscriptions
  WHERE tenant_id = NEW.user_id
    AND mode = 'agent_collection'
    AND subscription_status = 'active'
    AND outstanding_balance > 0
  ORDER BY next_due_date NULLS LAST
  LIMIT 1;

  IF v_sub IS NULL THEN RETURN NEW; END IF;

  SELECT GREATEST(0, COALESCE(total_visible, 0))
  INTO v_avail
  FROM public.v_user_wallet_strict
  WHERE user_id = NEW.user_id;

  v_amt := LEAST(COALESCE(v_out, 0), COALESCE(v_avail, 0));
  IF v_amt > 0 THEN
    PERFORM public.welile_home_record_collection(v_sub, v_amt, 'tenant_wallet', 'Auto-collected on deposit');
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Best-effort only: never block the deposit event.
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_welile_home_auto_collect ON public.system_events;
CREATE TRIGGER trg_welile_home_auto_collect
  AFTER INSERT ON public.system_events
  FOR EACH ROW EXECUTE FUNCTION public.trg_welile_home_auto_collect();
