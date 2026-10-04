do $mig$
declare
  v_name text;
  v_def text;
  v_new text;
begin
  foreach v_name in array array['tppo_period_plan_detail','tppo_arrears_movement','tppo_plan_arrears_detail']
  loop
    select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_name
    limit 1;

    if v_def is null then
      raise exception 'function %s not found', v_name;
    end if;

    v_new := v_def;
    v_new := replace(v_new,
      'where ac.rent_request_id is not null',
      'where ac.rent_request_id is not null and ac.reversed_at is null');
    v_new := replace(v_new,
      'where ac.rent_request_id = p_rent_request_id',
      'where ac.rent_request_id = p_rent_request_id and ac.reversed_at is null');
    v_new := replace(v_new,
      'where a.rent_request_id = rp.rent_request_id',
      'where a.reversed_at is null and a.rent_request_id = rp.rent_request_id');

    if v_new = v_def then
      raise exception 'no reversed_at guard applied to %', v_name;
    end if;

    execute v_new;
  end loop;
end
$mig$;