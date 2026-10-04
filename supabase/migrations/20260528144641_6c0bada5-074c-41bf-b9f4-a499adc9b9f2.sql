-- Structured Solvency Bypass Reason Codes
-- Adds machine-readable justification for every wallet cash_out leg that
-- bypasses the strict-balance guard via classification='admin_correction'
-- or category='platform_loss_writeoff'.

DO $$ BEGIN
  CREATE TYPE public.solvency_bypass_reason AS ENUM (
    'legacy_offline_paid',
    'write_off',
    'admin_correction_seed',
    'legacy_real_backfill',
    'dispute_resolution',
    'regulatory_adjustment',
    'duplicate_reversal',
    'other_with_note'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.general_ledger
  ADD COLUMN IF NOT EXISTS solvency_bypass_reason public.solvency_bypass_reason;

CREATE INDEX IF NOT EXISTS idx_gl_solvency_bypass_reason
  ON public.general_ledger (solvency_bypass_reason)
  WHERE solvency_bypass_reason IS NOT NULL;

-- Rewrite the guard: keep existing bypass logic, but for the two
-- operator-discretion paths (admin_correction classification OR
-- platform_loss_writeoff category) require a structured reason code,
-- and for `other_with_note` also require a 30-char description.
CREATE OR REPLACE FUNCTION public.enforce_no_negative_wallet_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_available numeric := 0;
  v_float numeric := 0;
  v_is_admin_bypass boolean := false;
  v_is_writeoff_bypass boolean := false;
BEGIN
  IF NEW.ledger_scope IS DISTINCT FROM 'wallet' THEN RETURN NEW; END IF;
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.direction <> 'cash_out' THEN RETURN NEW; END IF;

  v_is_admin_bypass := COALESCE(NEW.classification, '') = 'admin_correction';
  v_is_writeoff_bypass := COALESCE(NEW.category, '') = 'platform_loss_writeoff';

  -- Operator-discretion bypass paths MUST carry a structured reason code.
  IF v_is_admin_bypass OR v_is_writeoff_bypass THEN
    IF NEW.solvency_bypass_reason IS NULL THEN
      RAISE EXCEPTION
        'SOLVENCY_BYPASS_REASON_REQUIRED: cash_out leg classified % / category % must include a solvency_bypass_reason code',
        COALESCE(NEW.classification, '(null)'), COALESCE(NEW.category, '(null)')
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.solvency_bypass_reason = 'other_with_note'
       AND length(COALESCE(NEW.description, '')) < 30 THEN
      RAISE EXCEPTION
        'SOLVENCY_BYPASS_NOTE_REQUIRED: reason code other_with_note requires a description of at least 30 characters'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- System-internal bypass categories (unchanged behavior, no reason required)
  IF COALESCE(NEW.category, '') = 'system_balance_correction' THEN RETURN NEW; END IF;

  -- Routing v2: explicit float-bucket debit gates against float balance
  IF COALESCE(NEW.recipient_type, '') = 'operational_wallet'
     OR COALESCE(NEW.wallet_bucket, '') = 'float' THEN
    SELECT COALESCE(float_balance, 0) INTO v_float
    FROM public.wallets WHERE user_id = NEW.user_id;
    IF v_float < NEW.amount THEN
      RAISE EXCEPTION 'NEGATIVE_FLOAT_BLOCKED: user % cannot debit % from float (float balance is %)',
        NEW.user_id, NEW.amount, v_float
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Legacy float-category bypass list (unchanged)
  IF COALESCE(NEW.category, '') IN (
    'agent_float_deposit','agent_float_assignment','agent_float_topup',
    'agent_float_funding','rent_float_funding','rent_disbursement'
  ) THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.category, '') IN (
    'wallet_deduction_general_adjustment',
    'wallet_deduction_cash_payout_retraction',
    'wallet_withdrawal',
    'agent_float_used_for_rent',
    'rent_payment_for_tenant',
    'angel_pool_investment'
  ) THEN
    RETURN NEW;
  END IF;

  v_available := COALESCE(public.get_user_available_balance(NEW.user_id), 0);

  IF v_available < NEW.amount THEN
    RAISE EXCEPTION 'NEGATIVE_WALLET_BLOCKED: user % cannot debit % (strict available balance is %)',
      NEW.user_id, NEW.amount, v_available
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON COLUMN public.general_ledger.solvency_bypass_reason IS
  'Structured reason code stamped on cash_out wallet legs that bypass the strict-balance guard via classification=admin_correction or category=platform_loss_writeoff. Required by trigger enforce_no_negative_wallet_ledger.';
