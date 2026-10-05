-- The write paths honour claims too, and cancelling a portfolio frees its houses.
--
-- Two gaps closed, both found by the first live test of the allocator.
--
-- 1. THE DOUBLE-FUNDING RISK
--
-- Three WRITE paths decided whether a funder may commit money to a house, and
-- none of them knew a company-managed portfolio could already have claimed it:
--
--   partner_support_houses (both overloads)   partner self-support
--   agent_create_promissory_note_for_houses   promissory-note selection
--   public_house_support_offer                the public offer page
--
-- A partner could therefore self-support a house a company-managed portfolio
-- had already claimed. Two pots of money against one house.
--
-- They now use house_has_live_claim(), the same predicate the read surfaces
-- use, so a house claimed by ANY mechanism is refused by ALL of them. The
-- public offer page gains a branch so a portfolio-claimed house reads as
-- `supported` rather than appearing open.
--
-- Rebuilt from pg_get_functiondef so each signature comes from the database.
-- partner_support_houses has two overloads and both are patched; retyping them
-- by hand is how a third overload gets created by accident.
--
-- 2. CANCELLING A PORTFOLIO DID NOT FREE ITS HOUSES
--
-- The original migration released a claim when a house went to a real tenant,
-- and nothing else. A portfolio that was cancelled, redeemed or rejected kept
-- its houses off the funder queue for ever — capital returned to the funder
-- while the homes it had claimed stayed invisible.
--
-- A cancellation now releases every reserved claim and returns the principal to
-- the portfolio's unallocated balance, so principal_allocated +
-- principal_unallocated still equals investment_amount afterwards.

-- 1. Write paths -------------------------------------------------------------
DO $patch$
DECLARE r record; v_def text; v_new text;
BEGIN
  -- partner_support_houses: the self-support eligibility filter, both overloads.
  FOR r IN SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'partner_support_houses' LOOP
    v_def := pg_get_functiondef(r.oid);
    CONTINUE WHEN v_def LIKE '%house_has_live_claim%';
    v_new := regexp_replace(v_def,
      'AND NOT EXISTS \(\s*SELECT 1 FROM public\.partner_supported_houses s\s*'
      || 'WHERE s\.house_id = h\.id AND s\.status IN \(''pending'',''active''\)\s*\)\s*'
      || 'AND NOT EXISTS \(\s*SELECT 1 FROM public\.promissory_note_house_intents i\s*'
      || 'WHERE i\.house_id = h\.id AND i\.status = ''reserved''\s*\)',
      'AND NOT public.house_has_live_claim(h.id)', 'g');
    IF v_new = v_def THEN
      RAISE WARNING 'partner_support_houses filter not matched - check by hand';
    ELSE
      EXECUTE v_new;
    END IF;
  END LOOP;

  -- agent_create_promissory_note_for_houses: intent-only check.
  SELECT p.oid INTO r FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'agent_create_promissory_note_for_houses';
  v_def := pg_get_functiondef(r.oid);
  IF v_def NOT LIKE '%house_has_live_claim%' THEN
    v_new := regexp_replace(v_def,
      'AND NOT EXISTS \(\s*SELECT 1 FROM public\.promissory_note_house_intents i\s*'
      || 'WHERE i\.house_id = h\.id AND i\.status = ''reserved''\s*\)',
      'AND NOT public.house_has_live_claim(h.id)', 'g');
    IF v_new = v_def THEN
      RAISE WARNING 'agent_create_promissory_note_for_houses filter not matched';
    ELSE
      EXECUTE v_new;
    END IF;
  END IF;

  -- public_house_support_offer: availability label.
  SELECT p.oid INTO r FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'public_house_support_offer';
  v_def := pg_get_functiondef(r.oid);
  IF v_def NOT LIKE '%portfolio_allocations%' THEN
    v_new := replace(v_def,
      'ps.status IN (''pending'',''active'')) THEN ''supported''',
      'ps.status IN (''pending'',''active'')) THEN ''supported''
      WHEN EXISTS (SELECT 1 FROM public.portfolio_allocations pa
                    WHERE pa.house_id = h.id AND pa.status IN (''reserved'',''fulfilled'')) THEN ''supported''');
    IF v_new = v_def THEN
      RAISE WARNING 'public_house_support_offer label not matched';
    ELSE
      EXECUTE v_new;
    END IF;
  END IF;
END
$patch$;

-- 2. Cancelling a portfolio frees its houses ---------------------------------
CREATE OR REPLACE FUNCTION public.release_portfolio_claims_on_close()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_released integer := 0; v_amount numeric := 0;
BEGIN
  WITH done AS (
    UPDATE public.portfolio_allocations
       SET status = 'released', released_at = now(),
           release_reason = 'portfolio_' || NEW.status
     WHERE portfolio_id = NEW.id AND status = 'reserved'
    RETURNING claimed_amount
  )
  SELECT COUNT(*), COALESCE(SUM(claimed_amount), 0) INTO v_released, v_amount FROM done;

  IF v_released > 0 THEN
    -- The principal comes back as unallocated so
    -- principal_allocated + principal_unallocated still equals investment_amount.
    UPDATE public.investor_portfolios
       SET houses_claimed_count  = GREATEST(0, houses_claimed_count - v_released),
           principal_allocated   = GREATEST(0, principal_allocated - v_amount),
           principal_unallocated = principal_unallocated + v_amount
     WHERE id = NEW.id;
  END IF;

  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_zzz_release_portfolio_claims_on_close ON public.investor_portfolios;
CREATE TRIGGER trg_zzz_release_portfolio_claims_on_close
  AFTER UPDATE ON public.investor_portfolios
  FOR EACH ROW
  WHEN (NEW.status IN ('cancelled', 'redeemed', 'rejected')
        AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.release_portfolio_claims_on_close();

-- Verified live by cancelling the first test portfolio, WIP2610053262:
--   status cancelled, 4 claims released, principal_unallocated 700,000
--   operational float 35,970 -> 735,970
--   funder queue 5,832,798,954 -> 5,833,498,954, house count back to 6,452
