-- Add classification columns to gmail_transactions for richer parsing
alter table public.gmail_transactions
  add column if not exists direction text,        -- 'in' | 'out' | 'charge' | null
  add column if not exists channel text,          -- 'mtn_momo' | 'airtel_money' | 'bank' | 'other' | null
  add column if not exists counterparty text,     -- name or phone of the other party
  add column if not exists fee numeric,           -- transaction fee in UGX
  add column if not exists balance numeric;       -- post-tx balance in UGX

create index if not exists gmail_transactions_direction_idx on public.gmail_transactions (direction);
create index if not exists gmail_transactions_channel_idx on public.gmail_transactions (channel);
