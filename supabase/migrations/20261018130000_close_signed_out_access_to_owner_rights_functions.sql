-- 2026-10-18 (doc 247, step 8): signed-out (anon) access to owner-rights (SECURITY DEFINER) functions in public.
-- Before: 2,355 callable-from-outside owner-rights functions were executable by anon (functions are PUBLIC-executable by default).
-- Many are company-wide reports with no caller check (cash position, wallet totals, cash-flow statement, ledger summary, paginated transactions,
-- agent 360 profiles, tenant candidate lists ...). After this step 199 remain, each kept deliberately (see the keep lists below).
-- Signed-in users keep EXECUTE (authenticated is re-granted); this only removes the signed-out role. Service role is unaffected.
-- Applied to production 2026-10-18 in three tiers; every function changed is logged with its old ACL in _fn_lockdown.log.
-- Restore one if a signed-out flow is found to need it: grant execute on function <signature> to anon;
--
-- A function is NEVER revoked here when (a) a policy, default, constraint, trigger, index expression, security-invoker view or caller-run
-- function depends on it (Postgres checks EXECUTE for the calling role there), (b) its name appears in a caller-run function body, or
-- (c) it has an explicit grant to another role.
-- Needs the schema/log table from migration 20261017140000 (_fn_lockdown.log).
create schema if not exists _fn_lockdown;

create or replace function _fn_lockdown.sweep_anon(p_deny_regex text, p_keep_regex text, p_apply boolean) returns table(o_name text, o_signature text, o_action text, o_reason text) language plpgsql as $f$
declare r record; keep text;
begin
  for r in
    select p.oid, p.proname, p.oid::regprocedure::text sig, p.proacl
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.prosecdef
       and p.prorettype <> 'trigger'::regtype
       and p.proname ~ p_deny_regex
       and has_function_privilege('anon', p.oid, 'execute')
     order by p.proname, p.oid
  loop
    o_name := r.proname; o_signature := r.sig;
    if p_keep_regex is not null and r.proname ~ p_keep_regex then
      o_action := 'keep'; o_reason := 'matches the public/pre-login keep pattern'; return next; continue;
    end if;
    keep := null;
    select string_agg(distinct d.classid::regclass::text, ',') into keep
      from pg_depend d
     where d.refclassid = 'pg_proc'::regclass and d.refobjid = r.oid and d.deptype in ('n','a')
       and ( d.classid in ('pg_policy'::regclass, 'pg_attrdef'::regclass, 'pg_constraint'::regclass, 'pg_trigger'::regclass)
          or (d.classid = 'pg_class'::regclass)
          or (d.classid = 'pg_rewrite'::regclass and exists (select 1 from pg_rewrite rw join pg_class vc on vc.oid = rw.ev_class where rw.oid = d.objid and coalesce(vc.reloptions::text, '') ilike '%security_invoker=true%'))
          or (d.classid = 'pg_proc'::regclass and exists (select 1 from pg_proc q where q.oid = d.objid and not q.prosecdef)) );
    if keep is not null then o_action := 'keep'; o_reason := 'dependency: ' || keep; return next; continue; end if;
    if exists (select 1 from pg_proc q where q.pronamespace = 'public'::regnamespace and not q.prosecdef and q.oid <> r.oid and q.prosrc ~ ('\m' || r.proname || '\M')) then
      o_action := 'keep'; o_reason := 'named in a caller-run function body'; return next; continue;
    end if;
    if exists (select 1 from aclexplode(coalesce(r.proacl, acldefault('f', (select proowner from pg_proc where oid = r.oid)))) a join pg_roles ro on ro.oid = a.grantee where ro.rolname not in ('postgres','anon','authenticated','service_role','supabase_admin')) then
      o_action := 'keep'; o_reason := 'explicit grant to another role'; return next; continue;
    end if;
    o_reason := 'no dependency found';
    if p_apply then
      insert into _fn_lockdown.log(signature, fname, old_acl, action, reason) values (r.sig, r.proname, (select array_agg(x::text) from unnest(coalesce(r.proacl, '{}'::aclitem[])) x), 'revoked-anon-only', 'sweep_anon: ' || p_deny_regex);
      execute format('revoke execute on function %s from public, anon', r.sig);
      execute format('grant execute on function %s to authenticated, service_role', r.sig);
      o_action := 'revoked-anon';
    else
      o_action := 'would-revoke-anon';
    end if;
    return next;
  end loop;
end $f$;

-- Tier A (552 closed, 76 kept): clearly staff / backend prefixes. Kept: public or pre-login patterns (careers, requisition forms, tutorials, tokens, invites, shares, short links, campaign links, receipts, referrals, telemetry).
select * from _fn_lockdown.sweep_anon('^(ops|tops|hr|cfo|cc|budget|food|crm|finops|staff|engrep|cto|pso|admin|rd|coo|ceo|psm|tppo|am|awareness|assistant|reverse|reconcile|recompute|detect|bulk|apply|credit|release|delete|post|reject|approve|complete|cancel|restate|snapshot|sweep|sync|process|purge|retry|expire|dispatch|disburse|settle)_', 'career|intern|applicant|requisition|tutorial|public|token|invite|share|short_link|campaign|signup|login|otp|trust_profile|receipt|referral|install|oauth|telemetry', true);

-- Tier B (348 closed, 36 kept): get_* functions (mostly company reports). Kept: public stats, receipts, trust profile, house/property/location lookups, maps key, promo stats, the manager list.
select * from _fn_lockdown.sweep_anon('^get_', 'email_by_phone|manager_profiles|oauth_funnel|public|receipt|approximate_user_count|supporter_pool_stats|house|property|propert|location|maps_browser_key|promo|trust_coverage|listing_agent|nearby|village|invite|share|token', true);

-- Tier C (580 closed, 163 kept): every other function except an explicit signed-out allow-list (sign-in and signup checks, fraud/archive checks, campaign and short links, token pages, agreements, location search, staff portal verify).
select * from _fn_lockdown.sweep_anon('^(?!get_)', '^(attach_signup_attempt_user|record_signup_attempt|check_archived_account_by_email|check_archived_account_by_phone|check_fraud_account_by_email|check_fraud_account_by_name|check_fraud_account_by_phone|check_phone_exists|is_fraud_identifier_blocked|is_phone_available|log_archived_login_attempt|ingest_user_telemetry_batch|record_map_query_telemetry|identity_already_verified|identity_double_submission|verify_staff_access_password|create_or_refresh_campaign_attribution|lock_campaign_attribution|restore_campaign_attribution|complete_campaign_attribution|complete_campaign_attribution_for_user|attach_campaign_registration|record_campaign_click|record_short_link_click|resolve_short_link|resolve_campaign_short_code|claim_lead_click|claim_tenant_referrer|record_agent_assisted_signup|auto_activate_merchant_referral|capture_location_by_token|capture_trust_signal|lookup_invite_by_token|share_onboarding_get|share_onboarding_list|share_onboarding_submit|public_house_support_offer|lookup_landlord_payout_receipt|track_rent_access_promo|consume_requisition_link_slot|log_usage_report_notice_event|log_house_support_share_event|record_tenant_dashboard_access|issue_tenant_dashboard_link|landlord_agreement_history|landlord_has_current_agreement|submit_landlord_agreement|verify_landlord_registered|submit_tenant_rent_intake|tenant_rent_plan_detail|tenant_payment_history|search_locations|ug_search_villages|ug_resolve_village|find_nearby_houses|current_proxy_agreement|check_mcp_public_rate_limit|submit_requisition_usage_report|countersign_prepare_support|find_lc1_by_phone|national_id_link_state|national_id_link_owner_decision|national_id_holder_hint|national_id_link_mark_code_verified|national_id_link_send_target|national_id_link_mark_code_sent)$', true);

-- Two scheduled jobs called the REST API with the public key and broke when their functions were closed to anon (found in the API response log):
-- detect-credit-limit-drift-15min (every 15 min) and relink-stuck-pending-deposits-daily (03:30 UTC). They now call the functions directly as the
-- database owner, so no scheduled job depends on the public key. (Jobs are matched by name: job ids differ between projects.)
select cron.alter_job((select jobid from cron.job where jobname = 'detect-credit-limit-drift-15min'), command := $c$select * from public.detect_credit_limit_reconciliation_drift();$c$);
select cron.alter_job((select jobid from cron.job where jobname = 'relink-stuck-pending-deposits-daily'), command := $c$select public.relink_stuck_pending_deposits(p_min_age_minutes := 1440, p_max_age_days := 36500);$c$);
