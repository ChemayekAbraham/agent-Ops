-- =====================================================================
-- PSO-FACIL-DISBURSER-FIX-2026-09-21-W
-- The facilitation disburser was seeded as EMP-00006, whose Chief Finance
-- Officer assignment ended 2026-08-27. Correct it to whoever currently
-- holds that position. Derived from hr_assignments, not typed in, so it
-- cannot be a guess.
-- The old row is disabled rather than deleted, to keep the record.
-- =====================================================================

update public.pso_facilitation_disbursers
   set enabled = false,
       note = coalesce(note,'') || ' | Disabled 2026-09-21: no longer holds the Chief Finance Officer position.'
 where enabled
   and user_id not in (
     select s.user_id
       from public.hr_staff s
       join public.hr_assignments a on a.staff_id = s.id and a.ended_on is null
       join public.hr_positions p on p.id = a.position_id
      where p.key = 'chief_finance_officer'
        and s.active and s.ended_on is null and s.user_id is not null
   );

insert into public.pso_facilitation_disbursers (user_id, enabled, note)
select s.user_id, true,
       'Seeded 2026-09-21 from the live Chief Finance Officer assignment.'
  from public.hr_staff s
  join public.hr_assignments a on a.staff_id = s.id and a.ended_on is null
  join public.hr_positions p on p.id = a.position_id
 where p.key = 'chief_finance_officer'
   and s.active and s.ended_on is null and s.user_id is not null
on conflict (user_id) do update
   set enabled = true,
       note = 'Re-enabled 2026-09-21 from the live Chief Finance Officer assignment.';

do $$
declare v_n integer; v_ref text; v_cur text;
begin
  select count(*) into v_n from public.pso_facilitation_disbursers where enabled;
  if v_n <> 1 then raise exception 'FAIL A: % enabled disbursers, expected exactly 1', v_n; end if;

  select s.staff_ref into v_ref
    from public.pso_facilitation_disbursers d
    join public.hr_staff s on s.user_id = d.user_id
   where d.enabled;

  select s.staff_ref into v_cur
    from public.hr_staff s
    join public.hr_assignments a on a.staff_id = s.id and a.ended_on is null
    join public.hr_positions p on p.id = a.position_id
   where p.key = 'chief_finance_officer' and s.active and s.ended_on is null;

  if v_ref is distinct from v_cur then
    raise exception 'FAIL B: disburser is % but the serving CFO is %', coalesce(v_ref,'none'), coalesce(v_cur,'none');
  end if;

  if (select count(*) from public.pso_facilitation_approvers where enabled) <> 1 then
    raise exception 'FAIL C: the approver allowlist changed';
  end if;

  raise notice 'PSO-FACIL-DISBURSER-FIX-2026-09-21-W PASSED — disburser is now %, the serving Chief Finance Officer', v_ref;
end $$;

-- =====================================================================
-- END PSO-FACIL-DISBURSER-FIX-2026-09-21-W
-- =====================================================================
