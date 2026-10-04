begin;
set local lock_timeout = '5s';

create table if not exists public.merchant_float_deliveries (
  id uuid primary key default gen_random_uuid(),
  tid_normalized text not null,
  agent_user_id uuid not null,
  amount numeric not null check (amount > 0),
  provider text,
  gmail_transaction_id uuid,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  ledger_group_id uuid
);

create unique index if not exists merchant_float_deliveries_tid_key
  on public.merchant_float_deliveries (tid_normalized);

alter table public.merchant_float_deliveries enable row level security;

drop policy if exists mfd_read on public.merchant_float_deliveries;
create policy mfd_read on public.merchant_float_deliveries
  for select using (
    public.has_role(auth.uid(), 'super_admin'::app_role)
    or public.has_role(auth.uid(), 'cfo'::app_role)
    or public.has_role(auth.uid(), 'financial_ops'::app_role)
  );

revoke all on table public.merchant_float_deliveries from anon, authenticated;

create or replace function public.record_merchant_float_delivery(
  p_tid text,
  p_agent_user_id uuid,
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
  v_tid text;
  v_delivery_id uuid;
  v_group_id uuid;
begin
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  end if;

  v_tid := regexp_replace(coalesce(p_tid,''), '[^A-Za-z0-9]', '', 'g');
  if v_tid = '' then
    return jsonb_build_object('ok', false, 'reason', 'missing_tid');
  end if;

  if exists (select 1 from public.ledger_reconciled_tids where tid_normalized = v_tid) then
    return jsonb_build_object('ok', true, 'reason', 'already_reconciled', 'tid', v_tid);
  end if;

  if not exists (
    select 1 from public.cashout_agents
    where agent_id = p_agent_user_id and is_active = true and float_phone is not null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'agent_not_registered');
  end if;

  insert into public.merchant_float_deliveries
    (tid_normalized, agent_user_id, amount, provider, gmail_transaction_id, occurred_at)
  values
    (v_tid, p_agent_user_id, p_amount, p_provider, p_gmail_transaction_id,
     coalesce(p_occurred_at, now()))
  on conflict (tid_normalized) do nothing
  returning id into v_delivery_id;

  if v_delivery_id is null then
    return jsonb_build_object('ok', true, 'reason', 'already_recorded', 'tid', v_tid);
  end if;

  v_group_id := public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', p_agent_user_id,
        'amount', p_amount,
        'direction', 'cash_in',
        'category', 'agent_float_deposit',
        'ledger_scope', 'wallet',
        'wallet_bucket', 'float',
        'recipient_type', 'operational_wallet',
        'source_table', 'merchant_float_deliveries',
        'source_id', v_delivery_id,
        'reference_id', v_tid,
        'description', format('Company float delivery to merchant agent via %s (TID %s)',
                              coalesce(p_provider,'mobile money'), v_tid),
        'currency', 'UGX',
        'transaction_date', coalesce(p_occurred_at, now())
      ),
      jsonb_build_object(
        'amount', p_amount,
        'direction', 'cash_out',
        'category', 'agent_float_deposit',
        'ledger_scope', 'platform',
        'source_table', 'merchant_float_deliveries',
        'source_id', v_delivery_id,
        'reference_id', v_tid,
        'description', 'Platform: company float delivered to merchant agent line',
        'currency', 'UGX',
        'transaction_date', coalesce(p_occurred_at, now())
      )
    ),
    idempotency_key := 'merchant_float:' || v_tid,
    skip_balance_check := true
  );

  update public.merchant_float_deliveries
     set ledger_group_id = v_group_id
   where id = v_delivery_id;

  insert into public.ledger_reconciled_tids
    (tid_normalized, source, source_id, amount, user_id, notes, created_by)
  values
    (v_tid, 'merchant_float_sms', v_group_id, p_amount, p_agent_user_id,
     'Auto: outbound company SMS matched a merchant agent registered float phone', null)
  on conflict (tid_normalized) do nothing;

  perform public.apply_wallet_movement(
    p_user_id := p_agent_user_id,
    p_category := 'agent_float_deposit',
    p_amount := p_amount,
    p_direction := 'cash_in',
    p_recipient_type := 'operational_wallet'
  );

  return jsonb_build_object('ok', true, 'reason', 'credited',
                            'tid', v_tid, 'delivery_id', v_delivery_id,
                            'ledger_group_id', v_group_id);
end $fn$;

revoke all on function public.record_merchant_float_delivery(text, uuid, numeric, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_merchant_float_delivery(text, uuid, numeric, text, uuid, timestamptz)
  to service_role;

commit;