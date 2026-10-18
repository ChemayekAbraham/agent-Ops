-- 2026-10-18 (doc 247, step 22): Supabase security advisor pass. Already applied to production 2026-10-18; every block is idempotent.
-- Advisor before: 13 security-definer views (ERROR); 51 mutable search_path, pg_trgm in public, 630 anon-callable and 1,983 signed-in-callable
-- owner-rights functions, leaked-password protection off (WARN); 55 RLS-enabled tables without policies (INFO).
--
-- A. Trigger functions (about 440 owner-rights ones were callable by anon/authenticated): not callable through the API, and Postgres checks EXECUTE
--    only at CREATE TRIGGER time, so closing them changes nothing at run time.
-- B. Pin search_path on every public function that lacked one (public, extensions, pg_temp).
-- C. Move pg_trgm out of public (into extensions); seven functions that call trigram functions get `extensions` on their search_path.
-- D. 55 RLS-on, no-policy tables get an explicit deny-all policy for anon/authenticated and anon loses table privileges (service role / owner functions unaffected).
-- E. anon: revoke EXECUTE on every owner-rights function except policy helpers and the explicit sign-in / public-page flows listed below.
-- F. Function-by-function closures for signed-in users (nothing in the app, edge functions or invoker code calls them), see the list below.
-- G. Caller checks: staff check (trigger/service bypass) on staff-only reports (plpgsql: injected, plain SQL: renamed to <name>__impl + wrapper),
--    subject check (own / network / staff, only for DIRECT calls: public._direct_client_call() reads the call stack) on user-scoped reads,
--    plus checks on credit/matching/sweep/logging functions that had none.
-- H. Seven owner-rights views converted to security_invoker (identical rows for every audience, all columns evaluated). NOT converted: landlords_directory
--    (agents search all landlords), v_merchant_oop_evidence (calls a closed owner-rights function), v_tenant_location_pivot / vw_agent_ops_directory (read a closed
--    relation), wallets / v_user_wallet_strict (agent network needs owner rights). These stay flagged by the advisor on purpose, each gated (steps 5-20).
-- LESSON (again): never close a plain helper function that a view inlines (ug_norm_name, continent_for_country): excluded here.

-- ===== A. trigger functions
do $$
declare rec record;
begin
  for rec in select p.oid::regprocedure::text sig from pg_proc p
              where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.prorettype = 'trigger'::regtype
                and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', rec.sig);
    execute format('grant execute on function %s to service_role', rec.sig);
  end loop;
end $$;

-- ===== B. pinned search_path
do $$
declare rec record;
begin
  for rec in select p.oid::regprocedure::text sig from pg_proc p
              where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
                and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
                and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('alter function %s set search_path = public, extensions, pg_temp', rec.sig);
  end loop;
end $$;

-- ===== C. pg_trgm out of public
do $$
declare rec record; sp text;
begin
  if exists (select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_trgm' and n.nspname = 'public') then
    alter extension pg_trgm set schema extensions;
  end if;
  for rec in select p.oid::regprocedure::text sig, (select substr(c, 13) from unnest(p.proconfig) c where c like 'search_path=%') cur
               from pg_proc p where p.pronamespace = 'public'::regnamespace
                and p.proname in ('find_similar_landlords','find_similar_lc1','payout_name_match_report','promissory_fuzzy_arrival_suggestions','search_landlords_fuzzy','sofp_ledger_legs','ug_resolve_district_id')
  loop
    sp := coalesce(rec.cur, 'public');
    if sp !~ '(^|, )extensions(,|$)' then execute format('alter function %s set search_path = %s, extensions', rec.sig, sp); end if;
  end loop;
end $$;

-- ===== D. RLS enabled, no policy
do $$
declare rec record;
begin
  for rec in select c.relname from pg_class c
              where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and c.relrowsecurity
                and not exists (select 1 from pg_policies pol where pol.schemaname = 'public' and pol.tablename = c.relname)
  loop
    execute format('create policy %I on public.%I for all to anon, authenticated using (false) with check (false)', 'service_only_no_client_access', rec.relname);
    execute format('revoke all on public.%I from anon', rec.relname);
  end loop;
end $$;

-- ===== E. anon
do $$
declare
  keep text[] := array['attach_signup_attempt_user','record_signup_attempt','check_archived_account_by_email','check_archived_account_by_phone','check_fraud_account_by_email',
    'check_fraud_account_by_name','check_fraud_account_by_phone','check_phone_exists','get_email_by_phone','is_phone_available','log_archived_login_attempt',
    'is_fraud_identifier_blocked','get_manager_profiles','verify_staff_access_password','lookup_invite_by_token','current_proxy_agreement',
    'create_or_refresh_campaign_attribution','lock_campaign_attribution','restore_campaign_attribution','complete_campaign_attribution','record_short_link_click',
    'resolve_short_link','resolve_campaign_short_code','log_house_support_share_event','public_house_support_offer','get_landlord_payout_receipt',
    'get_payout_receipt_by_token','get_business_advance_public_status','share_onboarding_get','share_onboarding_submit','capture_location_by_token',
    'get_house_listing_filter_options','find_nearby_houses','get_listing_agent_contacts','search_locations','ug_search_villages','ug_resolve_village',
    'get_maps_browser_key','record_map_query_telemetry','ingest_user_telemetry_batch','get_public_trust_profile','check_mcp_public_rate_limit'];
  rec record;
begin
  for rec in select p.oid::regprocedure::text sig from pg_proc p
              where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype
                and has_function_privilege('anon', p.oid, 'execute') and not (p.proname = any(keep))
                and not exists (select 1 from pg_depend d join pg_policy pl on pl.oid = d.objid and d.classid = 'pg_policy'::regclass where d.refobjid = p.oid and d.refclassid = 'pg_proc'::regclass)
  loop
    execute format('revoke execute on function %s from public, anon', rec.sig);
    execute format('grant execute on function %s to authenticated, service_role', rec.sig);
  end loop;
end $$;

-- ===== F. closures for signed-in users (exact signatures; some are overloads)
do $$
declare s text; sigs text[] := array[
 'admin_reseed_wallet_cache(uuid,numeric,numeric)','agent_registration_gate_status(uuid)','apply_layer_a_writedown(uuid,boolean)','assert_funding_treasury_recognised(uuid)',
 'assert_no_urgent_landlord_priority(uuid)','assert_routing_compatible(text,text)','assistant_require_agent()','attach_campaign_registration(text,text)','auto_create_deposits_from_gmail(integer)',
 'calculate_business_advance_limit(uuid)','can_reverse_landlord_float(uuid)','can_send_tenant_notification(uuid,text,text)','can_view_agent_data(uuid,uuid)','cfo_bucket_a_post(uuid,text,text)',
 'commission_withdrawal_available(uuid)','create_tenant_in_app_notification(uuid,uuid,text,text,text,text,jsonb,timestamp with time zone)','credit_recruiter_override(uuid,text,text,text,text)',
 'credit_recruiter_override(uuid,text,uuid)','defer_email(text,bigint,integer)','delete_email(text,bigint)','email_queue_dispatch()','enqueue_email(text,jsonb)','funder_pending_hold(uuid)',
 'get_agent_vouch_limit_ugx(uuid)','get_kyc_effective_limits(uuid)','get_tenant_active_push_subscriptions(uuid)','get_tenant_ops_weekly_history(integer)','get_tenant_ops_weekly_performance(date)',
 'get_tenant_status_appendices(uuid[],text)','get_treasury_snapshot()','get_user_advance_reversal_available(uuid)','is_service_center_manager(uuid)','landlord_float_recall_go_live()',
 'landlord_payout_queue_blocked(uuid,timestamp with time zone)','landlord_pool_deploy(uuid,numeric,text,uuid,uuid,text)','mature_bonus_by_subject(text,uuid)','mature_referral_bonuses_for_invitee(uuid)',
 'merchant_claim_payload(uuid)','merchant_handles_payout(uuid,text,text,text)','merchant_reserved_float(uuid)','merchant_telecom_sending_charge(numeric)','move_to_dlq(text,text,bigint,jsonb)',
 'normalize_momo_tid(text)','ops_bulk_apply_capabilities(uuid[],text[],text,text)','ops_landlord_status_counts(text,timestamp with time zone,timestamp with time zone)',
 'payout_destination_is_verified(uuid,text,text,text,text)','post_instalment_waterfall(uuid,numeric,text,uuid,text)','promissory_commission_rate(text,timestamp with time zone)',
 'psm_disburse_landlord_float(uuid,uuid,uuid[])','read_email_batch(text,integer,integer)','recognise_funding_treasury(uuid)','recompute_agent_earned_vouch(uuid,text,uuid,numeric)',
 'record_agent_assisted_signup(uuid,text,text,text,text,text,text,text)','record_push_delivery(uuid,uuid,text,text,text,text)','record_tenant_notification(uuid,text,text,text,text,text,text,text,uuid,jsonb)',
 'rent_arrears_go_live()','rent_plan_amount_due_now(uuid)','rent_request_stale_return(text)','replace_tenant_at_property(uuid,uuid,text,timestamp with time zone)','reseed_anchored_balance(uuid,text)',
 'reseed_anchored_withdrawable(uuid,text)','resolve_owned_notification_email(uuid)','resolve_user_by_known_name(text)','resolve_user_by_known_phone(text)','send_daily_advance_deduction_summary()',
 'sms_cost_ugx(text,text)','subagent_listing_count(uuid)','telecom_sending_charge(numeric)','tops_agent_arrears_book(date)','tops_agent_float_adequacy(date)','tops_area_book(text,date)',
 'tops_arrears_ageing(date,text,integer,integer,text)','tops_calling_money_at_risk(uuid[])','tops_collections_movement(date,date,integer,integer)','tops_never_billed_summary(date)',
 'tops_never_billed(date,integer,integer,text)','tops_open_instalments_asof(date)','tops_overnight_changes(date)','tops_pipeline_queue_gap_counts()','tops_pipeline_queue(text,uuid)',
 'tops_plan_pipeline_stages(uuid)','tops_plan_schedule_ledger_count(uuid)','tops_portfolio_quality(date)','try_award_subagent_registration_bonus(uuid)','welile_default_agent_vouch_floor_ugx()',
 'welile_default_agent_vouch_floor_ugx(uuid)','welile_transfer_items()'];
begin
  -- the three invoker trigger functions that called the maturity functions become owner-rights first
  alter function public.trg_mature_on_house_verified_fn() security definer;
  alter function public.trg_mature_on_lc1_verified_fn() security definer;
  alter function public.trg_mature_on_rent_request_fn() security definer;
  foreach s in array sigs loop
    if to_regprocedure('public.' || s) is not null then
      execute format('revoke execute on function public.%s from public, anon, authenticated', s);
      execute format('grant execute on function public.%s to service_role', s);
    end if;
  end loop;
  -- never close plain helpers that views inline
  grant execute on function public.ug_norm_name(text) to authenticated;
  grant execute on function public.continent_for_country(text) to authenticated;
end $$;

-- ===== G1. direct-call detector (frames: this helper + the guarded function = 2 when the app called the guarded function directly)
create or replace function public._direct_client_call()
 returns boolean language plpgsql stable security invoker set search_path = public
as $f$
declare ctx text;
begin
  get diagnostics ctx = pg_context;
  return array_length(string_to_array(trim(both E'\n' from ctx), E'\n'), 1) <= 2;
end $f$;
grant execute on function public._direct_client_call() to authenticated, service_role;

-- ===== G2. generators (kept in the private _fn_lockdown schema)
create schema if not exists _fn_lockdown;
create or replace function _fn_lockdown.guard_staff(names text[]) returns text language plpgsql as $g$
declare
  rec record; guard text; d text; pos text; body text; cfg text; k text; v text; implname text; newsig text; implsig text; i int; wrapped int := 0; injected int := 0;
begin
  guard := ' /* advisor_guard */ if not (pg_trigger_depth() > 0 or public.can_view_staff_reports(auth.uid())) then raise exception ''not authorized'' using errcode = ''42501''; end if; ';
  for rec in
    select p.oid, p.proname, p.pronargs, p.proretset, p.provolatile, p.proconfig, l.lanname,
           pg_get_function_identity_arguments(p.oid) idargs, pg_get_function_arguments(p.oid) fnargs, pg_get_function_result(p.oid) fnres
      from pg_proc p join pg_language l on l.oid = p.prolang
     where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.prosecdef and p.proname = any(names)
       and has_function_privilege('authenticated', p.oid, 'execute')
  loop
    if rec.lanname = 'plpgsql' then
      d := pg_get_functiondef(rec.oid);
      if d like '%advisor_guard%' then continue; end if;
      execute regexp_replace(d, '\mbegin\M', 'begin' || replace(guard, '\', '\\'), 'i'); injected := injected + 1;
    else
      implname := rec.proname || '__impl'; implsig := format('public.%I(%s)', implname, rec.idargs); newsig := format('public.%I(%s)', rec.proname, rec.idargs);
      pos := ''; for i in 1..rec.pronargs loop pos := pos || case when i > 1 then ',' else '' end || '$' || i; end loop;
      body := case when rec.proretset then format('return query select * from public.%I(%s);', implname, pos) else format('return public.%I(%s);', implname, pos) end;
      execute format('alter function public.%I(%s) rename to %I', rec.proname, rec.idargs, implname);
      execute format('create function public.%I(%s) returns %s language plpgsql %s security definer set search_path = public as $f$ begin %s %s end $f$',
                     rec.proname, rec.fnargs, rec.fnres, case rec.provolatile when 's' then 'stable' when 'i' then 'immutable' else 'volatile' end, guard, body);
      if rec.proconfig is not null then
        foreach cfg in array rec.proconfig loop
          k := split_part(cfg, '=', 1); v := substr(cfg, length(k) + 2);
          if k = 'search_path' then execute format('alter function %s set search_path = %s', newsig, v); else execute format('alter function %s set %I to %L', newsig, k, v); end if;
        end loop;
      end if;
      execute format('revoke execute on function %s from public, anon, authenticated', implsig);
      execute format('grant execute on function %s to service_role', implsig);
      execute format('revoke execute on function %s from public, anon', newsig);
      execute format('grant execute on function %s to authenticated, service_role', newsig);
      wrapped := wrapped + 1;
    end if;
  end loop;
  return format('injected %s, wrapped %s', injected, wrapped);
end $g$;

create or replace function _fn_lockdown.guard_subject(spec jsonb) returns text language plpgsql as $g$
declare
  rec record; s text; guard text; pos text; body text; cfg text; k text; v text; implname text; newsig text; implsig text; i int; d text; wrapped int := 0; injected int := 0;
begin
  for rec in
    select p.oid, p.proname, p.pronargs, p.proretset, p.provolatile, p.proconfig, l.lanname,
           pg_get_function_identity_arguments(p.oid) idargs, pg_get_function_arguments(p.oid) fnargs, pg_get_function_result(p.oid) fnres
      from pg_proc p join pg_language l on l.oid = p.prolang
     where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.prosecdef and spec ? p.proname
       and has_function_privilege('authenticated', p.oid, 'execute')
  loop
    s := spec ->> rec.proname;
    -- the stack check is its own simple IF: a condition containing a subquery adds a stack frame and would make every call look nested
    if s = '@withdrawal' then
      guard := 'if public._direct_client_call() then if not (public.can_view_staff_reports(auth.uid()) or exists (select 1 from public.withdrawal_requests w where w.id = p_withdrawal_id and (w.user_id = auth.uid() or w.processed_by = auth.uid() or w.initiated_by = auth.uid() or w.agent_id = auth.uid() or w.user_id in (select public.agent_wallet_network_ids(auth.uid()))))) then raise exception ''not authorized'' using errcode = ''42501''; end if; end if;';
    else
      guard := format('if public._direct_client_call() then if not (public.can_view_staff_reports(auth.uid()) or coalesce(%1$s = auth.uid(), false) or coalesce(%1$s in (select public.agent_wallet_network_ids(auth.uid())), false)) then raise exception ''not authorized'' using errcode = ''42501''; end if; end if;', s);
    end if;
    guard := ' /* advisor_guard */ ' || guard || ' ';
    if rec.lanname = 'plpgsql' then
      d := pg_get_functiondef(rec.oid);
      if d like '%advisor_guard%' then continue; end if;
      execute regexp_replace(d, '\mbegin\M', 'begin' || replace(guard, '\', '\\'), 'i'); injected := injected + 1;
    else
      implname := rec.proname || '__impl'; implsig := format('public.%I(%s)', implname, rec.idargs); newsig := format('public.%I(%s)', rec.proname, rec.idargs);
      pos := ''; for i in 1..rec.pronargs loop pos := pos || case when i > 1 then ',' else '' end || '$' || i; end loop;
      body := case when rec.proretset then format('return query select * from public.%I(%s);', implname, pos) else format('return public.%I(%s);', implname, pos) end;
      execute format('alter function public.%I(%s) rename to %I', rec.proname, rec.idargs, implname);
      execute format('create function public.%I(%s) returns %s language plpgsql %s security definer set search_path = public as $f$ begin %s %s end $f$',
                     rec.proname, rec.fnargs, rec.fnres, case rec.provolatile when 's' then 'stable' when 'i' then 'immutable' else 'volatile' end, guard, body);
      if rec.proconfig is not null then
        foreach cfg in array rec.proconfig loop
          k := split_part(cfg, '=', 1); v := substr(cfg, length(k) + 2);
          if k = 'search_path' then execute format('alter function %s set search_path = %s', newsig, v); else execute format('alter function %s set %I to %L', newsig, k, v); end if;
        end loop;
      end if;
      execute format('revoke execute on function %s from public, anon, authenticated', implsig);
      execute format('grant execute on function %s to service_role', implsig);
      execute format('revoke execute on function %s from public, anon', newsig);
      execute format('grant execute on function %s to authenticated, service_role', newsig);
      wrapped := wrapped + 1;
    end if;
  end loop;
  return format('injected %s, wrapped %s', injected, wrapped);
end $g$;

-- ===== G3. staff-only reports (about 95 functions)
select _fn_lockdown.guard_staff(array['cc_cycle_outstanding','crm_communication_admin_list','cron_jobs_health','diagnose_pending_proxy_withdrawals','generate_house_listing_commission_report','get_advance_activity_monthly_trend','get_agent_advance_activity_correlation','get_agent_advance_potential','get_agent_advance_potential_for','get_agent_advance_repayment_monitor','get_agent_directory_region_breakdown','get_agent_duplicate_accounts','get_agent_ops_agent_stats','get_agent_ops_criteria_users','get_agent_ops_monthly_kpis','get_agent_rent_request_capacity','get_agent_workload_summary','get_approximate_user_count','get_authoritative_wallet','get_buffer_metrics','get_buffer_trend_data','get_cashout_settlement_ledger_rows','get_cashout_settlement_timeline','get_cfo_period_breakdown','get_chain_health_summary','get_daily_active_users','get_daily_signups','get_deferred_fee_breakdown','get_duplicate_roi_credits','get_financial_ops_pulse','get_flagged_tenants_for_transfer','get_ledger_integrity_checks','get_ledger_summary','get_manager_dashboard_stats','get_outstanding_agent_float','get_paginated_transactions','get_pending_wallet_ops','get_platform_cash_breakdown','get_property_clusters','get_property_status_counts','get_rent_requests_summary','get_signup_device_abuse','get_sms_cost_daily','get_sms_traffic_daily','get_supporter_pool_stats','get_tenant_behavior_segments','get_tenant_missed_dates','get_tenant_missed_days','get_tenant_ops_preset_by_slug','get_trust_coverage_stats','get_wallet_holder_activity_counts','get_wallet_ledger_category_sums','get_wallet_ops_stats','get_wallet_totals_strict','get_withdrawable_wallet_holders_by_recent_withdrawal','ops_get_daily_summary','ops_get_profiles_lite','ops_get_wallet_buckets','ops_search_landlords','partner_lead_candidates','promissory_ops_queue_state','run_email_auto_match_retry','tops_pipeline_queue_gap_counts_amclock','tppo_projection_zone_a','wallet_self_route_allowed','get_deposits_paginated','get_phone_platform_reconciliation','get_platform_cash_summary','get_wallet_totals','ops_tenant_repayment_forecast','get_agent_daily_eligibility','get_tenant_location_breakdown','get_tenants_at_leaf','get_location_breakdown','ops_landlord_report','get_oauth_funnel_stats','get_statement_of_cash_flows','get_financial_statement_ledger_sums','get_advance_reconciliation_summary','get_deposit_bridge_health','get_deposit_bridge_metrics','merchant_payout_success_matrix','ops_tutorial_members_list','tops_30m_awareness_stats','find_duplicate_phones','get_landlord_ops_rows']);

-- ===== G4. user-scoped reads: own / network / staff, direct calls only
select _fn_lockdown.guard_subject('{"get_user_available_balance":"p_user_id","get_withdraw_context":"p_user_id","get_partner_wallet_hub":"p_user_id","resolve_withdrawal_destination":"p_user_id","identity_already_verified":"p_user_id","identity_double_submission":"p_user_id","get_funder_approval_status":"_user_id","funder_support_capacity":"p_user_id","user_is_funder_with_portfolio":"p_user_id","user_is_pure_partner":"p_user_id","withdrawal_user_id_verified":"p_user_id","agent_advance_activity":"p_user_id","agent_advance_topup_eligibility":"p_agent_id","get_agent_reversible_allocations":"p_agent_id","get_proxy_partner_balance":"p_agent_id","get_user_float_available_balance":"p_user_id","has_active_smartphone_plan":"p_user","get_payout_receipt":"@withdrawal","withdrawal_destination_gate":"@withdrawal"}'::jsonb);

-- ===== G5. functions that had no check (credit / matching / sweep / logging / vouch / wallet view)
do $$
declare rec record; d text; g text; marker text := ' /* advisor_guard */ ';
begin
  for rec in select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) args from pg_proc p
              where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
                and p.proname in ('auto_match_email_deposits','sweep_agent_advance_recovery','detect_sms_verification_failures','detect_tenant_phone_near_duplicates','tppo_get_report_zone_a','recompute_agent_earned_vouch','get_user_wallet_view','log_system_event')
  loop
    d := pg_get_functiondef(rec.oid);
    if d like '%advisor_guard%' then continue; end if;
    g := case
      when rec.proname = 'auto_match_email_deposits' then marker || 'if not (pg_trigger_depth() > 0 or public.can_view_finance_reports(auth.uid())) then raise exception ''not authorized'' using errcode = ''42501''; end if; '
      when rec.proname = 'sweep_agent_advance_recovery' then marker || 'if not public.can_view_finance_reports(auth.uid()) then raise exception ''not authorized'' using errcode = ''42501''; end if; '
      when rec.proname in ('detect_sms_verification_failures','detect_tenant_phone_near_duplicates') then marker || 'if not public.can_view_staff_reports(auth.uid()) then raise exception ''not authorized'' using errcode = ''42501''; end if; '
      when rec.proname = 'tppo_get_report_zone_a' then marker || 'if coalesce(auth.role(), ''service_role'') <> ''service_role'' and not (auth.uid() is not null and exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.enabled = true and ur.role::text in (''tenant_ops'',''manager'',''super_admin'',''operations'',''coo'',''ceo'',''cto'',''cfo''))) then raise exception ''not authorized'' using errcode = ''42501''; end if; '
      when rec.proname = 'recompute_agent_earned_vouch' and rec.args = 'p_agent_id uuid' then marker || 'if not (public.can_view_staff_reports(auth.uid()) or p_agent_id = auth.uid()) then raise exception ''not authorized'' using errcode = ''42501''; end if; '
      when rec.proname = 'get_user_wallet_view' then marker || 'if not (pg_trigger_depth() > 0 or p_user_id = auth.uid() or (select public.can_view_staff_reports(auth.uid())) or p_user_id in (select public.agent_wallet_network_ids(auth.uid()))) then return jsonb_build_object(''user_id'', NULL, ''withdrawable'', 0, ''float_balance'', 0, ''advance_balance'', 0, ''pending_holds'', 0, ''total_visible'', 0, ''restricted_held'', 0); end if; '
      when rec.proname = 'log_system_event' then marker || 'if not (pg_trigger_depth() > 0 or p_user_id is not distinct from auth.uid() or public.can_view_staff_reports(auth.uid())) then p_user_id := auth.uid(); end if; '
      else null end;
    if g is null then continue; end if;
    execute regexp_replace(d, '\mbegin\M', 'begin' || replace(g, '\', '\\'), 'i');
  end loop;
end $$;

-- ===== H. views converted to security_invoker (identical rows for every audience; owner-rights functions that read them are unaffected)
alter view public.agent_advance_requests_privileged set (security_invoker = on);
alter view public.v_lc1_verification_inbox set (security_invoker = on);
alter view public.v_agent_landlord_float_reconciliation set (security_invoker = on);
alter view public.v_tenant_call_summary set (security_invoker = on);
alter view public.v_agent_daily_eligibility set (security_invoker = on);
alter view public.v_tenant_daily_eligibility set (security_invoker = on);
alter view public.v_tenant_ops_tenant_base set (security_invoker = on);

-- ===== I. restored after the post-pass log review: my_bank_account_lock() has its own identity check and a screen calls it
grant execute on function public.my_bank_account_lock() to authenticated;
