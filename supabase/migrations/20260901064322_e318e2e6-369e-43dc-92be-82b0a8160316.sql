CREATE OR REPLACE FUNCTION public.guard_investor_portfolio_self_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  -- Privileged/service paths are unrestricted.
  IF v_uid IS NULL
     OR v_uid <> COALESCE(NEW.investor_id, OLD.investor_id)
     OR public.is_ops_role(v_uid)
     OR public.has_role(v_uid, 'manager')
     OR public.has_role(v_uid, 'cfo')
     OR public.has_role(v_uid, 'ceo')
     OR public.has_role(v_uid, 'coo')
     OR public.has_role(v_uid, 'super_admin')
  THEN
    RETURN NEW;
  END IF;

  -- Self-update: freeze every column except account_name (+ updated_at).
  NEW := OLD;
  NEW.account_name := COALESCE(
    (to_jsonb(pg_temp_new_placeholder()) ->> 'x'), NEW.account_name);
  RETURN NEW;
END;
$$;

-- The placeholder above is not needed; define the real body without it.
CREATE OR REPLACE FUNCTION public.guard_investor_portfolio_self_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_new_name text;
BEGIN
  IF v_uid IS NULL
     OR v_uid <> COALESCE(NEW.investor_id, OLD.investor_id)
     OR public.is_ops_role(v_uid)
     OR public.has_role(v_uid, 'manager')
     OR public.has_role(v_uid, 'cfo')
     OR public.has_role(v_uid, 'ceo')
     OR public.has_role(v_uid, 'coo')
     OR public.has_role(v_uid, 'super_admin')
  THEN
    RETURN NEW;
  END IF;

  v_new_name := NEW.account_name;
  NEW := OLD;
  NEW.account_name := v_new_name;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_investor_portfolio_self_update ON public.investor_portfolios;
CREATE TRIGGER trg_guard_investor_portfolio_self_update
BEFORE UPDATE ON public.investor_portfolios
FOR EACH ROW EXECUTE FUNCTION public.guard_investor_portfolio_self_update();