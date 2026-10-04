
create table if not exists public.gmail_transactions (
  id uuid primary key default gen_random_uuid(),
  gmail_message_id text not null unique,
  gmail_thread_id text,
  from_email text,
  from_name text,
  subject text,
  snippet text,
  raw_body text,
  amount numeric,
  transaction_id text,
  tx_date date,
  tx_time text,
  parsed boolean not null default false,
  internal_date timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_gmail_tx_internal_date on public.gmail_transactions (internal_date desc);
create index if not exists idx_gmail_tx_amount on public.gmail_transactions (amount) where amount is not null;

create table if not exists public.gmail_poll_state (
  id int primary key default 1,
  last_internal_date_ms bigint,
  last_polled_at timestamptz,
  last_status text,
  last_error text,
  constraint gmail_poll_state_singleton check (id = 1)
);
insert into public.gmail_poll_state (id) values (1) on conflict do nothing;

alter table public.gmail_transactions enable row level security;
alter table public.gmail_poll_state enable row level security;

create policy "staff can read gmail_transactions"
  on public.gmail_transactions for select
  to authenticated
  using (
    public.has_role(auth.uid(), 'manager')
    or public.has_role(auth.uid(), 'super_admin')
    or public.has_role(auth.uid(), 'cfo')
    or public.has_role(auth.uid(), 'coo')
  );

create policy "staff can read gmail_poll_state"
  on public.gmail_poll_state for select
  to authenticated
  using (
    public.has_role(auth.uid(), 'manager')
    or public.has_role(auth.uid(), 'super_admin')
    or public.has_role(auth.uid(), 'cfo')
    or public.has_role(auth.uid(), 'coo')
  );

alter publication supabase_realtime add table public.gmail_transactions;
