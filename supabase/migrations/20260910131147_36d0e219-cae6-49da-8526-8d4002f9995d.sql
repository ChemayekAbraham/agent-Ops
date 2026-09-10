do $migration$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(p.oid)
    into v_def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'tppo_freeze_period'
    and pg_get_function_identity_arguments(p.oid) = 'p_granularity text, p_anchor date, p_finalise boolean'
  limit 1;

  if v_def is null then
    raise exception 'tppo_freeze_period(text,date,boolean) not found';
  end if;

  if position('ac.reversed_at is null' in v_def) > 0 then
    raise exception 'tppo_freeze_period already contains a reversed-submission guard; review before changing';
  end if;

  v_new := replace(
    v_def,
    'where ac.rent_request_id = s.rent_request_id',
    'where ac.rent_request_id = s.rent_request_id
                 and ac.reversed_at is null'
  );

  v_new := replace(
    v_new,
    'from public.agent_collections ac
    where (ac.created_at at time zone ''Africa/Kampala'')::date between v_start and v_end',
    'from public.agent_collections ac
    where ac.reversed_at is null
      and (ac.created_at at time zone ''Africa/Kampala'')::date between v_start and v_end'
  );

  if v_new = v_def then
    raise exception 'no tppo_freeze_period collection source was changed';
  end if;

  execute v_new;
end
$migration$;