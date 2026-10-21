-- Applied directly 2026-10-21 (migration tool fails with 42P10). Shared R&D cash-position table.
create table if not exists public.rd_cash_position (key text primary key, rows jsonb not null default '[]'::jsonb, updated_at timestamptz not null default now(), updated_by uuid);
grant select, insert, update on public.rd_cash_position to authenticated;
grant all on public.rd_cash_position to service_role;
alter table public.rd_cash_position enable row level security;
create policy "rd staff read cash position" on public.rd_cash_position for select to authenticated using (public._has_enabled_role(auth.uid(), array['rd','super_admin','cto','ceo','employee']));
create policy "rd staff add cash position" on public.rd_cash_position for insert to authenticated with check (updated_by = auth.uid() and public._has_enabled_role(auth.uid(), array['rd','super_admin','cto','ceo','employee']));
create policy "rd staff edit cash position" on public.rd_cash_position for update to authenticated using (public._has_enabled_role(auth.uid(), array['rd','super_admin','cto','ceo','employee'])) with check (updated_by = auth.uid() and public._has_enabled_role(auth.uid(), array['rd','super_admin','cto','ceo','employee']));
