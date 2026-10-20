-- 2026-10-18 (doc 247, step 21): six owner-rights report/snapshot writers that any signed-in user could call.
-- The tables behind them require specific roles through RLS (agent_ops_reports: agent_ops; tppo_reports: tenant_ops), but these SECURITY DEFINER functions bypass that:
--   agent_ops_open_report, agent_ops_compute_snapshot, agent_ops_carry_actions  (Agent Ops daily/weekly/monthly report window)
--   tppo_freeze_period, tppo_notify_reviewer_on_overdue_actions                (Tenant Ops portfolio performance report: freezes a period, notifies reviewers)
--   hr_compute_snapshots                                                       (HR productivity metrics recompute; also run daily by cron)
-- Check added at the top of each body: service role / no signed-in role (cron, edge functions, owner chains) passes; otherwise the caller needs an enabled role:
--   agent_ops_*: agent_ops, manager, super_admin, operations, coo, ceo, cto
--   tppo_*:      tenant_ops, manager, super_admin, operations, coo, ceo, cto, cfo
--   hr_compute_snapshots: hr, manager, super_admin, coo, ceo, cto, or hr_is_executive()
-- Other callers checked: agent_ops_run_snapshot_cycle and tppo_refresh_daily_snapshot are cron-only (no JWT), hr_recompute_current_month / tppo_get_report_zone_a are RPC-only.
-- Not changed (checked, already guarded through helpers my first pattern missed): engrep_* (engrep_is_adjudicator), hr_pay_correct_compensation / hr_pay_set_statutory_profile
-- (hr_pay_is_rule_admin / is_preparer), hr_clear_staff_birth_date (hr_birthday_can_write), set_proxy_target_mode (proxy_cc_resolve_agent).
-- Left open on purpose: reset_agent_float_if_stale (idempotent daily counter rollover, called inside collection functions for the agent being served).
-- NOTE: current_user inside a SECURITY DEFINER body is the function OWNER, so a `current_user = 'authenticated'` gate does nothing there (tried, tested, reverted);
-- it only works in views. Applied to production 2026-10-18; the DO block rewrites the current definitions and is idempotent.
do $$
declare
  rec record; d text; g text; r text;
  roles_ops text := $q$'agent_ops','manager','super_admin','operations','coo','ceo','cto'$q$;
  roles_tppo text := $q$'tenant_ops','manager','super_admin','operations','coo','ceo','cto','cfo'$q$;
  roles_hr text := $q$'hr','manager','super_admin','coo','ceo','cto'$q$;
begin
  for rec in select p.oid, p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('agent_ops_carry_actions','agent_ops_compute_snapshot','agent_ops_open_report','hr_compute_snapshots','tppo_freeze_period','tppo_notify_reviewer_on_overdue_actions')
  loop
    r := case when rec.proname like 'agent_ops_%' then roles_ops when rec.proname like 'tppo_%' then roles_tppo else roles_hr end;
    g := ' if coalesce(auth.role(), ''service_role'') <> ''service_role'' and not (auth.uid() is not null and (exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.enabled = true and ur.role::text in (' || r || '))'
         || case when rec.proname like 'hr_%' then ' or public.hr_is_executive()' else '' end
         || ')) then raise exception ''not authorized'' using errcode = ''42501''; end if; ';
    d := pg_get_functiondef(rec.oid);
    if d ~ 'coalesce\(auth\.role\(\), ''service_role''\) <> ''service_role'' and not \(auth\.uid' then continue; end if;
    d := regexp_replace(d, '\mbegin\M', 'begin' || g, 'i');
    execute d;
  end loop;
end $$;
