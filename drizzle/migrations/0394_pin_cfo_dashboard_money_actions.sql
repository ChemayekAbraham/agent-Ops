-- Pin 15 CFO-dashboard money actions to the Chief Finance Officer office and the two named
-- super admins, via can_act_pinned_finance_action. Holding cfo, ceo, coo, manager, agent_ops,
-- operations, financial_ops, tenant_ops or partner_ops no longer lets a person act on these.
-- A caller with no login (service role / system) passes the new check and meets the function's
-- existing checks as before; anonymous EXECUTE is revoked so only the service role can be that caller.

DO $mig$
DECLARE
  r       record;
  v_src   text;
  v_def   text;
  v_pre   text;
  v_new   text;
  v_count integer;
  c_guard constant text :=
$g$  IF auth.uid() IS NOT NULL AND NOT public.can_act_pinned_finance_action(auth.uid()) THEN
    RAISE EXCEPTION 'Only the Chief Finance Officer or a designated super admin can do this.'
      USING ERRCODE = '42501';
  END IF;

$g$;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('apply_advance_topup', 'p_advance_id uuid, p_amount numeric, p_extend_days integer, p_request_id uuid, p_reason text, p_override_eligibility boolean', '465030071f8e9318bdea2222ba41ce2c'),
      ('apply_layer_a_writedown', 'p_user_id uuid, p_dry_run boolean', '99767461a8b7d6318f8df07318e1de64'),
      ('approve_wallet_transfer_schedule', 'p_schedule_id uuid, p_approve boolean, p_reason text', 'cd4ece4a9c4656abce94d408d42bd428'),
      ('cancel_agent_advance', 'p_advance_id uuid, p_recoup boolean, p_reason text', '139bded34a6b9a89cc88c06bf4044f1a'),
      ('disburse_agent_advance_request', 'p_request_id uuid, p_principal numeric, p_cycle_days integer, p_monthly_rate numeric, p_repayment_frequency text, p_notes text, p_skip_reason text, p_recovery_source text, p_roi_recovery_percent numeric', 'c18517cafc46f46d0265eea034488cc6'),
      ('finops_manual_float_credit', 'p_user_id uuid, p_tid text, p_amount numeric, p_deposited_at timestamp with time zone, p_depositor_name text, p_notes text', '3a8e7142886c9fa28ff790324e62d68d'),
      ('force_approve_rejected_rent_request', 'p_request_id uuid, p_reason text, p_payout_ref text', '11dea693137a94cc1eb26d3e64ab8cd0'),
      ('lock_portfolio_principal', 'p_portfolio_id uuid, p_locked_amount numeric, p_reason text', '8a2779df5f3f85eafc17e1ad7e4e2dc5'),
      ('reconcile_negative_wallets', 'p_dry_run boolean, p_max_users integer', '387af9114b1bc09b76bcd95f89777f7e'),
      ('replay_withdrawal_settlement', 'p_withdrawal_id uuid, p_dry_run boolean, p_reason text, p_approve_customer_wallet_debit boolean', 'ad4ce5c13ee626a0c48d0e023c7f3387'),
      ('reseed_wallets_to_cached_balance', 'p_dry_run boolean, p_max_users integer', 'b27c687887dac716f760ed5580c4425d'),
      ('reverse_agent_advance', 'p_advance_id uuid, p_reason text, p_clawback_amount numeric, p_clawback_group_id uuid', '4f49a1e41311da00481c6058fc0d63c5'),
      ('schedule_roi_payout', 'p_portfolio_id uuid, p_new_date date, p_reason text', '959a0b5ea2adb29cbba2c90361b205f0'),
      ('unlock_portfolio', 'p_portfolio_id uuid, p_reason text', '392ad81ad74cf65193435658b8c3438a'),
      ('update_agent_advance_terms', 'p_advance_id uuid, p_monthly_rate numeric, p_cycle_days integer, p_repayment_frequency text, p_reason text', '0195ac7b86d5b94ac503c8bb0bda0099')
    ) AS t(fn, args, expected_md5)
  LOOP
    SELECT count(*) INTO v_count
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.fn
       AND pg_get_function_identity_arguments(p.oid) = r.args;
    IF v_count <> 1 THEN
      RAISE EXCEPTION '%(%) not found exactly once - stopping', r.fn, r.args;
    END IF;

    SELECT p.prosrc, pg_get_functiondef(p.oid) INTO v_src, v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.fn
       AND pg_get_function_identity_arguments(p.oid) = r.args;

    IF md5(v_src) <> r.expected_md5 THEN
      RAISE EXCEPTION '% has changed since it was reviewed (current md5 %) - stopping', r.fn, md5(v_src);
    END IF;

    v_pre := (regexp_match(v_src, '^(.*?\n[ \t]*BEGIN[ \t]*\n)', 'is'))[1];
    IF v_pre IS NULL THEN
      RAISE EXCEPTION '% has no main BEGIN line - stopping', r.fn;
    END IF;

    v_new := v_pre || c_guard || substr(v_src, length(v_pre) + 1);

    IF (length(v_def) - length(replace(v_def, v_src, ''))) / length(v_src) <> 1 THEN
      RAISE EXCEPTION '% body not found exactly once in its definition - stopping', r.fn;
    END IF;

    EXECUTE replace(v_def, v_src, v_new);

    SELECT p.prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.fn
       AND pg_get_function_identity_arguments(p.oid) = r.args;
    IF md5(v_src) <> md5(v_new) THEN
      RAISE EXCEPTION '% did not take the new guard - stopping', r.fn;
    END IF;

    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC', r.fn, r.args);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM anon', r.fn, r.args);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO authenticated, service_role', r.fn, r.args);
  END LOOP;
END
$mig$;

-- Close the anonymous path into reconcile_wallet_from_ledger. Its body is unchanged;
-- every caller found in the code uses the service role, which keeps access.
REVOKE ALL ON FUNCTION public.reconcile_wallet_from_ledger(p_user_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_wallet_from_ledger(p_user_id uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.reconcile_wallet_from_ledger(p_user_id uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.reconcile_wallet_from_ledger(p_user_id uuid, p_reason text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_wallet_from_ledger(p_user_id uuid, p_reason text) FROM anon;
GRANT EXECUTE ON FUNCTION public.reconcile_wallet_from_ledger(p_user_id uuid, p_reason text) TO authenticated, service_role;