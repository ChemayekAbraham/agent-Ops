-- Stop the Postgres 42501 flood on staff prompt / notice RPCs.
--
-- Unauthenticated PostgREST calls (login role authenticator, session role
-- anon) hit these functions on every public page load. EXECUTE was granted
-- to authenticated and service_role only, so Postgres logged
-- "permission denied for function …" (sqlstate 42501) before the body ran.
--
-- Each function is zero-argument, STABLE, SECURITY DEFINER, search_path =
-- public, and returns rows only for the caller:
--   hr_pay_pending_prompt()              approver_id = auth.uid()
--   pso_facilitation_pending_prompt()    approver_id = auth.uid()
--   staff_loan_pending_prompt()          approver_id = auth.uid()
--   staff_requisition_pending_prompt()   approver_id = auth.uid()
--   staff_requisition_my_notices()       recipient_id = auth.uid()
--   staff_survey_pending()               auth.uid() is not null
--                                        AND staff_survey_is_employee()
--                                        AND an active hr_staff row for that uid
-- auth.uid() reads the request JWT sub, not the function owner. With no
-- subject the comparison is null and the result is empty. Verified on
-- byrzshwlentqvktcksem with auth.uid() null: all six returned 0 rows and
-- did not raise.
--
-- GRANT is idempotent. The preflight refuses the grant if a signature or
-- the caller filter is no longer the one reviewed above.
--
-- Not granted: get_cto_controlled_plan_collections(). It raises 42501 itself
-- when the caller is missing or not cto/ceo/cfo, so anon EXECUTE would
-- replace permission-denied with a raised exception.

do $grant$
declare
  r record;
  def text;
  norm text;
  nfuncs integer;
begin
  for r in
    select *
    from (values
      ('hr_pay_pending_prompt', 'pr.approver_id = auth.uid()'),
      ('pso_facilitation_pending_prompt', 'pr.approver_id = auth.uid()'),
      ('staff_loan_pending_prompt', 'pr.approver_id = auth.uid()'),
      ('staff_requisition_pending_prompt', 'p.approver_id = auth.uid()'),
      ('staff_requisition_my_notices', 'n.recipient_id = auth.uid()'),
      ('staff_survey_pending', 'auth.uid() is not null')
    ) as v(name, needle)
  loop
    select count(*)
      into nfuncs
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = r.name;

    if nfuncs <> 1 then
      raise exception '% has % overloads in public; expected one zero-arg function — refusing anon grant', r.name, nfuncs;
    end if;

    select pg_get_functiondef(p.oid)
      into def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = r.name
      and pg_get_function_identity_arguments(p.oid) = ''
      and p.prosecdef
      and p.provolatile = 's';

    if def is null then
      raise exception '%() is missing, is not zero-arg, or is not stable security definer — refusing anon grant', r.name;
    end if;

    norm := lower(regexp_replace(def, '\s+', ' ', 'g'));
    if position(r.needle in norm) = 0 then
      raise exception '%() no longer contains the caller filter (%) — refusing anon grant', r.name, r.needle;
    end if;

    if r.name = 'staff_survey_pending' then
      if position('staff_survey_is_employee()' in norm) = 0
         or position('h.user_id = auth.uid()' in norm) = 0 then
        raise exception 'staff_survey_pending() no longer requires a signed-in active employee — refusing anon grant';
      end if;
    end if;
  end loop;
end
$grant$;

grant execute on function public.hr_pay_pending_prompt() to anon;
grant execute on function public.pso_facilitation_pending_prompt() to anon;
grant execute on function public.staff_loan_pending_prompt() to anon;
grant execute on function public.staff_requisition_pending_prompt() to anon;
grant execute on function public.staff_requisition_my_notices() to anon;
grant execute on function public.staff_survey_pending() to anon;
