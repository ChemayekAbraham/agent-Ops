CREATE OR REPLACE FUNCTION public.enforce_no_negative_wallet_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_available numeric := 0;
  v_float numeric := 0;
  v_current_hold numeric := 0;
  v_effective_bucket text := 'withdrawable';
  v_is_admin_bypass boolean := false;
  v_is_writeoff_bypass boolean := false;
BEGIN
  IF NEW.ledger_scope IS DISTINCT FROM 'wallet' THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.direction NOT IN ('cash_out', 'debit') THEN
    RETURN NEW;
  END IF;

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

  -- System correction entries are the sanctioned ledger repair mechanism.
  IF COALESCE(NEW.category, '') = 'system_balance_correction' THEN
    RETURN NEW;
  END IF;

  v_effective_bucket := COALESCE(
    NULLIF(NEW.wallet_bucket, ''),
    CASE
      WHEN NEW.recipient_type = 'operational_wallet' THEN 'float'
      WHEN NEW.recipient_type = 'user' THEN 'withdrawable'
      ELSE NULL
    END,
    (
      SELECT r.bucket
      FROM public.wallet_route_for_category(NEW.user_id, NEW.category, NEW.direction) r
      LIMIT 1
    ),
    'withdrawable'
  );

  -- Float / operational-wallet debits must be backed by float ledger balance.
  IF v_effective_bucket = 'float'
     OR COALESCE(NEW.recipient_type, '') = 'operational_wallet' THEN
    SELECT COALESCE(float_balance, 0)
      INTO v_float
    FROM public.v_user_wallet_strict
    WHERE user_id = NEW.user_id;

    IF COALESCE(v_float, 0) < NEW.amount THEN
      RAISE EXCEPTION 'NEGATIVE_FLOAT_BLOCKED: user % cannot debit % from float (ledger-backed float balance is %)',
        NEW.user_id, NEW.amount, COALESCE(v_float, 0)
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Normal user-money debits must be backed by the strict ledger balance.
  -- If the debit is finalizing an existing withdrawal request, that request is
  -- already counted as a pending hold, so add back ONLY that same hold for the
  -- posting-time check. Other pending withdrawals remain reserved.
  IF NEW.source_table = 'withdrawal_requests' AND NEW.source_id IS NOT NULL THEN
    SELECT COALESCE(wr.amount, 0)
      INTO v_current_hold
    FROM public.withdrawal_requests wr
    WHERE wr.id = NEW.source_id
      AND wr.status IN ('pending', 'requested', 'manager_approved', 'processing', 'approved')
      AND (wr.reason IS NULL OR wr.reason NOT LIKE 'Landlord float payout%')
      AND (
        CASE
          WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id
          ELSE wr.user_id
        END
      ) = NEW.user_id
      AND NOT EXISTS (
        SELECT 1
        FROM public.general_ledger g
        WHERE g.source_table = 'withdrawal_requests'
          AND g.source_id = wr.id
          AND g.ledger_scope = 'wallet'
          AND g.direction IN ('cash_out', 'debit')
      )
    LIMIT 1;
  END IF;

  v_available := COALESCE(public.get_user_available_balance(NEW.user_id), 0) + COALESCE(v_current_hold, 0);

  IF v_available < NEW.amount THEN
    RAISE EXCEPTION 'LEDGER_BACKING_REQUIRED: user % cannot debit % from withdrawable funds (ledger-backed available is %)',
      NEW.user_id, NEW.amount, v_available
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;