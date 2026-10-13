CREATE OR REPLACE FUNCTION public.sync_portfolio_lock_from_redemption()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_open integer;
  v_status text;
  v_locked_at timestamptz;
BEGIN
  IF NEW.request_type IS DISTINCT FROM 'REDEMPTION_REQUEST' THEN
    RETURN NEW;
  END IF;

  -- Only a redemption that Partner Ops has started processing locks the portfolio.
  -- A pending (just submitted) request leaves the portfolio active.
  SELECT count(*) INTO v_open
  FROM public.portfolio_action_requests r
  WHERE r.portfolio_id = NEW.portfolio_id
    AND r.request_type = 'REDEMPTION_REQUEST'
    AND r.status = 'processing';

  SELECT status, locked_at INTO v_status, v_locked_at
  FROM public.investor_portfolios
  WHERE id = NEW.portfolio_id;

  IF v_status IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_open > 0 AND v_status = 'active' THEN
    UPDATE public.investor_portfolios SET status = 'locked' WHERE id = NEW.portfolio_id;
    INSERT INTO public.system_events (event_type, entity_type, entity_id, actor_id, payload)
    VALUES ('portfolio.locked', 'investor_portfolio', NEW.portfolio_id, NULL,
            jsonb_build_object('reason', 'redemption_processing_started', 'request_id', NEW.id));
  -- Auto-unlock only locks this trigger created (staff locks set locked_at and are left alone).
  ELSIF v_open = 0 AND v_status = 'locked' AND v_locked_at IS NULL THEN
    UPDATE public.investor_portfolios SET status = 'active' WHERE id = NEW.portfolio_id;
    INSERT INTO public.system_events (event_type, entity_type, entity_id, actor_id, payload)
    VALUES ('portfolio.unlocked', 'investor_portfolio', NEW.portfolio_id, NULL,
            jsonb_build_object('reason', 'no_redemption_in_processing', 'request_id', NEW.id));
  END IF;

  RETURN NEW;
END;
$function$;