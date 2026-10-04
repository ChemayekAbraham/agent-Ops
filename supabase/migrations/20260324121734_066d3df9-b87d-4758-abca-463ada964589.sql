
-- ============================================
-- TRIGGER: Auto-populate Default & Recovery Ledger
-- When a rent request status changes to 'defaulted'
-- ============================================
CREATE OR REPLACE FUNCTION public.trg_auto_log_default()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'defaulted' AND (OLD.status IS NULL OR OLD.status != 'defaulted') THEN
    INSERT INTO public.default_recovery_ledger (
      tenant_id, agent_id, rent_request_id, default_amount, status, default_date
    ) VALUES (
      NEW.user_id,
      COALESCE(NEW.assigned_agent_id, NEW.agent_id),
      NEW.id,
      COALESCE(NEW.rent_amount, 0),
      'defaulted',
      now()
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rent_request_default ON public.rent_requests;
CREATE TRIGGER trg_rent_request_default
  AFTER UPDATE ON public.rent_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_auto_log_default();

-- ============================================
-- TRIGGER: Auto-populate Fee Revenue Ledger
-- When a rent request is funded, log the fees as deferred revenue
-- ============================================
CREATE OR REPLACE FUNCTION public.trg_auto_log_fee_revenue()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'funded' AND (OLD.status IS NULL OR OLD.status != 'funded') THEN
    -- Log access fee
    IF COALESCE(NEW.access_fee, 0) > 0 THEN
      INSERT INTO public.fee_revenue_ledger (rent_request_id, tenant_id, fee_type, total_amount, deferred_amount, status)
      VALUES (NEW.id, NEW.user_id, 'access_fee', NEW.access_fee, NEW.access_fee, 'deferred');
    END IF;

    -- Log platform fee
    IF COALESCE(NEW.platform_fee, 0) > 0 THEN
      INSERT INTO public.fee_revenue_ledger (rent_request_id, tenant_id, fee_type, total_amount, deferred_amount, status)
      VALUES (NEW.id, NEW.user_id, 'platform_fee', NEW.platform_fee, NEW.platform_fee, 'deferred');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rent_request_fee_revenue ON public.rent_requests;
CREATE TRIGGER trg_rent_request_fee_revenue
  AFTER UPDATE ON public.rent_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_auto_log_fee_revenue();

-- ============================================
-- TRIGGER: Auto-populate Commission Accrual Ledger
-- When an agent earning is recorded
-- ============================================
CREATE OR REPLACE FUNCTION public.trg_auto_log_commission_accrual()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.commission_accrual_ledger (
    agent_id, source_type, source_id, amount, status, description
  ) VALUES (
    NEW.agent_id,
    NEW.earning_type,
    NEW.rent_request_id,
    NEW.amount,
    'earned',
    NEW.description
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agent_earning_commission ON public.agent_earnings;
CREATE TRIGGER trg_agent_earning_commission
  AFTER INSERT ON public.agent_earnings
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_auto_log_commission_accrual();

-- ============================================
-- TRIGGER: Auto-populate Supporter Capital Ledger
-- When supporter capital transactions flow through general_ledger
-- ============================================
CREATE OR REPLACE FUNCTION public.trg_auto_log_supporter_capital()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.category IN ('supporter_facilitation_capital', 'pool_rent_deployment', 'supporter_platform_rewards') AND NEW.user_id IS NOT NULL THEN
    INSERT INTO public.supporter_capital_ledger (
      supporter_id,
      transaction_type,
      amount,
      reference_id,
      description
    ) VALUES (
      NEW.user_id,
      CASE
        WHEN NEW.category = 'supporter_facilitation_capital' AND NEW.direction = 'cash_in' THEN 'inflow'
        WHEN NEW.category = 'pool_rent_deployment' THEN 'deployment'
        WHEN NEW.category = 'supporter_platform_rewards' THEN 'return'
        ELSE 'withdrawal'
      END,
      NEW.amount,
      NEW.transaction_group_id,
      NEW.description
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_general_ledger_supporter_capital ON public.general_ledger;
CREATE TRIGGER trg_general_ledger_supporter_capital
  AFTER INSERT ON public.general_ledger
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_auto_log_supporter_capital();
