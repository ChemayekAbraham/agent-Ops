-- Landlord Float Pool — release (checklist step 8c).
--
-- Design: docs/LANDLORD_POOL_FUNDING_DESIGN.md §5.5
-- Needs:  20260929230500
--
-- apply_portfolio_redemption posts NO ledger entries: it lowers
-- investor_portfolios.investment_amount and sets status, and the partner is
-- paid out of treasury separately. So release hooks the portfolio row, as
-- reserve does, and works as a REBALANCE:
--
--   the pool may hold at most   remaining principal − money out with tenants
--   remaining principal         = 0 once status is redeemed / cancelled /
--                                 rejected, else investment_amount
--   anything above that         → released to free treasury:
--       landlord_pool_release_<origin>  cash_out  CR A21/A22
--       landlord_pool_release_target    cash_in   DR A1
--
-- It runs when principal drops or the portfolio closes, and after every
-- tenant return — so principal repaid on an already-closed portfolio goes
-- straight back to treasury instead of sitting in the pool.
--
-- `matured` does NOT release: matured portfolios can be renewed, and the
-- capital is still owed until it is redeemed. Money still out with tenants is
-- never released; it comes back only through returns.
--
-- Known limitation: lock_portfolio_principal carves principal into a split
-- child by lowering the parent's investment_amount. The rebalance then
-- releases that share to treasury (the child is never pool-eligible). The
-- books stay balanced; the pool simply stops tracking that share.

CREATE OR REPLACE FUNCTION public.landlord_pool_rebalance(
  p_portfolio_id uuid,
  p_caller       text DEFAULT 'unknown'
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  p          public.investor_portfolios%ROWTYPE;
  v_remain   numeric;
  v_in       numeric;
  v_out      numeric;
  v_excess   numeric;
  v_take     numeric;
  v_ref      text := gen_random_uuid()::text;
  v_released jsonb := '[]'::jsonb;
  r          record;
BEGIN
  IF public.landlord_pool_cutover() IS NULL THEN RETURN jsonb_build_object('status', 'pool_off'); END IF;

  SELECT * INTO p FROM public.investor_portfolios WHERE id = p_portfolio_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'no_portfolio'); END IF;

  SELECT coalesce(sum(in_pool), 0), coalesce(sum(out_with_tenants), 0)
    INTO v_in, v_out
    FROM public.landlord_pool_entries WHERE portfolio_id = p.id;
  IF v_in <= 0 THEN RETURN jsonb_build_object('status', 'nothing_in_pool'); END IF;

  v_remain := CASE WHEN p.status IN ('redeemed', 'cancelled', 'rejected') THEN 0
                   ELSE greatest(coalesce(p.investment_amount, 0), 0) END;
  v_excess := v_in - greatest(v_remain - v_out, 0);
  IF v_excess <= 0.5 THEN
    RETURN jsonb_build_object('status', 'balanced', 'in_pool', v_in, 'out', v_out, 'remaining', v_remain);
  END IF;

  -- Newest money leaves first, so the oldest keeps funding tenants.
  FOR r IN
    SELECT id, in_pool FROM public.landlord_pool_entries
     WHERE portfolio_id = p.id AND in_pool > 0
     ORDER BY created_at DESC, id DESC
     FOR UPDATE
  LOOP
    EXIT WHEN v_excess <= 0.5;
    v_take := least(v_excess, r.in_pool);
    PERFORM public._landlord_pool_post(r.id, 'release', v_take, v_ref, NULL, NULL, NULL,
      format('Landlord Float Pool release — portfolio %s (%s, status %s)', p.portfolio_code, p_caller, p.status));
    v_excess := v_excess - v_take;
    v_released := v_released || jsonb_build_object('entry_id', r.id, 'amount', v_take);
  END LOOP;

  RETURN jsonb_build_object('status', 'released', 'released', v_released,
                            'remaining', v_remain, 'caller', p_caller);
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_landlord_pool_release_on_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT NEW.pool_eligible THEN RETURN NULL; END IF;
  IF NOT (coalesce(NEW.investment_amount, 0) < coalesce(OLD.investment_amount, 0)
          OR (NEW.status IN ('redeemed', 'cancelled', 'rejected')
              AND OLD.status IS DISTINCT FROM NEW.status)) THEN
    RETURN NULL;
  END IF;
  IF public.landlord_pool_cutover() IS NULL THEN RETURN NULL; END IF;

  BEGIN
    PERFORM public.landlord_pool_rebalance(NEW.id, 'portfolio_change');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.landlord_pool_exceptions (portfolio_id, operation, caller, reason, detail)
    VALUES (NEW.id, 'release', 'portfolio_change', SQLERRM,
            jsonb_build_object('sqlstate', SQLSTATE, 'old_status', OLD.status, 'new_status', NEW.status,
                               'old_amount', OLD.investment_amount, 'new_amount', NEW.investment_amount));
  END;
  RETURN NULL;
END;
$function$;

-- Trigger creation is applied separately in production with a short
-- lock_timeout.
DROP TRIGGER IF EXISTS trg_zz_landlord_pool_release ON public.investor_portfolios;
CREATE TRIGGER trg_zz_landlord_pool_release
  AFTER UPDATE OF investment_amount, status ON public.investor_portfolios
  FOR EACH ROW EXECUTE FUNCTION public.trg_landlord_pool_release_on_change();

-- After a tenant return, rebalance every portfolio that funded the tenant:
-- principal coming back to a closed portfolio goes straight to treasury.
CREATE OR REPLACE FUNCTION public.trg_landlord_pool_return_on_allocation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pid uuid;
BEGIN
  IF public.landlord_pool_cutover() IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.landlord_pool_movements m
                  WHERE m.rent_request_id = NEW.rent_request_id AND m.kind = 'deploy') THEN
    RETURN NULL;
  END IF;

  BEGIN
    IF TG_OP = 'INSERT' AND NEW.reversed_at IS NULL AND coalesce(NEW.principal_component, 0) > 0 THEN
      PERFORM public.landlord_pool_return(NEW.rent_request_id, NEW.principal_component, NEW.id,
                                          NEW.source_id, 'instalment_allocation');
      FOR v_pid IN
        SELECT DISTINCT e.portfolio_id
          FROM public.landlord_pool_movements m
          JOIN public.landlord_pool_entries e ON e.id = m.pool_entry_id
         WHERE m.rent_request_id = NEW.rent_request_id AND m.kind = 'deploy'
      LOOP
        PERFORM public.landlord_pool_rebalance(v_pid, 'after_return');
      END LOOP;
    ELSIF TG_OP = 'UPDATE' AND OLD.reversed_at IS NULL AND NEW.reversed_at IS NOT NULL THEN
      PERFORM public.landlord_pool_return_reverse(NEW.id, 'instalment_allocation_reversed');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.landlord_pool_exceptions (portfolio_id, operation, caller, reason, detail)
    VALUES (NULL, 'return', 'instalment_allocation:' || TG_OP, SQLERRM,
            jsonb_build_object('sqlstate', SQLSTATE, 'instalment_allocation_id', NEW.id,
                               'rent_request_id', NEW.rent_request_id,
                               'principal_component', NEW.principal_component,
                               'source_table', NEW.source_table, 'source_id', NEW.source_id));
  END;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_pool_rebalance(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_landlord_pool_release_on_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_landlord_pool_return_on_allocation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_pool_rebalance(uuid, text) TO service_role;
