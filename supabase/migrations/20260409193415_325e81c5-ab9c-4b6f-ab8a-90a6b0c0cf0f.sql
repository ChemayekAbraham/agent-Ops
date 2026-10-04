
-- ============================================================
-- LAYER 1: Enable Strict Mode
-- ============================================================
UPDATE treasury_controls SET enabled = TRUE WHERE control_key = 'strict_mode';

-- ============================================================
-- LAYER 2: Revoke Direct Write Access
-- ============================================================
REVOKE INSERT, UPDATE, DELETE ON public.general_ledger FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.general_ledger FROM authenticated;

-- ============================================================
-- LAYER 3: Replace Permissive RLS with Deny-All Writes
-- ============================================================
DROP POLICY IF EXISTS "System can insert ledger entries" ON public.general_ledger;
DROP POLICY IF EXISTS "Deny direct ledger inserts" ON public.general_ledger;
DROP POLICY IF EXISTS "no_direct_inserts" ON public.general_ledger;
DROP POLICY IF EXISTS "no_updates" ON public.general_ledger;
DROP POLICY IF EXISTS "no_deletes" ON public.general_ledger;

CREATE POLICY "no_direct_inserts" ON public.general_ledger
  FOR INSERT TO authenticated WITH CHECK (false);

CREATE POLICY "no_updates" ON public.general_ledger
  FOR UPDATE TO authenticated USING (false);

CREATE POLICY "no_deletes" ON public.general_ledger
  FOR DELETE TO authenticated USING (false);

-- ============================================================
-- LAYER 4: Session Guard Trigger
-- ============================================================
CREATE OR REPLACE FUNCTION public.guard_ledger_write()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('ledger.authorized', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Unauthorized ledger write — must use create_ledger_transaction RPC';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_guard_ledger_write ON public.general_ledger;
CREATE TRIGGER trg_guard_ledger_write
  BEFORE INSERT ON public.general_ledger
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_ledger_write();

-- ============================================================
-- UPDATE RPC: Add authorization flag before inserts
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_ledger_transaction(entries JSONB, idempotency_key TEXT DEFAULT NULL)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  entry JSONB;
  group_id UUID;
  total_in NUMERIC := 0;
  total_out NUMERIC := 0;
  entry_direction TEXT;
  entry_amount NUMERIC;
  entry_scope TEXT;
  wallet_user TEXT;
  wallet_balance NUMERIC;
  locked_categories TEXT[] := ARRAY[
    'rent_principal_collected',
    'service_fee_revenue', 
    'roi_payout',
    'wallet_topup',
    'wallet_withdrawal',
    'deposit_refund',
    'commission_payout'
  ];
  strict_mode BOOLEAN := false;
  entry_category TEXT;
BEGIN
  -- Advisory lock for idempotency
  IF idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(idempotency_key));
    
    SELECT transaction_group_id INTO group_id
    FROM public.general_ledger
    WHERE reference_id = idempotency_key
    ORDER BY created_at ASC
    LIMIT 1;
    
    IF group_id IS NOT NULL THEN
      RETURN group_id;
    END IF;
  END IF;

  group_id := gen_random_uuid();

  -- Validate entries
  FOR entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    entry_direction := LOWER(COALESCE(entry->>'direction', ''));
    entry_amount := COALESCE((entry->>'amount')::NUMERIC, 0);
    entry_scope := COALESCE(entry->>'ledger_scope', 'platform');
    entry_category := COALESCE(entry->>'category', '');

    IF entry_direction IN ('credit', 'in') THEN
      entry_direction := 'cash_in';
    ELSIF entry_direction IN ('debit', 'out') THEN
      entry_direction := 'cash_out';
    END IF;

    IF entry_amount <= 0 THEN
      RAISE EXCEPTION 'All entry amounts must be positive. Got: %', entry_amount;
    END IF;

    IF strict_mode AND entry_category != '' AND NOT (entry_category = ANY(locked_categories)) THEN
      RAISE EXCEPTION 'Category "%" is not in the approved list', entry_category;
    END IF;

    IF entry_direction = 'cash_in' THEN
      total_in := total_in + entry_amount;
    ELSIF entry_direction = 'cash_out' THEN
      total_out := total_out + entry_amount;
    ELSE
      RAISE EXCEPTION 'Invalid direction: %. Must be cash_in, cash_out, credit, debit, in, or out.', entry_direction;
    END IF;

    IF entry_scope = 'wallet' AND entry_direction = 'cash_out' THEN
      wallet_user := entry->>'user_id';
      IF wallet_user IS NOT NULL THEN
        SELECT COALESCE(SUM(cash_in) - SUM(cash_out), 0) INTO wallet_balance
        FROM public.general_ledger
        WHERE user_id = wallet_user::UUID AND ledger_scope = 'wallet';

        IF wallet_balance < entry_amount THEN
          RAISE EXCEPTION 'Insufficient wallet balance. Available: %, Requested: %', wallet_balance, entry_amount;
        END IF;
      END IF;
    END IF;
  END LOOP;

  IF total_in != total_out THEN
    RAISE EXCEPTION 'Unbalanced transaction: total_in (%) != total_out (%)', total_in, total_out;
  END IF;

  -- LAYER 4: Set authorization flag before inserting
  PERFORM set_config('ledger.authorized', 'true', true);

  FOR entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    entry_direction := LOWER(COALESCE(entry->>'direction', ''));
    IF entry_direction IN ('credit', 'in') THEN
      entry_direction := 'cash_in';
    ELSIF entry_direction IN ('debit', 'out') THEN
      entry_direction := 'cash_out';
    END IF;

    INSERT INTO public.general_ledger (
      user_id, direction, cash_in, cash_out, category, description,
      source_table, source_id, reference_id, ledger_scope, transaction_group_id, created_at
    ) VALUES (
      (entry->>'user_id')::UUID,
      entry_direction,
      CASE WHEN entry_direction = 'cash_in' THEN (entry->>'amount')::NUMERIC ELSE 0 END,
      CASE WHEN entry_direction = 'cash_out' THEN (entry->>'amount')::NUMERIC ELSE 0 END,
      COALESCE(entry->>'category', 'uncategorized'),
      COALESCE(entry->>'description', ''),
      COALESCE(entry->>'source_table', ''),
      COALESCE(entry->>'source_id', ''),
      COALESCE(idempotency_key, NULLIF(entry->>'reference_id', '')),
      COALESCE(entry->>'ledger_scope', 'platform'),
      group_id,
      NOW()
    );
  END LOOP;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    auth.uid()::TEXT,
    'ledger_transaction',
    'general_ledger',
    group_id::TEXT,
    jsonb_build_object('entry_count', jsonb_array_length(entries), 'total', total_in, 'idempotency_key', idempotency_key)
  );

  RETURN group_id;
END;
$$;

-- ============================================================
-- UPDATE TRIGGER: log_platform_transaction_to_ledger
-- ============================================================
CREATE OR REPLACE FUNCTION public.log_platform_transaction_to_ledger()
RETURNS TRIGGER AS $$
BEGIN
  -- Set authorization flag for Layer 4 guard
  PERFORM set_config('ledger.authorized', 'true', true);

  INSERT INTO public.general_ledger (
    transaction_date, amount, direction, category, description,
    user_id, source_table, source_id
  ) VALUES (
    NEW.created_at,
    NEW.amount,
    CASE WHEN NEW.direction = 'cash_in' THEN 'cash_in' ELSE 'cash_out' END,
    NEW.transaction_type,
    NEW.description,
    NEW.user_id,
    'platform_transactions',
    NEW.id
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================
-- UPDATE TRIGGER: log_agent_earning_to_ledger
-- ============================================================
CREATE OR REPLACE FUNCTION public.log_agent_earning_to_ledger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.earning_type = 'referral_bonus' THEN
    RETURN NEW;
  END IF;

  -- Set authorization flag for Layer 4 guard
  PERFORM set_config('ledger.authorized', 'true', true);

  INSERT INTO public.general_ledger (
    transaction_date, amount, direction, category, description,
    user_id, source_table, source_id, linked_party
  ) VALUES (
    NEW.created_at,
    NEW.amount,
    'cash_in',
    'agent_commission',
    COALESCE(NEW.description, 'Agent earning: ' || NEW.earning_type),
    NEW.agent_id,
    'agent_earnings',
    NEW.id,
    'agent'
  );
  RETURN NEW;
END;
$$;

-- ============================================================
-- UPDATE TRIGGER: log_deposit_to_ledger
-- ============================================================
CREATE OR REPLACE FUNCTION public.log_deposit_to_ledger()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'approved' AND (OLD.status IS NULL OR OLD.status != 'approved') THEN
    -- Set authorization flag for Layer 4 guard
    PERFORM set_config('ledger.authorized', 'true', true);

    INSERT INTO public.general_ledger (
      transaction_date, amount, direction, category, description,
      user_id, reference_id, source_table, source_id
    ) VALUES (
      COALESCE(NEW.approved_at, now()),
      NEW.amount,
      'cash_in',
      'deposit',
      'Wallet deposit via ' || COALESCE(NEW.provider, 'mobile money'),
      NEW.user_id,
      NEW.transaction_id,
      'deposit_requests',
      NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================
-- UPDATE TRIGGER: credit_signup_referral_bonus
-- ============================================================
CREATE OR REPLACE FUNCTION public.credit_signup_referral_bonus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_txn_group TEXT;
  v_wallet_id UUID;
BEGIN
  IF NEW.credited IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  IF NEW.bonus_amount IS NULL OR NEW.bonus_amount <= 0 THEN
    RETURN NEW;
  END IF;

  v_txn_group := 'referral-bonus-' || NEW.id::TEXT;

  IF EXISTS (
    SELECT 1 FROM public.general_ledger
    WHERE transaction_group_id = v_txn_group
    LIMIT 1
  ) THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_wallet_id
  FROM public.wallets
  WHERE user_id = NEW.referrer_id;

  IF v_wallet_id IS NULL THEN
    INSERT INTO public.wallets (user_id, balance)
    VALUES (NEW.referrer_id, 0)
    RETURNING id INTO v_wallet_id;
  END IF;

  -- Set authorization flag for Layer 4 guard
  PERFORM set_config('ledger.authorized', 'true', true);

  INSERT INTO public.general_ledger (
    direction, amount, category, description, scope,
    source_table, source_id, transaction_group_id
  ) VALUES (
    'cash_out', NEW.bonus_amount, 'marketing_expense',
    'Referral bonus for referring user ' || NEW.referred_user_id::TEXT,
    'platform', 'referrals', NEW.id::TEXT, v_txn_group
  );

  INSERT INTO public.general_ledger (
    direction, amount, category, description, scope, wallet_id,
    source_table, source_id, transaction_group_id
  ) VALUES (
    'cash_in', NEW.bonus_amount, 'referral_bonus',
    'Referral bonus for referring user ' || NEW.referred_user_id::TEXT,
    'wallet', v_wallet_id, 'referrals', NEW.id::TEXT, v_txn_group
  );

  RETURN NEW;
END;
$$;

-- ============================================================
-- UPDATE TRIGGER: sync_collection_to_ledger
-- ============================================================
CREATE OR REPLACE FUNCTION public.sync_collection_to_ledger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_charge RECORD;
  v_rr RECORD;
  v_total numeric;
  v_rent_share numeric;
  v_group_id uuid := gen_random_uuid();
BEGIN
  IF NEW.status NOT IN ('success', 'partial', 'agent_covered_72h', 'partial_agent_covered_72h', 'agent_direct_no_smartphone', 'agent_retry_success_no_smartphone') THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.general_ledger
    WHERE source_table = 'subscription_charge_logs'
      AND source_id = NEW.id::text
      AND category = 'rent_principal_collected'
      AND ledger_scope = 'bridge'
  ) THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_charge FROM public.subscription_charges WHERE id = NEW.subscription_id;
  IF v_charge IS NULL OR v_charge.rent_request_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT rent_amount, access_fee, request_fee, total_repayment
  INTO v_rr FROM public.rent_requests WHERE id = v_charge.rent_request_id;

  IF v_rr IS NULL OR v_rr.total_repayment IS NULL OR v_rr.total_repayment <= 0 THEN
    RETURN NEW;
  END IF;

  v_total := COALESCE(NEW.amount_deducted, 0);
  IF v_total <= 0 THEN
    RETURN NEW;
  END IF;

  v_rent_share := ROUND(v_total * (COALESCE(v_rr.rent_amount, 0) / v_rr.total_repayment));

  IF v_rent_share > 0 THEN
    -- Set authorization flag for Layer 4 guard
    PERFORM set_config('ledger.authorized', 'true', true);

    INSERT INTO public.general_ledger (
      user_id, amount, direction, category, source_table, source_id,
      description, linked_party, transaction_date, ledger_scope, transaction_group_id
    ) VALUES (
      NEW.tenant_id, v_rent_share, 'cash_out', 'rent_principal_collected',
      'subscription_charge_logs', NEW.id::text,
      'Receivable reduction from daily collection',
      'tenant', now(), 'bridge', v_group_id
    );
  END IF;

  RETURN NEW;
END;
$function$;
