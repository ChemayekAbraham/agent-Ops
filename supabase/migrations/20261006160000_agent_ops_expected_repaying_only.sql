-- Agent Operations: outstanding and expected count actively repaying plans only.
--
-- Same rule as 20261006140000 applied to the agent-ops surfaces. An agent
-- cannot collect from a plan that is merely `funded` - the landlord may not
-- even be paid - so such a plan must not appear in what the agent or Agent Ops
-- is told to collect.
--
-- Two functions still carried the old four-status net,
-- `status IN ('funded','repaying','disbursed','active')`:
--
--   get_agent_ops_overview
--     * "Pending Collections" tile - whole-book outstanding. Measured today
--       this reads UGX 316,749,843 against 287,866,418 on repaying plans
--       alone: 28,883,425 too high, from 61 plans that are funded, disbursed
--       or active but not repaying. A 9.1% overstatement on the headline tile.
--     * a LEFT JOIN in the trend chart's `expected` CTE. That one is already
--       vestigial - the series reads `agent_expected_day_plans` in an
--       independent subquery and the join contributes nothing but a fan-out
--       that GROUP BY collapses. Changed anyway, because a status list that
--       implies funded plans are expected is exactly what made this confusing.
--
--   get_agent_products_services_report (both overloads)
--     Builds the per-agent rent block - outstanding, daily receivable,
--     amount repaid - that feeds the agent-ops-v2 Comprehensive Report.
--
-- Not changed, because they already read the pinned schedule and the pin
-- carries no funded plans: get_agent_collections_command_center,
-- get_agent_collections_coverage, agent_ops_report_expected and the report
-- RPCs built on it, and get_agent_ops_comprehensive_report.
--
-- Each function is rewritten from its own `pg_get_functiondef`, so the
-- signature, argument defaults, volatility, SECURITY DEFINER setting and
-- search_path are carried over verbatim rather than retyped. The loop raises
-- if any function's text does not contain the clause, so a partial apply fails
-- loudly.

do $patch$
declare
  r record;
  v_def text;
  v_new text;
  v_count int := 0;
begin
  for r in
    select p.oid, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosrc ~ 'status IN \(''funded'',''repaying'',''disbursed'',''active''\)'
     order by p.proname
  loop
    v_def := pg_get_functiondef(r.oid);
    v_new := replace(v_def,
      $$status IN ('funded','repaying','disbursed','active')$$,
      $$status = 'repaying'$$);

    if v_new = v_def then
      raise exception 'clause not found in %', r.proname;
    end if;

    execute v_new;
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception 'no functions matched - already applied, or the clause changed';
  end if;

  raise notice 'rewrote % function(s)', v_count;
end
$patch$;
