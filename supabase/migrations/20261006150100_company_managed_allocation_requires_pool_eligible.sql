-- Company-managed house allocation: only for pool-eligible portfolios.
--
-- docs/company-managed-portfolio-house-allocation-spec.md §3 says the pre-cutover
-- portfolios (pool_eligible = false, ~9.6bn) are "excluded permanently" and that
-- the trigger condition `pool_origin = 'company_managed'` is "equivalently
-- pool_eligible = true". That equivalence stops holding once the older portfolios
-- are tagged with their pool category (20261006150000_landlord_pool_legacy_category_run).
-- Without this guard, tagging them would make ~1,354 older portfolios claim
-- nearly every empty house in the funder queue (6,403 houses, 5.8bn of rent).
--
-- Function-only change (no trigger DDL, so no lock on investor_portfolios).

CREATE OR REPLACE FUNCTION public.trg_allocate_company_managed_portfolio()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Older (pre-cutover) portfolios never claim houses; see header.
  IF NOT coalesce(NEW.pool_eligible, false) THEN
    RETURN NULL;
  END IF;

  BEGIN
    PERFORM public.allocate_company_managed_portfolio(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'company-managed allocation failed for portfolio %: %', NEW.id, SQLERRM;
    UPDATE public.investor_portfolios
       SET allocation_note = 'allocation_error: ' || left(SQLERRM,180) WHERE id = NEW.id;
  END;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.allocate_company_managed_portfolio(p_portfolio_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_principal numeric; v_origin text; v_eligible boolean;
  v_claimed numeric := 0; v_count integer := 0; v_note text;
BEGIN
  SELECT COALESCE(investment_amount,0), COALESCE(pool_origin,''), COALESCE(pool_eligible,false)
    INTO v_principal, v_origin, v_eligible
    FROM public.investor_portfolios WHERE id = p_portfolio_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','portfolio_not_found'); END IF;
  IF v_origin <> 'company_managed' THEN RETURN jsonb_build_object('ok',false,'reason','not_company_managed'); END IF;
  IF NOT v_eligible THEN RETURN jsonb_build_object('ok',false,'reason','pre_cutover_portfolio'); END IF;

  IF EXISTS (SELECT 1 FROM public.funder_pending_portfolios f WHERE f.portfolio_id = p_portfolio_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','self_managed_selection_exists');
  END IF;

  IF EXISTS (SELECT 1 FROM public.portfolio_allocations a
              WHERE a.portfolio_id = p_portfolio_id AND a.status IN ('reserved','fulfilled')) THEN
    RETURN jsonb_build_object('ok',true,'reason','already_allocated');
  END IF;

  IF v_principal <= 0 THEN
    UPDATE public.investor_portfolios
       SET principal_allocated=0, principal_unallocated=0, houses_claimed_count=0,
           allocation_note='no_principal'
     WHERE id = p_portfolio_id;
    RETURN jsonb_build_object('ok',true,'claimed_count',0,'reason','no_principal');
  END IF;

  WITH candidates AS (
    SELECT h.id, COALESCE(h.monthly_rent,0)::numeric AS rent, h.created_at
      FROM public.house_listings h
     WHERE h.status='available' AND h.tenant_id IS NULL
       AND COALESCE(h.is_hidden,false)=false AND COALESCE(h.monthly_rent,0)>0
       AND NOT public.house_has_live_claim(h.id)
  ),
  pass1 AS (
    SELECT id, rent FROM (
      SELECT id, rent, SUM(rent) OVER (ORDER BY created_at, id ROWS UNBOUNDED PRECEDING) AS running
        FROM candidates) q
     WHERE running <= v_principal
  ),
  remainder AS (
    SELECT v_principal - COALESCE((SELECT SUM(rent) FROM pass1),0) AS left_over
  ),
  pass2 AS (
    SELECT id, rent FROM (
      SELECT c.id, c.rent,
             SUM(c.rent) OVER (ORDER BY c.rent DESC, c.id ROWS UNBOUNDED PRECEDING) AS running
        FROM candidates c
       WHERE NOT EXISTS (SELECT 1 FROM pass1 p WHERE p.id = c.id)
         AND c.rent <= (SELECT left_over FROM remainder)) q
     WHERE running <= (SELECT left_over FROM remainder)
  ),
  picked AS (SELECT id, rent FROM pass1 UNION ALL SELECT id, rent FROM pass2),
  inserted AS (
    INSERT INTO public.portfolio_allocations
      (portfolio_id, target_type, house_id, claimed_amount, claimed_basis, status, pool_origin)
    SELECT p_portfolio_id, 'empty_house', picked.id, picked.rent, 'monthly_rent', 'reserved', v_origin
      FROM picked
    ON CONFLICT DO NOTHING
    RETURNING claimed_amount
  )
  SELECT COUNT(*), COALESCE(SUM(claimed_amount),0) INTO v_count, v_claimed FROM inserted;

  v_note := CASE
    WHEN v_count > 0 THEN NULL
    WHEN NOT EXISTS (SELECT 1 FROM public.house_listings h
                      WHERE h.status='available' AND h.tenant_id IS NULL
                        AND COALESCE(h.is_hidden,false)=false AND COALESCE(h.monthly_rent,0)>0
                        AND NOT public.house_has_live_claim(h.id)) THEN 'queue_empty'
    ELSE 'principal_below_cheapest_house' END;

  UPDATE public.investor_portfolios
     SET houses_claimed_count=v_count, principal_allocated=v_claimed,
         principal_unallocated=v_principal - v_claimed, allocation_note=v_note
   WHERE id = p_portfolio_id;

  RETURN jsonb_build_object('ok',true,'portfolio_id',p_portfolio_id,'claimed_count',v_count,
    'principal',v_principal,'allocated',v_claimed,'unallocated',v_principal - v_claimed,'note',v_note);
END;
$function$;
