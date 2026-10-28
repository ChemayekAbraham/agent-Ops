-- 2026-10-28: public.agent_ops_report_agent(uuid,date,date) (Agent Ops per-agent report) failed on every call: ERROR 'missing FROM-clause entry for table "tp"' (25/day, ongoing).
-- Two defects in the live function, patched in place with replace() on its own definition so nothing else changes:
--  1. The tenants subquery selects tp.full_name, tp.phone, tp.national_id, ... but never joined public.profiles tp. Added: LEFT JOIN public.profiles tp ON tp.id = pl.tenant_id.
--  2. The KPI statement read the CTEs `bill` and `coll_raw`, which only exist inside the earlier statement ("relation bill does not exist" once defect 1 was fixed).
--     collected_window is now computed from self-contained subqueries with the same logic.
-- Tested 2026-10-28 as the busiest agent: 37 tenants returned with name/location/ids, KPIs present. Applied to production by hand. Safe to re-run (no-op once patched: raises, which is fine).
do $$ declare d text; n text;
begin
  d := pg_get_functiondef('public.agent_ops_report_agent(uuid,date,date)'::regprocedure);
  n := replace(d, E'    FROM plans pl\n    LEFT JOIN bill b ON b.rent_request_id = pl.id', E'    FROM plans pl\n    LEFT JOIN public.profiles tp ON tp.id = pl.tenant_id\n    LEFT JOIN bill b ON b.rent_request_id = pl.id');
  if n = d then raise notice 'defect 1 already patched'; else execute n; end if;
end $$;

do $$ declare d text; n text; old_t text; new_t text;
begin
  d := pg_get_functiondef('public.agent_ops_report_agent(uuid,date,date)'::regprocedure);
  old_t := E'(SELECT COALESCE(SUM(LEAST(COALESCE(c.paid, 0), b.expected_window)),0)\n       FROM bill b LEFT JOIN coll_raw c ON c.rent_request_id = b.rent_request_id) AS collected_window,';
  new_t := $q$(SELECT COALESCE(SUM(LEAST(COALESCE(c.paid, 0), b.expected_window)),0)
       FROM (SELECT p.rent_request_id, sum(p.expected_ugx)::numeric AS expected_window
               FROM public.agent_expected_day_plans p
              WHERE p.agent_id = p_agent_id AND p.day BETWEEN p_from AND v_asof GROUP BY p.rent_request_id) b
       LEFT JOIN (SELECT ac.rent_request_id, sum(ac.amount)::numeric AS paid
                    FROM public.agent_collections ac
                   WHERE ac.reversed_at IS NULL AND ac.amount > 0
                     AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
                     AND ac.rent_request_id IN (SELECT rr.id FROM public.rent_requests rr WHERE (rr.agent_id = p_agent_id OR rr.assigned_agent_id = p_agent_id) AND rr.status IN ('funded','repaying','completed'))
                   GROUP BY ac.rent_request_id) c ON c.rent_request_id = b.rent_request_id) AS collected_window,$q$;
  n := replace(d, old_t, new_t);
  if n = d then raise notice 'defect 2 already patched'; else execute n; end if;
end $$;
