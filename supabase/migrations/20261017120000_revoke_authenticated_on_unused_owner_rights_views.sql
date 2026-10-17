-- 2026-10-17 (doc 247): signed-in users could read 84 owner-rights views holding company-wide data (ledger, wallets,
-- contact directories). 61 of them are used by NOTHING that runs as a signed-in user: no page in src/, no database
-- function that runs as the caller, no cron job, no policy, no row-level-security view depends on them (checked
-- 2026-10-17). Edge functions use the service key and keep access (service_role is untouched).
-- Already applied to production 2026-10-17; this keeps rebuilds consistent. Idempotent.
-- To restore one if something is found to need it:  grant select on public.<view> to authenticated;
-- NOT changed here: the 23 views that frontend pages read (landlords_directory, wallets, v_user_wallet_strict, ...); doc 247.
do $$
declare n text;
begin
  foreach n in array array[
  'cashout_queue_view',
  'cto_cron_run_details',
  'engrep_claim_noise',
  'engrep_commit_survival',
  'engrep_file_survival',
  'engrep_repetition',
  'engrep_work_units',
  'mv_house_location_rollup',
  'mv_identity_double_users',
  'mv_ops_daily_summary',
  'mv_ug_district_alias',
  'mv_ug_subcounty_alias',
  'mv_ug_village_geo',
  'platform_stats',
  'rent_request_formula_drift',
  'supporter_referral_leaderboard',
  'v_accounts_no_verified_phone',
  'v_agent_collection_performance',
  'v_agent_receivable_restatement',
  'v_agent_receivable_restatement_orphans',
  'v_cc_call_queue',
  'v_cc_tenant_calling_population',
  'v_cfo_promissory_bookings',
  'v_funding_commission',
  'v_g7_receivable_direction_defect',
  'v_general_ledger_effective',
  'v_general_ledger_operational',
  'v_house_listing_latest_rejection',
  'v_identity_double_users',
  'v_merchant_float_ledger_variance',
  'v_merchant_float_position',
  'v_merchant_payout_float_trace',
  'v_merchant_payout_funding_mismatch',
  'v_operational_float_tid_duplicates',
  'v_partner_float_notice_queue',
  'v_partner_funded_landlord_float',
  'v_partner_self_fundable_plans',
  'v_partner_self_support_house_float',
  'v_payables_payment_history',
  'v_promissory_agent_commissions',
  'v_pso_conversions',
  'v_pso_note_events',
  'v_pso_officers',
  'v_receivables_collection_history',
  'v_rent_collection_unapplied',
  'v_rent_day_ledger',
  'v_rent_fee_collection_drilldown',
  'v_rent_plan_arrears',
  'v_rent_plan_expired_owing',
  'v_rent_plan_receivable_restatement',
  'v_rent_repaid_reconciliation',
  'v_suspicious_duplicate_accounts',
  'v_tenant_ops_landlord_base',
  'v_tenant_ops_property_base',
  'v_tenant_self_repayments',
  'v_tpsp_projection_base',
  'v_ug_district_alias_all',
  'v_verified_bank_declarations',
  'v_wallet_legs_missing_bucket',
  'v_withdrawal_holds_unbacked',
  'wallet_pivot_drift_view'
  ] loop
    execute format('revoke all on public.%I from authenticated', n);
  end loop;
end $$;
