-- Agent assistant: "how am I doing against my target?"
--
-- Wraps get_my_weekly_performance (the same numbers as /agent/performance and the weekly posting
-- rule) for the signed-in agent only. All arithmetic (percent so far, amount still needed, amount
-- needed per remaining day) is done here so the model never has to calculate money.
--
-- Identity is auth.uid(); there is no agent parameter. Tenant phone numbers and ids that the
-- underlying function returns are dropped: only first-listed tenant names, due and collected.

create or replace function public.assistant_agent_target_progress()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_perf    jsonb;
  v_cur     jsonb;
  v_set     jsonb;
  v_days_left integer;
  v_days_incl integer;
  v_in_due_so_far numeric;  v_in_got numeric;  v_in_proj numeric;  v_in_req numeric;
  v_ex_due_so_far numeric;  v_ex_got numeric;  v_ex_proj numeric;  v_ex_req numeric;
  v_in_need numeric;  v_ex_need numeric;
  v_judged  jsonb;
  v_behind  jsonb;
begin
  perform public.assistant_require_agent();

  v_perf := public.get_my_weekly_performance(2, null);
  v_cur  := v_perf -> 'current_week';
  v_set  := v_perf -> 'settings';

  v_days_left := coalesce((v_cur ->> 'days_left')::integer, 0);
  v_days_incl := v_days_left + 1; -- today still counts: it can still be collected

  v_in_due_so_far := coalesce((v_cur ->> 'in_window_due_so_far')::numeric, 0);
  v_in_got        := coalesce((v_cur ->> 'in_window_collected')::numeric, 0);
  v_in_proj       := coalesce((v_cur ->> 'in_window_projected_due')::numeric, 0);
  -- The rule stores percentages as fractions (0.50 = 50%); everything returned below is in percent.
  v_in_req        := (v_cur ->> 'in_window_required_pct')::numeric;
  v_ex_due_so_far := coalesce((v_cur ->> 'expired_due_so_far')::numeric, 0);
  v_ex_got        := coalesce((v_cur ->> 'expired_collected')::numeric, 0);
  v_ex_proj       := coalesce((v_cur ->> 'expired_projected_due')::numeric, 0);
  v_ex_req        := (v_cur ->> 'expired_required_pct')::numeric;

  v_in_need := case when v_in_req is null then 0
                    else greatest(0, ceil(v_in_proj * v_in_req) - v_in_got) end;
  v_ex_need := case when v_ex_req is null then 0
                    else greatest(0, ceil(v_ex_proj * v_ex_req) - v_ex_got) end;

  -- Last completed week: the one the posting rule judged.
  select w into v_judged
    from jsonb_array_elements(coalesce(v_perf -> 'weeks', '[]'::jsonb)) w
   where (w ->> 'is_judged')::boolean
   limit 1;

  -- The tenants furthest behind this week: names, amounts, no contacts or ids.
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_behind
    from (
      select jsonb_build_object(
               'tenant', coalesce(p ->> 'tenant_name', 'Tenant'),
               'due_so_far', (p ->> 'due_so_far')::numeric,
               'collected', (p ->> 'collected')::numeric,
               'shortfall', (p ->> 'due_so_far')::numeric - (p ->> 'collected')::numeric) as x
        from jsonb_array_elements(coalesce(v_perf -> 'plans', '[]'::jsonb)) p
       where (p ->> 'due_so_far')::numeric > (p ->> 'collected')::numeric
       order by (p ->> 'due_so_far')::numeric - (p ->> 'collected')::numeric desc
       limit 5) s;

  return jsonb_build_object(
    'rule', jsonb_build_object(
      'week', 'Thursday to Wednesday',
      'current_plans_required_percent', (v_set ->> 'in_window_required_pct')::numeric * 100,
      'expired_plans_required_percent', (v_set ->> 'expired_required_pct')::numeric * 100,
      'all_expired_required_percent', (v_set ->> 'all_expired_required_pct')::numeric * 100,
      'enforced', v_set -> 'enforced'),
    'this_week', jsonb_build_object(
      'week_start', v_cur -> 'week_start',
      'week_end', v_cur -> 'week_end',
      'days_left_after_today', v_days_left,
      'days_to_collect_including_today', v_days_incl,
      'book', v_cur -> 'book',
      'current_plans', jsonb_build_object(
        'due_so_far', v_in_due_so_far,
        'collected', v_in_got,
        'percent_so_far', case when v_in_due_so_far > 0 then round(v_in_got * 100 / v_in_due_so_far, 1) end,
        'expected_full_week_due', v_in_proj,
        'required_percent', v_in_req * 100,
        'amount_needed_to_pass', v_in_need,
        'needed_per_day_including_today', case when v_in_need > 0 then ceil(v_in_need / v_days_incl) else 0 end,
        'on_track', v_in_need = 0),
      'expired_plans', jsonb_build_object(
        'due_so_far', v_ex_due_so_far,
        'collected', v_ex_got,
        'percent_so_far', case when v_ex_due_so_far > 0 then round(v_ex_got * 100 / v_ex_due_so_far, 1) end,
        'expected_full_week_due', v_ex_proj,
        'required_percent', v_ex_req * 100,
        'amount_needed_to_pass', v_ex_need,
        'needed_per_day_including_today', case when v_ex_need > 0 then ceil(v_ex_need / v_days_incl) else 0 end,
        'on_track', v_ex_need = 0),
      'note', 'The full-week due is an estimate from today''s bill and the schedule; it can move.'),
    'last_judged_week', case when v_judged is null then null else jsonb_build_object(
      'week_start', v_judged -> 'week_start',
      'week_end', v_judged -> 'week_end',
      'passed', v_judged -> 'passes',
      'current_plans_percent', round((v_judged ->> 'in_window_pct')::numeric * 100, 1),
      'current_plans_required_percent', (v_judged ->> 'in_window_required_pct')::numeric * 100,
      'expired_plans_percent', round((v_judged ->> 'expired_pct')::numeric * 100, 1),
      'expired_plans_required_percent', (v_judged ->> 'expired_required_pct')::numeric * 100) end,
    'tenants_most_behind_this_week', v_behind);
end;
$$;

revoke execute on function public.assistant_agent_target_progress() from public, anon;
grant  execute on function public.assistant_agent_target_progress() to authenticated, service_role;
