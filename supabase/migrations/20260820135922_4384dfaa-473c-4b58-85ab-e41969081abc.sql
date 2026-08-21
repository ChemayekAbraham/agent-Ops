CREATE OR REPLACE FUNCTION public.sync_portfolio_lock_from_redemption()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_open integer;
  v_status text;
BEGIN
  IF NEW.request_type IS DISTINCT FROM 'REDEMPTION_REQUEST' THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_open
  FROM public.portfolio_action_requests r
  WHERE r.portfolio_id = NEW.portfolio_id
    AND r.request_type = 'REDEMPTION_REQUEST'
    AND r.status IN ('pending', 'processing');

  SELECT status INTO v_status
  FROM public.investor_portfolios
  WHERE id = NEW.portfolio_id;

  IF v_status IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_open > 0 AND v_status = 'active' THEN
    UPDATE public.investor_portfolios
       SET status = 'locked'
     WHERE id = NEW.portfolio_id;

    INSERT INTO public.system_events (event_type, entity_type, entity_id, actor_id, payload)
    VALUES ('portfolio.locked', 'investor_portfolio', NEW.portfolio_id, NULL,
            jsonb_build_object('reason', 'open_redemption_request', 'request_id', NEW.id));
  ELSIF v_open = 0 AND v_status = 'locked' THEN
    UPDATE public.investor_portfolios
       SET status = 'active'
     WHERE id = NEW.portfolio_id;

    INSERT INTO public.system_events (event_type, entity_type, entity_id, actor_id, payload)
    VALUES ('portfolio.unlocked', 'investor_portfolio', NEW.portfolio_id, NULL,
            jsonb_build_object('reason', 'no_open_redemption_request', 'request_id', NEW.id));
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_portfolio_lock_from_redemption ON public.portfolio_action_requests;
CREATE TRIGGER trg_sync_portfolio_lock_from_redemption
AFTER INSERT OR UPDATE OF status ON public.portfolio_action_requests
FOR EACH ROW EXECUTE FUNCTION public.sync_portfolio_lock_from_redemption();

UPDATE public.investor_portfolios p
   SET status = 'locked'
 WHERE p.status = 'active'
   AND EXISTS (
     SELECT 1 FROM public.portfolio_action_requests r
      WHERE r.portfolio_id = p.id
        AND r.request_type = 'REDEMPTION_REQUEST'
        AND r.status IN ('pending', 'processing')
   );