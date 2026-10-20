-- 2026-10-18 (doc 247, step 11): two batch-payout functions any signed-in user could trigger.
--
-- pay_partner_self_cycles(p_limit): credits every pending partner self-payout cycle whose cycle_end has passed. Its only caller is the cron job
--   partner-self-payouts-daily, which runs `select public.pay_partner_self_cycles(500)` directly as the database owner (the mention in
--   SelfManagedNearingPayouts.tsx is a comment). Closed to service_role only via _fn_lockdown.run.
--
-- welile_home_run_landlord_payouts(p_as_of): pays every collected, unpaid Welile Homes monthly due whose payout_date <= p_as_of, to the landlord's
--   wallet or the managing agent's landlord float, through create_ledger_transaction with the balance check skipped. Callers: the cron job
--   welile-homes-landlord-payouts (direct, as owner) and a "run payouts" button in WelileHomesAdminPanel (Agent Ops / Tenant Ops dashboards).
--   It had no caller check, and p_as_of is caller-supplied, so a far-future date paid dues before their scheduled payout date.
--   Now: service role, or staff (is_sensitive_field_editor, or an active staff permission for agent-ops / tenant-ops / financial-ops / company-ops).
--   For non-service callers p_as_of is clamped to today (Africa/Kampala). Behaviour for the cron job is unchanged.
--
-- Already applied to production 2026-10-18. Needs _fn_lockdown.run from migration 20261017140000.
select * from _fn_lockdown.run(array['pay_partner_self_cycles'], true);

create or replace function public.welile_home_run_landlord_payouts(p_as_of date default current_date)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $f$
declare
  v_uid uuid := auth.uid();
  v_service boolean := coalesce(auth.role(), 'service_role') = 'service_role';
  v_as_of date := p_as_of;
  v_due record;
  v_uses_wallet boolean;
  v_landlord_id uuid;
  v_landlord_name text;
  v_landlord_phone text;
  v_agent_id uuid;
  v_tenant_id uuid;
  v_legs jsonb;
  v_txn uuid;
  v_key text;
  v_paid_count int := 0;
  v_paid_total numeric := 0;
begin
  if not v_service then
    if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
    if not (public.is_sensitive_field_editor(v_uid)
            or exists (select 1 from public.staff_permissions sp where sp.user_id = v_uid and sp.revoked_at is null
                        and sp.permitted_dashboard = any (array['agent-ops','tenant-ops','financial-ops','company-ops']))) then
      raise exception 'only staff can run landlord payouts' using errcode = '42501';
    end if;
    -- never pay dues ahead of their scheduled payout date
    v_as_of := least(coalesce(p_as_of, (now() at time zone 'Africa/Kampala')::date), (now() at time zone 'Africa/Kampala')::date);
  end if;

  for v_due in
    select d.id, d.subscription_id, d.landlord_net, d.tenant_id,
           s.landlord_uses_wallet, s.landlord_id, s.landlord_name, s.landlord_phone, s.agent_id
    from public.welile_homes_monthly_dues d
    join public.welile_homes_subscriptions s on s.id = d.subscription_id
    where d.collection_status = 'collected'
      and d.payout_status = 'unpaid'
      and d.payout_date <= v_as_of
      and d.landlord_net > 0
    order by d.payout_date
  loop
    v_uses_wallet    := v_due.landlord_uses_wallet;
    v_landlord_id    := v_due.landlord_id;
    v_landlord_name  := v_due.landlord_name;
    v_landlord_phone := v_due.landlord_phone;
    v_agent_id       := v_due.agent_id;
    v_tenant_id      := v_due.tenant_id;

    v_key := format('welile_home_payout:%s:%s', v_due.id, gen_random_uuid()::text);

    if v_uses_wallet and v_landlord_id is not null then
      v_legs := jsonb_build_array(
        jsonb_build_object('user_id',v_landlord_id,'amount',v_due.landlord_net,'direction','cash_out','category','rent_disbursement','ledger_scope','platform','classification','production','description','Welile Homes landlord payout','source_table','welile_homes_monthly_dues','source_id',v_due.id),
        jsonb_build_object('user_id',v_landlord_id,'amount',v_due.landlord_net,'direction','cash_in','category','landlord_rent_payment','ledger_scope','wallet','classification','production','description','Welile Homes rent received (90%)','recipient_type','user','source_table','welile_homes_monthly_dues','source_id',v_due.id)
      );
      v_txn := public.create_ledger_transaction(v_legs, v_key, true);

      update public.welile_homes_monthly_dues
      set payout_status = 'paid_wallet', ledger_transaction_id = coalesce(ledger_transaction_id, v_txn), updated_at = now()
      where id = v_due.id;

    elsif v_agent_id is not null then
      -- Credit the managing agent's landlord-float so they can withdraw and hand over
      v_legs := jsonb_build_array(
        jsonb_build_object('user_id',v_agent_id,'amount',v_due.landlord_net,'direction','cash_out','category','rent_disbursement','ledger_scope','platform','classification','production','description','Welile Homes landlord payout via agent float','source_table','welile_homes_monthly_dues','source_id',v_due.id),
        jsonb_build_object('user_id',v_agent_id,'amount',v_due.landlord_net,'direction','cash_in','category','agent_landlord_payout','ledger_scope','wallet','classification','production','description','Welile Homes landlord float (to hand to landlord)','recipient_type','operational_wallet','source_table','welile_homes_monthly_dues','source_id',v_due.id)
      );
      v_txn := public.create_ledger_transaction(v_legs, v_key, true);

      -- Track a per-landlord obligation the agent must settle
      insert into public.agent_landlord_float_allocations (
        agent_id, tenant_id, landlord_id, landlord_name, landlord_phone,
        allocated_amount, status, source, notes
      ) values (
        v_agent_id, v_tenant_id, v_landlord_id, coalesce(v_landlord_name, 'Welile Homes landlord'), v_landlord_phone,
        v_due.landlord_net, 'open', 'welile_homes_payout', 'Welile Homes monthly landlord payout'
      );

      update public.welile_homes_monthly_dues
      set payout_status = 'paid_float', ledger_transaction_id = coalesce(ledger_transaction_id, v_txn), updated_at = now()
      where id = v_due.id;
    else
      continue; -- no route available; leave unpaid
    end if;

    v_paid_count := v_paid_count + 1;
    v_paid_total := v_paid_total + v_due.landlord_net;

    begin
      insert into public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
      values ('rent_disbursed', coalesce(v_landlord_id, v_agent_id), 'welile_homes_monthly_dues', v_due.id,
        jsonb_build_object('action','landlord_payout','amount',v_due.landlord_net,'via', case when v_uses_wallet and v_landlord_id is not null then 'wallet' else 'agent_float' end,'txn',v_txn));
    exception when others then null;
    end;
  end loop;

  return jsonb_build_object('success', true, 'payouts', v_paid_count, 'total_paid', v_paid_total, 'as_of', v_as_of);
end;
$f$;
