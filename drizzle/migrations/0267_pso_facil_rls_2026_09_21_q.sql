-- =====================================================================
-- PSO-FACIL-RLS-2026-09-21-Q
-- Let the signed-in user write facilitation and loan rows.
-- =====================================================================

drop policy if exists staff_requisitions_gated_insert on public.staff_requisitions;
drop policy if exists staff_requisitions_gated_decide on public.staff_requisitions;

create policy staff_requisitions_gated_insert
  on public.staff_requisitions
  for insert to authenticated
  with check (
    requester_id = auth.uid()
    and coalesce(request_kind,'requisition') in ('facilitation','staff_loan')
  );

create policy staff_requisitions_gated_decide
  on public.staff_requisitions
  for update to authenticated
  using (
    coalesce(request_kind,'requisition') in ('facilitation','staff_loan')
    and (
      exists (select 1 from public.pso_facilitation_approvers a
               where a.user_id = auth.uid() and a.enabled)
      or exists (select 1 from public.pso_facilitation_disbursers d
                  where d.user_id = auth.uid() and d.enabled)
      or public.has_role(auth.uid(),'hr'::app_role)
      or public.has_role(auth.uid(),'ceo'::app_role)
      or public.has_role(auth.uid(),'cfo'::app_role)
    )
  )
  with check (
    coalesce(request_kind,'requisition') in ('facilitation','staff_loan')
    and (
      exists (select 1 from public.pso_facilitation_approvers a
               where a.user_id = auth.uid() and a.enabled)
      or exists (select 1 from public.pso_facilitation_disbursers d
                  where d.user_id = auth.uid() and d.enabled)
      or public.has_role(auth.uid(),'hr'::app_role)
      or public.has_role(auth.uid(),'ceo'::app_role)
      or public.has_role(auth.uid(),'cfo'::app_role)
    )
  );

do $$
declare v_ins integer; v_upd integer; v_sel integer; v_def text;
begin
  select count(*) into v_sel from pg_policies
   where schemaname='public' and tablename='staff_requisitions' and cmd='SELECT';
  if v_sel <> 2 then raise exception 'FAIL A: SELECT policies changed (% found, expected 2)', v_sel; end if;

  select count(*) into v_ins from pg_policies
   where schemaname='public' and tablename='staff_requisitions' and cmd='INSERT';
  if v_ins <> 1 then raise exception 'FAIL B: % INSERT policies, expected 1', v_ins; end if;

  select count(*) into v_upd from pg_policies
   where schemaname='public' and tablename='staff_requisitions' and cmd='UPDATE';
  if v_upd <> 1 then raise exception 'FAIL C: % UPDATE policies, expected 1', v_upd; end if;

  select with_check into v_def from pg_policies
   where schemaname='public' and tablename='staff_requisitions'
     and policyname='staff_requisitions_gated_insert';
  if v_def not like '%facilitation%' or v_def not like '%staff_loan%' then
    raise exception 'FAIL D: insert policy is not limited to facilitation and staff_loan';
  end if;

  if not exists (select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid
                  where c.relname='staff_requisitions' and t.tgname='pso_facilitation_guard_trg')
  or not exists (select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid
                  where c.relname='staff_requisitions' and t.tgname='staff_loan_chain_guard_trg') then
    raise exception 'FAIL E: a guard trigger is missing — the policies must never stand alone';
  end if;

  if (select count(*) from public.staff_requisitions) <> 96 then
    raise exception 'FAIL F: requisition rows changed';
  end if;

  raise notice 'PSO-FACIL-RLS-2026-09-21-Q PASSED — facilitation and loan writes open to signed-in users, guards intact';
end $$;

-- =====================================================================
-- END PSO-FACIL-RLS-2026-09-21-Q
-- =====================================================================