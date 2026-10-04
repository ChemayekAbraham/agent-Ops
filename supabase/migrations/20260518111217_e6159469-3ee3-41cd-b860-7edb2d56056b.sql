create table if not exists public.gmail_deposit_exclusions (
  id uuid primary key default gen_random_uuid(),
  gmail_transaction_id uuid references public.gmail_transactions(id) on delete cascade,
  gmail_message_id text,
  reason text not null,
  direction text,
  amount numeric,
  transaction_id text,
  from_email text,
  subject text,
  snippet text,
  internal_date timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists gmail_deposit_exclusions_reason_idx
  on public.gmail_deposit_exclusions (reason, created_at desc);
create index if not exists gmail_deposit_exclusions_tx_idx
  on public.gmail_deposit_exclusions (gmail_transaction_id);

alter table public.gmail_deposit_exclusions enable row level security;

drop policy if exists "staff read gmail exclusions" on public.gmail_deposit_exclusions;
create policy "staff read gmail exclusions"
  on public.gmail_deposit_exclusions
  for select
  to authenticated
  using (
    public.has_role(auth.uid(), 'manager')
    or public.has_role(auth.uid(), 'cfo')
    or public.has_role(auth.uid(), 'operations')
  );

create or replace function public.trg_log_gmail_deposit_exclusion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text := null;
begin
  if new.parsed is not true or new.linked_deposit_request_id is not null then
    return new;
  end if;

  if new.direction = 'out' then
    v_reason := 'outgoing_money_sent';
  elsif new.direction = 'charge' then
    v_reason := 'fee_or_charge_email';
  elsif new.direction is null then
    v_reason := 'unknown_direction';
  elsif new.amount is null or new.amount <= 0 then
    v_reason := 'no_amount';
  elsif new.transaction_id is null or length(trim(new.transaction_id)) = 0 then
    v_reason := 'no_transaction_id';
  end if;

  if v_reason is null then
    return new;
  end if;

  insert into public.gmail_deposit_exclusions(
    gmail_transaction_id, gmail_message_id, reason, direction,
    amount, transaction_id, from_email, subject, snippet, internal_date
  ) values (
    new.id, new.gmail_message_id, v_reason, new.direction,
    new.amount, new.transaction_id, new.from_email,
    new.subject, new.snippet, new.internal_date
  );

  return new;
end;
$$;

drop trigger if exists trg_log_gmail_deposit_exclusion on public.gmail_transactions;
create trigger trg_log_gmail_deposit_exclusion
  after insert on public.gmail_transactions
  for each row execute function public.trg_log_gmail_deposit_exclusion();

insert into public.gmail_deposit_exclusions(
  gmail_transaction_id, gmail_message_id, reason, direction,
  amount, transaction_id, from_email, subject, snippet, internal_date
)
select g.id, g.gmail_message_id,
       case
         when g.direction = 'out' then 'outgoing_money_sent'
         when g.direction = 'charge' then 'fee_or_charge_email'
         when g.direction is null then 'unknown_direction'
         when g.amount is null or g.amount <= 0 then 'no_amount'
         when g.transaction_id is null or length(trim(g.transaction_id)) = 0 then 'no_transaction_id'
       end,
       g.direction, g.amount, g.transaction_id, g.from_email,
       g.subject, g.snippet, g.internal_date
  from public.gmail_transactions g
  left join public.gmail_deposit_exclusions e on e.gmail_transaction_id = g.id
 where g.parsed = true
   and g.linked_deposit_request_id is null
   and e.id is null
   and (
     g.direction in ('out','charge')
     or g.direction is null
     or g.amount is null or g.amount <= 0
     or g.transaction_id is null or length(trim(g.transaction_id)) = 0
   );