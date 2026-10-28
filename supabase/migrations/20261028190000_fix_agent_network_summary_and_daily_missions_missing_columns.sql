-- Two agent-dashboard RPCs referenced columns that do not exist on this database (doc 247 step 49).
-- get_agent_network_summary: staff check used staff_permissions.is_active (no such column), so every
--   staff call for another agent's summary failed; "active" is revoked_at IS NULL.
-- get_agent_daily_missions: counted profiles.monthly_income (no such column), failing every call.
--   No income evidence exists anywhere in this schema, so the salary-proof gap is held at 0 rather
--   than counting every managed user (which would offer a daily 1,000 UGX mission to everyone).
-- Applied to production by hand (dynamic replace, safe to re-run); this file is the record.
do $$
declare d text;
begin
  d := pg_get_functiondef('public.get_agent_network_summary'::regproc);
  if position('COALESCE(is_active, true)' in d) > 0 then
    execute replace(d, 'COALESCE(is_active, true)', 'revoked_at IS NULL');
  end if;

  d := pg_get_functiondef('public.get_agent_daily_missions'::regproc);
  if position('SELECT count(*) INTO v_no_income_count' in d) > 0 then
    execute replace(d,
$a$  SELECT count(*) INTO v_no_income_count
    FROM public.profiles
   WHERE id = ANY(v_managed_ids)
     AND (monthly_income IS NULL OR monthly_income = 0);$a$,
$b$  -- profiles.monthly_income does not exist on this database, so no income evidence can be counted;
  -- the salary-proof mission stays at 0 until that data exists (was an error on every call).
  v_no_income_count := 0;$b$);
  end if;
end $$;
