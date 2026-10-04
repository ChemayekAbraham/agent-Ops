DO $$
DECLARE
  _user_id          uuid := 'ae194750-4827-47e8-839e-5e772565138b';
  _amount           numeric := 20649484;
  _wallet_id        uuid;
  _txn_id           uuid;
  _idem_key         text   := 'cfo-reconcile-zero-phantom-ATUHAIRE-CAROLYNE-2026-04-29';
  _reason           text   := 'CFO_zero_phantom_2026-04-29';
  _before_cached    numeric;
  _before_strict    numeric;
  _after_cached     numeric;
  _after_strict     numeric;
  _entries          jsonb;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.audit_logs
    WHERE action_type = 'wallet_reconciliation'
      AND record_id   = _user_id::text
      AND metadata->>'reason' = _reason
  ) THEN
    RAISE NOTICE 'Reconciliation already applied for %, skipping', _user_id;
    RETURN;
  END IF;

  SELECT id, COALESCE(withdrawable_balance, 0)
    INTO _wallet_id, _before_cached
  FROM public.wallets
  WHERE user_id = _user_id;

  IF _wallet_id IS NULL THEN
    RAISE EXCEPTION 'Wallet not found for user %', _user_id;
  END IF;

  _before_strict := public.get_user_available_balance(_user_id);

  _entries := jsonb_build_array(
    jsonb_build_object(
      'user_id',        _user_id,
      'ledger_scope',   'wallet',
      'direction',      'cash_out',
      'category',       'system_balance_correction',
      'amount',         _amount,
      'currency',       'UGX',
      'classification', 'admin_correction',
      'source_table',   'cfo_direct_credit',
      'description',    'CFO reconciliation — zero phantom withdrawable for ATUHAIRE CAROLYNE per directive 2026-04-29'
    ),
    jsonb_build_object(
      'user_id',        NULL,
      'ledger_scope',   'platform',
      'direction',      'cash_in',
      'category',       'system_balance_correction',
      'amount',         _amount,
      'currency',       'UGX',
      'classification', 'admin_correction',
      'source_table',   'cfo_direct_credit',
      'description',    'CFO reconciliation offset — phantom withdrawable returned to platform (ATUHAIRE CAROLYNE)'
    )
  );

  -- skip_balance_check=true: documented escape hatch for admin_correction posts.
  _txn_id := public.create_ledger_transaction(_entries, _idem_key, true);

  SELECT COALESCE(withdrawable_balance, 0) INTO _after_cached
  FROM public.wallets WHERE user_id = _user_id;

  _after_strict := public.get_user_available_balance(_user_id);

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    _user_id,
    'wallet_reconciliation',
    'wallets',
    _user_id::text,
    jsonb_build_object(
      'reason',           _reason,
      'wallet_id',        _wallet_id,
      'amount',           _amount,
      'currency',         'UGX',
      'transaction_id',   _txn_id,
      'before_cached',    _before_cached,
      'before_strict',    _before_strict,
      'after_cached',     _after_cached,
      'after_strict',     _after_strict,
      'directive',        '2026-04-29 CFO directive: zero phantom withdrawable for ATUHAIRE CAROLYNE'
    )
  );

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES (
    'funds_withdrawn',
    _user_id,
    'wallet_reconciliation',
    _wallet_id,
    jsonb_build_object(
      'sub_type',         'wallet.reconciled',
      'reason',           _reason,
      'amount',           _amount,
      'currency',         'UGX',
      'transaction_id',   _txn_id,
      'before_cached',    _before_cached,
      'before_strict',    _before_strict,
      'after_cached',     _after_cached,
      'after_strict',     _after_strict
    )
  );

  RAISE NOTICE 'Reconciled user %: cached %→%, strict %→% (txn %)',
    _user_id, _before_cached, _after_cached, _before_strict, _after_strict, _txn_id;
END $$;