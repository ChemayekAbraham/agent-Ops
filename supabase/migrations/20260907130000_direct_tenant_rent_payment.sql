-- Tenant Ops meeting (2026-09-06), item #7: a tenant paying rent directly
-- into Welile's own MTN (090777) / Airtel (4380664) merchant tills must be
-- attributed to their responsible agent (commission) and applied to their
-- rent balance, instead of the existing self-deposit auto-credit path
-- (gmail-poll-transactions' _tryAutoCreditOperationalFloat) silently
-- crediting the tenant's OWN operational float — which is what happens
-- today, because both tills are already the shared destination for every
-- self-deposit (agent float top-up, wallet top-up, etc.) and the ingestion
-- pipeline only ever resolves "which profile does this money belong to,"
-- never "is this actually a rent payment."
--
-- The agent never fronted float for this payment (the tenant paid Welile
-- directly), so the ledger legs deliberately differ from
-- agent_allocate_tenant_payment_internal: there is no agent-float cash_out
-- leg. Real cash landed in Welile's own till, so a platform-scope leg funds
-- both the tenant's rent-receivable credit and the agent's commission —
-- commission economics (10%, 8/2 parent split) are kept identical to an
-- in-person collection per product decision.
--
-- Deliberately conservative: if the tenant has no active rent request, or
-- the amount exceeds what they still owe, this returns ok:false and the
-- caller falls back to the existing default behavior — it never invents a
-- new destination for money it isn't confident is a rent payment.

create table if not exists public.direct_tenant_rent_payments (
  id uuid primary key default gen_random_uuid(),
  tid_normalized text not null,
  tenant_id uuid not null references public.profiles(id),
  rent_request_id uuid not null references public.rent_requests(id),
  agent_id uuid not null references public.profiles(id),
  parent_agent_id uuid references public.profiles(id),
  provider text,
  gmail_transaction_id uuid,
  amount numeric not null check (amount > 0),
  amount_applied numeric not null check (amount_applied > 0),
  commission_earned numeric not null default 0,
  parent_override numeric not null default 0,
  occurred_at timestamptz not null,
  ledger_group_id uuid,
  recorded_at timestamptz not null default now()
);

create unique index if not exists direct_tenant_rent_payments_tid_key
  on public.direct_tenant_rent_payments (tid_normalized);

create index if not exists idx_direct_tenant_rent_payments_tenant
  on public.direct_tenant_rent_payments (tenant_id, recorded_at desc);

create index if not exists idx_direct_tenant_rent_payments_agent
  on public.direct_tenant_rent_payments (agent_id, recorded_at desc);

alter table public.direct_tenant_rent_payments enable row level security;

drop policy if exists dtrp_read on public.direct_tenant_rent_payments;
create policy dtrp_read on public.direct_tenant_rent_payments
  for select using (
    public.has_role(auth.uid(), 'super_admin'::app_role)
    or public.has_role(auth.uid(), 'cfo'::app_role)
    or public.has_role(auth.uid(), 'financial_ops'::app_role)
    or public.has_role(auth.uid(), 'tenant_ops'::app_role)
    or public.has_role(auth.uid(), 'manager'::app_role)
    or public.has_role(auth.uid(), 'coo'::app_role)
  );

revoke all on table public.direct_tenant_rent_payments from anon, authenticated;

create or replace function public.record_direct_tenant_rent_payment(
  p_tid text,
  p_tenant_id uuid,
  p_amount numeric,
  p_provider text,
  p_gmail_transaction_id uuid,
  p_occurred_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_tid                text;
  v_rent_request_id    uuid;
  v_agent_id           uuid;
  v_landlord_id        uuid;
  v_landlord_name      text;
  v_current_status     text;
  v_total_repayment    numeric;
  v_amount_repaid      numeric;
  v_outstanding        numeric;
  v_apply              numeric;
  v_total_commission   numeric;
  v_commission_earned  numeric;
  v_parent_agent_id    uuid;
  v_parent_override    numeric := 0;
  v_whitelisted        boolean := false;
  v_payment_id         uuid;
  v_group_id           uuid;
  v_new_status         text;
  v_legs               jsonb;
begin
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  end if;

  v_tid := regexp_replace(coalesce(p_tid, ''), '[^A-Za-z0-9]', '', 'g');
  if v_tid = '' then
    return jsonb_build_object('ok', false, 'reason', 'missing_tid');
  end if;

  if exists (select 1 from public.ledger_reconciled_tids where tid_normalized = v_tid) then
    return jsonb_build_object('ok', true, 'reason', 'already_reconciled', 'tid', v_tid);
  end if;

  -- Most relevant open rent request for this tenant (mirrors the
  -- TenantDashboard / get_tenant_repayment_reliability convention: the
  -- active one, falling back to none rather than guessing among several).
  select rr.id, coalesce(rr.assigned_agent_id, rr.agent_id), rr.landlord_id, l.name,
         rr.status, coalesce(rr.total_repayment, 0), coalesce(rr.amount_repaid, 0)
    into v_rent_request_id, v_agent_id, v_landlord_id, v_landlord_name,
         v_current_status, v_total_repayment, v_amount_repaid
    from public.rent_requests rr
    left join public.landlords l on l.id = rr.landlord_id
   where rr.tenant_id = p_tenant_id
     and rr.status not in ('completed', 'rejected')
   order by rr.created_at desc
   limit 1;

  if v_rent_request_id is null then
    return jsonb_build_object('ok', false, 'reason', 'no_active_rent_request');
  end if;

  if v_agent_id is null then
    return jsonb_build_object('ok', false, 'reason', 'no_responsible_agent', 'rent_request_id', v_rent_request_id);
  end if;

  v_outstanding := greatest(0, v_total_repayment - v_amount_repaid);

  if v_outstanding <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_outstanding_balance', 'rent_request_id', v_rent_request_id);
  end if;

  if p_amount > v_outstanding then
    return jsonb_build_object(
      'ok', false, 'reason', 'amount_exceeds_outstanding',
      'rent_request_id', v_rent_request_id, 'outstanding', v_outstanding
    );
  end if;

  v_apply := p_amount;
  v_total_commission := round(v_apply * 0.10, 2);

  select sa.parent_agent_id into v_parent_agent_id
    from public.agent_subagents sa
   where sa.sub_agent_id = v_agent_id
     and sa.status in ('verified', 'approved', 'accepted')
     and sa.parent_agent_id <> v_agent_id
   limit 1;

  v_whitelisted := public.is_subagent_commission_whitelisted(v_agent_id);

  if v_parent_agent_id is not null and not v_whitelisted then
    v_commission_earned := round(v_apply * 0.08, 2);
    v_parent_override   := v_total_commission - v_commission_earned;
  else
    v_commission_earned := v_total_commission;
    v_parent_override   := 0;
  end if;

  insert into public.direct_tenant_rent_payments (
    tid_normalized, tenant_id, rent_request_id, agent_id, parent_agent_id,
    provider, gmail_transaction_id, amount, amount_applied,
    commission_earned, parent_override, occurred_at
  ) values (
    v_tid, p_tenant_id, v_rent_request_id, v_agent_id, v_parent_agent_id,
    p_provider, p_gmail_transaction_id, p_amount, v_apply,
    v_commission_earned, v_parent_override, coalesce(p_occurred_at, now())
  )
  on conflict (tid_normalized) do nothing
  returning id into v_payment_id;

  if v_payment_id is null then
    return jsonb_build_object('ok', true, 'reason', 'already_recorded', 'tid', v_tid);
  end if;

  v_legs := jsonb_build_array(
    jsonb_build_object(
      'amount', v_apply,
      'direction', 'cash_out',
      'category', 'direct_tenant_rent_payment_funds_rent',
      'ledger_scope', 'platform',
      'classification', 'production',
      'description', format('Platform: tenant rent payment received directly via %s till (TID %s)',
                            coalesce(p_provider, 'mobile money'), v_tid),
      'source_table', 'direct_tenant_rent_payments',
      'source_id', v_payment_id,
      'reference_id', v_tid
    ),
    jsonb_build_object(
      'user_id', p_tenant_id,
      'amount', v_apply,
      'direction', 'cash_in',
      'category', 'rent_receivable_created',
      'ledger_scope', 'bridge',
      'classification', 'production',
      'description', format('Tenant paid rent directly to Welile for landlord %s', coalesce(v_landlord_name, 'Unknown')),
      'linked_party', v_landlord_id,
      'source_table', 'direct_tenant_rent_payments',
      'source_id', v_payment_id,
      'reference_id', v_tid
    ),
    jsonb_build_object(
      'user_id', v_agent_id,
      'amount', v_commission_earned,
      'direction', 'cash_in',
      'category', 'agent_commission_earned',
      'ledger_scope', 'wallet',
      'classification', 'production',
      'description', CASE WHEN v_whitelisted AND v_parent_agent_id IS NOT NULL
                          THEN 'Full 10% commission on direct tenant rent payment (whitelisted sub-agent)'
                          ELSE '10% commission on direct tenant rent payment' END,
      'recipient_type', 'user',
      'source_table', 'direct_tenant_rent_payments',
      'source_id', v_payment_id,
      'reference_id', v_tid
    ),
    jsonb_build_object(
      'amount', v_total_commission,
      'direction', 'cash_out',
      'category', 'agent_commission_payable',
      'ledger_scope', 'platform',
      'classification', 'production',
      'description', 'Platform commission payout on direct tenant rent payment',
      'source_table', 'direct_tenant_rent_payments',
      'source_id', v_payment_id,
      'reference_id', v_tid
    )
  );

  if v_parent_agent_id is not null and v_parent_override > 0 then
    v_legs := v_legs || jsonb_build_array(
      jsonb_build_object(
        'user_id', v_parent_agent_id,
        'amount', v_parent_override,
        'direction', 'cash_in',
        'category', 'agent_commission_earned',
        'ledger_scope', 'wallet',
        'classification', 'production',
        'description', '2% recruiter override on sub-agent direct tenant rent payment',
        'recipient_type', 'user',
        'source_table', 'direct_tenant_rent_payments',
        'source_id', v_payment_id,
        'reference_id', v_tid
      )
    );
  end if;

  v_group_id := public.create_ledger_transaction(v_legs, 'direct_tenant_rent_payment:' || v_tid);

  update public.direct_tenant_rent_payments set ledger_group_id = v_group_id where id = v_payment_id;

  update public.rent_requests
     set amount_repaid = coalesce(amount_repaid, 0) + v_apply,
         status = case
                    when coalesce(amount_repaid, 0) + v_apply >= coalesce(total_repayment, 0) then 'completed'
                    when status in ('disbursed', 'funded', 'approved') then 'repaying'
                    else status
                  end,
         updated_at = now()
   where id = v_rent_request_id
  returning status into v_new_status;

  insert into public.ledger_reconciled_tids
    (tid_normalized, source, source_id, amount, user_id, notes, created_by)
  values
    (v_tid, 'direct_tenant_rent_payment', v_group_id, v_apply, p_tenant_id,
     'Auto: tenant paid rent directly into Welile merchant till', null)
  on conflict (tid_normalized) do nothing;

  perform public.refresh_wallet_projection_for(p_tenant_id);
  perform public.refresh_wallet_projection_for(v_agent_id);
  if v_parent_agent_id is not null then
    perform public.refresh_wallet_projection_for(v_parent_agent_id);
  end if;

  return jsonb_build_object(
    'ok', true, 'reason', 'credited', 'tid', v_tid,
    'payment_id', v_payment_id, 'ledger_group_id', v_group_id,
    'tenant_id', p_tenant_id, 'rent_request_id', v_rent_request_id, 'agent_id', v_agent_id,
    'amount_applied', v_apply, 'commission_earned', v_commission_earned,
    'parent_agent_id', v_parent_agent_id, 'parent_override', v_parent_override,
    'new_status', v_new_status, 'outstanding_after', greatest(0, v_outstanding - v_apply)
  );
end;
$fn$;

revoke all on function public.record_direct_tenant_rent_payment(text, uuid, numeric, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_direct_tenant_rent_payment(text, uuid, numeric, text, uuid, timestamptz)
  to service_role;
