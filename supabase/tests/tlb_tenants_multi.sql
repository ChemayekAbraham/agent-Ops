-- Tenant Locations multi-select + PDF export audit. Read-only: the DO block ends by
-- raising an exception, so nothing it does (including the audit row) is kept.
-- Every value reported must be true (timings are informational, target < 1500 ms).
SELECT p.proname,
 p.prosecdef AND p.proconfig @> ARRAY['search_path=public'] AS definer_scoped,
 CASE p.proname WHEN 'tlb_tenants_multi' THEN p.provolatile = 's' ELSE p.provolatile = 'v' END AS volatility,
 NOT has_function_privilege('anon', p.oid, 'EXECUTE') AS anonymous_denied,
 has_function_privilege('authenticated', p.oid, 'EXECUTE') AS signed_in_entry,
 position('tlb_authorized()' IN p.prosrc) > 0 AS same_access_check
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('tlb_tenants_multi', 'tlb_log_location_pdf_export');

DO $test$
DECLARE
  mgr uuid; tnt uuid; d_id int; v_id int; v_cnt bigint; d_total bigint;
  paths jsonb; vlist jsonb; dlist jsonb; res jsonb := '{}'::jsonb;
  rows_n int; dist_n int; tot bigint; n_v int; n_d int; bad int; aid uuid; t0 timestamptz;
BEGIN
  SELECT user_id INTO mgr FROM public.user_roles WHERE role = 'manager' LIMIT 1;
  SELECT user_id INTO tnt FROM public.user_roles r WHERE r.role = 'tenant'
    AND NOT EXISTS (SELECT 1 FROM public.user_roles o WHERE o.user_id = r.user_id AND o.role <> 'tenant') LIMIT 1;
  SELECT b.village_id, b.district_id, count(*) INTO v_id, d_id, v_cnt FROM public.v_tlb_tenant_base b
   WHERE b.village_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) >= 3 ORDER BY count(*) DESC LIMIT 1;
  SELECT count(*) INTO d_total FROM public.v_tlb_tenant_base WHERE district_id = d_id;
  SELECT jsonb_build_array(jsonb_build_object('district_id', d_id),
    jsonb_build_object('village_id', v_id, 'district_id', d_id, 'parish_id', b.parish_id,
                       'subcounty_id', b.subcounty_id, 'county_id', b.county_id))
    INTO paths FROM public.v_tlb_tenant_base b WHERE b.village_id = v_id LIMIT 1;
  SELECT jsonb_agg(jsonb_build_object('village_id', x.village_id, 'parish_id', x.parish_id,
         'subcounty_id', x.subcounty_id, 'county_id', x.county_id, 'district_id', x.district_id)) INTO vlist
    FROM (SELECT b.village_id, b.parish_id, b.subcounty_id, b.county_id, b.district_id FROM public.v_tlb_tenant_base b
          WHERE b.village_id IS NOT NULL GROUP BY 1, 2, 3, 4, 5 ORDER BY count(*) DESC LIMIT 4) x;
  SELECT jsonb_agg(jsonb_build_object('district_id', x.district_id)) INTO dlist
    FROM (SELECT district_id FROM public.v_tlb_tenant_base WHERE district_id IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 3) x;

  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', mgr, 'role', 'authenticated')::text, true);

  -- A district and a village inside it: each tenant once, credited to the village first.
  SELECT count(*), count(DISTINCT tenant_id), max(total_count),
         count(*) FILTER (WHERE matched_path_index = 1), count(*) FILTER (WHERE matched_path_index = 0)
    INTO rows_n, dist_n, tot, n_v, n_d FROM public.tlb_tenants_multi(paths, 'all', 5000);
  res := res || jsonb_build_object('overlap_each_tenant_once', rows_n = dist_n AND tot = rows_n AND rows_n = d_total,
    'overlap_most_specific_wins', n_v = v_cnt AND n_d = d_total - v_cnt);
  SELECT count(*) FILTER (WHERE NOT is_active) INTO bad FROM public.tlb_tenants_multi(paths, 'active', 5000);
  res := res || jsonb_build_object('active_filter', bad = 0);
  SELECT count(*) FILTER (WHERE is_active) INTO bad FROM public.tlb_tenants_multi(paths, 'inactive', 5000);
  res := res || jsonb_build_object('inactive_filter', bad = 0);
  SELECT count(*), max(total_count) INTO rows_n, tot FROM public.tlb_tenants_multi(paths, 'all', 1);
  res := res || jsonb_build_object('limit_respected_total_still_reported', rows_n = 1 AND tot = d_total);

  t0 := clock_timestamp(); PERFORM count(*) FROM public.tlb_tenants_multi(vlist, 'all', 5000);
  res := res || jsonb_build_object('ms_4_villages', round(extract(epoch FROM clock_timestamp() - t0) * 1000));
  t0 := clock_timestamp(); PERFORM count(*) FROM public.tlb_tenants_multi(dlist, 'all', 5000);
  res := res || jsonb_build_object('ms_3_districts', round(extract(epoch FROM clock_timestamp() - t0) * 1000));

  BEGIN PERFORM * FROM public.tlb_tenants_multi('[]'::jsonb); res := res || '{"empty_rejected": false}';
  EXCEPTION WHEN OTHERS THEN res := res || '{"empty_rejected": true}'; END;
  BEGIN PERFORM public.tlb_log_location_pdf_export('short', 1, 1, 'all'); res := res || '{"short_reason_rejected": false}';
  EXCEPTION WHEN OTHERS THEN res := res || '{"short_reason_rejected": true}'; END;
  aid := public.tlb_log_location_pdf_export('Ops follow up call list for selected villages', 2, 10, 'all', ARRAY['A', 'B']);
  res := res || jsonb_build_object('audit_row_written', EXISTS (SELECT 1 FROM public.audit_logs
    WHERE id = aid AND action_type = 'tenant_location_pdf_export' AND char_length(reason) >= 10));

  PERFORM set_config('request.jwt.claims', json_build_object('sub', tnt, 'role', 'authenticated')::text, true);
  BEGIN PERFORM * FROM public.tlb_tenants_multi(paths, 'all'); res := res || '{"non_staff_denied": false}';
  EXCEPTION WHEN OTHERS THEN res := res || '{"non_staff_denied": true}'; END;
  BEGIN PERFORM public.tlb_log_location_pdf_export('Ops follow up call list for selected villages', 2, 10, 'all');
    res := res || '{"non_staff_audit_denied": false}';
  EXCEPTION WHEN OTHERS THEN res := res || '{"non_staff_audit_denied": true}'; END;

  RAISE EXCEPTION 'RESULT %', res::text;
END
$test$;
