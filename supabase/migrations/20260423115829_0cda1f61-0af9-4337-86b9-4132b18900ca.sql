DO $reconcile2$
DECLARE
  r record;
  v_float_in numeric;
  v_float_out numeric;
  v_float_net numeric;
  v_total numeric;
  v_advance numeric;
  v_new_float numeric;
  v_new_withdrawable numeric;
  v_moved_count int := 0;
BEGIN
  PERFORM set_config('wallet.sync_authorized', 'true', true);

  FOR r IN
    SELECT w.user_id, w.withdrawable_balance, w.float_balance, w.advance_balance, w.balance
    FROM public.wallets w
    WHERE EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = w.user_id
        AND ur.role = 'agent'
        AND COALESCE(ur.enabled, true) = true
    )
  LOOP
    v_total   := COALESCE(r.balance, 0);
    v_advance := COALESCE(r.advance_balance, 0);

    -- Float-purpose inflows (company money landing in the agent wallet)
    SELECT COALESCE(SUM(amount), 0) INTO v_float_in
    FROM public.general_ledger
    WHERE user_id = r.user_id
      AND ledger_scope = 'wallet'
      AND direction IN ('cash_in','credit')
      AND category IN (
        'wallet_deposit','deposit','wallet_transfer',
        'cfo_direct_credit','system_balance_correction',
        'roi_wallet_credit','roi_payout',
        'pool_capital_received','partner_funding',
        'supporter_capital','supporter_rent_fund',
        'manager_credit','reconciliation'
      );

    -- Float-purpose outflows (money moved out for partners / clients / payouts)
    SELECT COALESCE(SUM(amount), 0) INTO v_float_out
    FROM public.general_ledger
    WHERE user_id = r.user_id
      AND ledger_scope = 'wallet'
      AND direction IN ('cash_out','debit')
      AND category IN (
        'agent_proxy_investment','coo_proxy_investment',
        'pending_portfolio_topup','proxy_partner_withdrawal',
        'wallet_transfer','rent_payment_for_tenant','rent_obligation',
        'roi_payout','roi_expense','roi_reinvestment',
        'partner_funding','wallet_to_investment'
      );

    v_float_net := GREATEST(0, v_float_in - v_float_out);

    -- Cap float at total - advance, derive withdrawable as the remainder
    IF v_float_net > v_total - v_advance THEN
      v_new_float := GREATEST(0, v_total - v_advance);
      v_new_withdrawable := 0;
    ELSE
      v_new_float := v_float_net;
      v_new_withdrawable := GREATEST(0, v_total - v_advance - v_new_float);
    END IF;

    IF v_new_withdrawable <> COALESCE(r.withdrawable_balance, 0)
       OR v_new_float     <> COALESCE(r.float_balance, 0) THEN
      UPDATE public.wallets
        SET withdrawable_balance = v_new_withdrawable,
            float_balance        = v_new_float,
            balance              = v_new_withdrawable + v_new_float + v_advance,
            updated_at           = now()
        WHERE user_id = r.user_id;
      v_moved_count := v_moved_count + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'Agent wallet reconciliation v2: % wallets updated', v_moved_count;
END;
$reconcile2$;