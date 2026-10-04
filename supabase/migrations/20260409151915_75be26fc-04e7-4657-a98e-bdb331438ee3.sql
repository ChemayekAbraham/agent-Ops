-- Insert strict_mode control (default disabled)
INSERT INTO public.treasury_controls (control_key, enabled)
VALUES ('strict_mode', FALSE)
ON CONFLICT (control_key) DO NOTHING;

-- Create the safety trigger function
CREATE OR REPLACE FUNCTION public.validate_ledger_category()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  is_strict BOOLEAN := FALSE;
  is_bypassed TEXT;
  allowed_categories TEXT[] := ARRAY[
    'access_fee_collected',
    'registration_fee_collected',
    'wallet_deposit',
    'tenant_repayment',
    'agent_repayment',
    'partner_funding',
    'share_capital',
    'rent_disbursement',
    'rent_receivable_created',
    'rent_principal_collected',
    'roi_expense',
    'roi_wallet_credit',
    'roi_reinvestment',
    'agent_commission_earned',
    'agent_commission_withdrawal',
    'agent_commission_used_for_rent',
    'wallet_withdrawal',
    'wallet_transfer',
    'system_balance_correction',
    'orphan_reassignment',
    'orphan_reversal',
    'agent_float_deposit',
    'agent_float_used_for_rent'
  ];
BEGIN
  -- Check if create_ledger_transaction already validated this
  is_bypassed := COALESCE(current_setting('app.bypass_category_check', true), 'false');

  IF is_bypassed = 'true' THEN
    RETURN NEW;
  END IF;

  -- Check if category is in allowlist
  IF NEW.category IS NOT NULL AND NOT (NEW.category = ANY(allowed_categories)) THEN
    -- Check strict_mode
    SELECT enabled INTO is_strict
    FROM public.treasury_controls
    WHERE control_key = 'strict_mode';

    IF is_strict THEN
      RAISE EXCEPTION 'BLOCKED: Category "%" is not in the locked allowlist. Direct inserts must use approved categories.', NEW.category;
    ELSE
      RAISE NOTICE 'LEGACY DIRECT INSERT: category "%" is not in locked allowlist. Will be blocked when strict_mode is enabled.', NEW.category;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Create the trigger (BEFORE INSERT so it can block if strict)
DROP TRIGGER IF EXISTS trg_validate_ledger_category ON public.general_ledger;
CREATE TRIGGER trg_validate_ledger_category
  BEFORE INSERT ON public.general_ledger
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_ledger_category();