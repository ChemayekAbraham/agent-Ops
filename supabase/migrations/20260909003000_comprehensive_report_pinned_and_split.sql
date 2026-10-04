-- Agent Ops Comprehensive Report: pinned expected, and success measured on
-- money against the window's bill.
--
-- The report was the last agent-ops surface still on its own basis. It carried
-- two divergences at once:
--
--   * expected came from `plan_accrual` — daily_repayment x days in window,
--     re-derived live from rent_requests. For 2026-09-08 that read 5,295,837
--     against the pinned schedule's 3,673,184: 44% high, and moving, because a
--     live re-derivation picks up plans funded after the day began. Last week's
--     20260908220000 moved the other reports onto the pins; this one was missed.
--   * collected was every shilling received in the window, so `success_rate`
--     and `missed` counted tenants clearing older bills as attainment on a bill
--     that never included them.
--
-- After this patch, for 2026-09-08: expected 3,673,184, collected 3,492,483 of
-- which 1,599,261 against the window's bill and 1,893,222 arrears. Mean agent
-- success rate lands at 36.3% instead of roughly double that.
--
-- Why this is a patch and not a full CREATE OR REPLACE
-- ----------------------------------------------------
-- The function is ~12k characters covering rent, advances, service centres,
-- products and performance. Retyping all of it to change seven fragments risks
-- a silent typo in a section nobody is looking at. This rewrites the stored
-- source in place instead: each replace is guarded and RAISEs if its snippet is
-- absent, so the migration fails loudly rather than half-applying. Signature,
-- LANGUAGE, volatility, SECURITY DEFINER and search_path are re-declared
-- identically.
--
-- Rerunning after the patch is applied fails on snippet 1 by design — the
-- snippets are the pre-patch text.
--
-- Keys added to `rent`: collected_on_schedule, collected_arrears,
-- expected_basis, rate_basis. Per agent: collected_on_schedule,
-- collected_arrears. `collected` still means total cash everywhere.
--
-- Note on attribution, unchanged by this patch: this report credits a
-- collection to COALESCE(assigned_agent_id, agent_id) via plan_accrual, while
-- the pinned bill is keyed on v_rent_plan_schedule.agent_id, which is plain
-- rent_requests.agent_id. Where a plan has been reassigned, expected and
-- collected can therefore sit with different agents. That predates this change
-- and is worth settling separately.

do $patch$
declare v_src text; v_new text; v_prev text;
begin
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='get_agent_ops_comprehensive_report';
  if v_src is null then raise exception 'get_agent_ops_comprehensive_report not found'; end if;
  v_new := v_src;

  -- 1. flag each collection with whether the window's pinned bill covers its plan
  v_prev := v_new;
  v_new := replace(v_new,
$o1$     (ac.created_at AT TIME ZONE 'Africa/Kampala')::date report_day
   FROM public.agent_collections ac$o1$,
$n1$     (ac.created_at AT TIME ZONE 'Africa/Kampala')::date report_day,
     EXISTS(SELECT 1 FROM public.agent_expected_day_plans b WHERE b.rent_request_id=ac.rent_request_id AND b.day BETWEEN v_from AND v_to) on_schedule
   FROM public.agent_collections ac$n1$);
  if v_new = v_prev then raise exception 'snippet 1 (collections) not found'; end if;

  -- 2. per-agent collected split
  v_prev := v_new;
  v_new := replace(v_new,
$o2$   SELECT agent_id,sum(amount)::numeric collected,count(DISTINCT tenant_id)::integer tenants_paid FROM collections GROUP BY agent_id$o2$,
$n2$   SELECT agent_id,sum(amount)::numeric collected,COALESCE(sum(amount) FILTER (WHERE on_schedule),0)::numeric collected_on_schedule,count(DISTINCT tenant_id)::integer tenants_paid FROM collections GROUP BY agent_id$n2$);
  if v_new = v_prev then raise exception 'snippet 2 (agent_collection_agg) not found'; end if;

  -- 3. per-agent expected from the pinned bill instead of live daily accrual
  v_prev := v_new;
  v_new := replace(v_new,
$o3$   SELECT agent_id,sum(expected)::numeric expected,count(DISTINCT tenant_id)::integer active_tenants FROM plan_accrual GROUP BY agent_id$o3$,
$n3$   SELECT b.agent_id,sum(b.expected_ugx)::numeric expected,count(DISTINCT b.tenant_id)::integer active_tenants FROM public.agent_expected_day_plans b WHERE b.day BETWEEN v_from AND v_to AND b.agent_id IS NOT NULL GROUP BY b.agent_id$n3$);
  if v_new = v_prev then raise exception 'snippet 3 (agent_plan_agg) not found'; end if;

  -- 4. missed / over-collected measured against on-schedule money
  v_prev := v_new;
  v_new := replace(v_new,
$o4$     COALESCE(a.expected,0)::numeric expected,GREATEST(COALESCE(a.expected,0)-COALESCE(c.collected,0),0)::numeric missed,
     GREATEST(COALESCE(c.collected,0)-COALESCE(a.expected,0),0)::numeric over_collected,$o4$,
$n4$     COALESCE(c.collected_on_schedule,0)::numeric collected_on_schedule,
     GREATEST(COALESCE(c.collected,0)-COALESCE(c.collected_on_schedule,0),0)::numeric collected_arrears,
     COALESCE(a.expected,0)::numeric expected,GREATEST(COALESCE(a.expected,0)-COALESCE(c.collected_on_schedule,0),0)::numeric missed,
     GREATEST(COALESCE(c.collected_on_schedule,0)-COALESCE(a.expected,0),0)::numeric over_collected,$n4$);
  if v_new = v_prev then raise exception 'snippet 4 (missed/over_collected) not found'; end if;

  -- 5. success rate on the same basis
  v_prev := v_new;
  v_new := replace(v_new,
$o5$CASE WHEN COALESCE(a.expected,0)>0 THEN round(COALESCE(c.collected,0)/a.expected*100,1) ELSE NULL END success_rate$o5$,
$n5$CASE WHEN COALESCE(a.expected,0)>0 THEN round(COALESCE(c.collected_on_schedule,0)/a.expected*100,1) ELSE NULL END success_rate$n5$);
  if v_new = v_prev then raise exception 'snippet 5 (success_rate) not found'; end if;

  -- 6. daily expected series from the pins
  v_prev := v_new;
  v_new := replace(v_new,
$o6$COALESCE((SELECT sum(pa.daily_repayment) FROM plan_accrual pa WHERE d::date BETWEEN pa.w_from AND pa.w_to),0)::numeric expected$o6$,
$n6$COALESCE((SELECT sum(b.expected_ugx) FROM public.agent_expected_day_plans b WHERE b.day=d::date),0)::numeric expected$n6$);
  if v_new = v_prev then raise exception 'snippet 6 (rent_daily) not found'; end if;

  -- 7. window totals
  v_prev := v_new;
  v_new := replace(v_new,
$o7$'rent',jsonb_build_object('collected',(SELECT COALESCE(sum(amount),0) FROM collections),'expected',(SELECT COALESCE(sum(expected),0) FROM plan_accrual),'missed',GREATEST((SELECT COALESCE(sum(expected),0) FROM plan_accrual)-(SELECT COALESCE(sum(amount),0) FROM collections),0),$o7$,
$n7$'rent',jsonb_build_object('collected',(SELECT COALESCE(sum(amount),0) FROM collections),'collected_on_schedule',(SELECT COALESCE(sum(amount) FILTER (WHERE on_schedule),0) FROM collections),'collected_arrears',(SELECT COALESCE(sum(amount) FILTER (WHERE NOT on_schedule),0) FROM collections),'expected',(SELECT COALESCE(sum(b.expected_ugx),0) FROM public.agent_expected_day_plans b WHERE b.day BETWEEN v_from AND v_to),'expected_basis','pinned_schedule','rate_basis','on_schedule_uncapped','missed',GREATEST((SELECT COALESCE(sum(b.expected_ugx),0) FROM public.agent_expected_day_plans b WHERE b.day BETWEEN v_from AND v_to)-(SELECT COALESCE(sum(amount) FILTER (WHERE on_schedule),0) FROM collections),0),$n7$);
  if v_new = v_prev then raise exception 'snippet 7 (rent totals) not found'; end if;

  execute format(
    'create or replace function public.get_agent_ops_comprehensive_report(p_from date, p_to date) returns jsonb language plpgsql stable security definer set search_path=public as %L',
    v_new);
end
$patch$;
