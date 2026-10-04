CREATE OR REPLACE FUNCTION public.enforce_roi_cycle_once()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cycle_anchor text;
  v_cycle_key text;
  v_credited_exists boolean;
  v_open_pending_exists boolean;
BEGIN
  -- Only guard ROI payout requests tied to a partner portfolio.
  IF NEW.category IS DISTINCT FROM 'roi_payout'
     OR NEW.source_table IS DISTINCT FROM 'investor_portfolios'
     OR NEW.source_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Resolve the cycle anchor from the portfolio's current next_roi_date
  -- (advances only on approval), falling back to today when null. This mirrors
  -- the idempotency key used by the client + approve-wallet-operation edge fn.
  SELECT COALESCE(next_roi_date::text, to_char(now(), 'YYYY-MM-DD'))
    INTO v_cycle_anchor
    FROM public.investor_portfolios
   WHERE id = NEW.source_id;

  IF v_cycle_anchor IS NULL THEN
    v_cycle_anchor := to_char(now(), 'YYYY-MM-DD');
  END IF;

  v_cycle_key := 'roi-cycle-' || NEW.source_id::text || '-' || v_cycle_anchor;

  -- 1) Already credited this cycle? Block.
  SELECT EXISTS (
    SELECT 1 FROM public.general_ledger
     WHERE idempotency_key = v_cycle_key
  ) INTO v_credited_exists;

  IF v_credited_exists THEN
    RAISE EXCEPTION 'Duplicate ROI payout blocked: portfolio % already received its ROI for the % cycle.', NEW.source_id, v_cycle_anchor
      USING ERRCODE = 'unique_violation';
  END IF;

  -- 2) Another open ROI payout request for the same portfolio? Block.
  SELECT EXISTS (
    SELECT 1 FROM public.pending_wallet_operations
     WHERE source_id = NEW.source_id
       AND source_table = 'investor_portfolios'
       AND category = 'roi_payout'
       AND status IN ('pending', 'pending_coo_approval', 'coo_approved', 'awaiting_verification')
       AND (TG_OP <> 'INSERT' OR id IS DISTINCT FROM NEW.id)
  ) INTO v_open_pending_exists;

  IF v_open_pending_exists THEN
    RAISE EXCEPTION 'Duplicate ROI payout blocked: portfolio % already has an ROI payout awaiting approval for the % cycle.', NEW.source_id, v_cycle_anchor
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_roi_cycle_once ON public.pending_wallet_operations;
CREATE TRIGGER trg_enforce_roi_cycle_once
  BEFORE INSERT ON public.pending_wallet_operations
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_roi_cycle_once();