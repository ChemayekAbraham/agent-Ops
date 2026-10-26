-- Tests for supabase/migrations/20261026200000_asset_register_stage1.sql and
-- 20261026200100_asset_register_stage1_storage_policies.sql (CFO Asset Register, Stage 1).
-- Run ONLY after both migrations have been applied, in a non-production database (scripts/test-asset-register.mjs
-- runs it in PGlite).
-- Everything runs inside one DO block that always ends by raising the report, so every insert is rolled back.
-- "ROLLED BACK REPORT: N passed of N | failing: none" is success.
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_U uuid;
  v_role text;
  v_ok boolean;
  v_msg text;
  v_state text;
  v_a jsonb;
  v_b jsonb;
  v_res jsonb;
  v_id uuid;
  v_ver timestamptz;
  v_n int;
  v_sha text := repeat('a', 64);
  v_ledger_before bigint;
  v_fails text;
BEGIN
  -- A. Shape and privileges
  r := r || jsonb_build_object('step', 'A all public RPCs are SECURITY DEFINER with search_path = public',
    'pass', (SELECT bool_and(p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])
               FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'asset_register_%'));
  r := r || jsonb_build_object('step', 'A anon cannot execute any asset_register RPC',
    'pass', NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                          AND p.proname LIKE 'asset_register_%' AND has_function_privilege('anon', p.oid, 'EXECUTE')));
  r := r || jsonb_build_object('step', 'A internal helpers are not executable by authenticated',
    'pass', NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                          AND p.proname LIKE '\_asset\_register\_%' AND has_function_privilege('authenticated', p.oid, 'EXECUTE')));
  r := r || jsonb_build_object('step', 'A authenticated has no INSERT/UPDATE/DELETE on the tables',
    'pass', NOT has_table_privilege('authenticated', 'public.assets', 'INSERT')
        AND NOT has_table_privilege('authenticated', 'public.assets', 'UPDATE')
        AND NOT has_table_privilege('authenticated', 'public.assets', 'DELETE')
        AND NOT has_table_privilege('authenticated', 'public.asset_events', 'INSERT')
        AND NOT has_table_privilege('authenticated', 'public.asset_import_batches', 'INSERT'));
  r := r || jsonb_build_object('step', 'A evidence bucket is private',
    'pass', EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'asset-evidence' AND public = false));

  -- B. Role gate: a role-less user is refused; non-writers cannot write
  SELECT p.id INTO v_U FROM public.profiles p
   WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id)
   ORDER BY md5(p.id::text) LIMIT 1;
  r := r || jsonb_build_object('step', 'B found a role-less user', 'pass', v_U IS NOT NULL);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated', 'aal', 'aal2')::text, true);

  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.asset_register_summary();
    RESET ROLE;
    v_ok := false;
  EXCEPTION WHEN others THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    v_ok := v_state = '42501';
  END;
  r := r || jsonb_build_object('step', 'B role-less user is refused with 42501', 'pass', v_ok);

  -- Read access is CFO / Super Admin only until the CFO reviews broader access: COO and CEO are refused.
  INSERT INTO public.user_roles (user_id, role) VALUES (v_U, 'coo'::public.app_role), (v_U, 'ceo'::public.app_role);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.asset_register_summary();
    RESET ROLE;
    v_ok := false;
  EXCEPTION WHEN others THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    v_ok := v_state = '42501';
  END;
  r := r || jsonb_build_object('step', 'B coo/ceo cannot read the register yet (42501)', 'pass', v_ok);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.asset_register_create('{"name":"Test laptop","category":"it_equipment"}'::jsonb);
    RESET ROLE;
    v_ok := false;
  EXCEPTION WHEN others THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    v_ok := v_state = '42501';
  END;
  r := r || jsonb_build_object('step', 'B coo/ceo cannot create assets', 'pass', v_ok);

  INSERT INTO public.user_roles (user_id, role) VALUES (v_U, 'cfo'::public.app_role);
  SELECT count(*) INTO v_ledger_before FROM public.general_ledger;

  -- C. Create: server-generated code, audit event
  SET LOCAL ROLE authenticated;
  v_a := public.asset_register_create(jsonb_build_object(
    'name', 'Test laptop', 'category', 'it_equipment', 'brand', 'Dell', 'model', 'Latitude 5420',
    'serial_number', 'ab-12 cd', 'purchase_date', '2025-01-15', 'purchase_cost', '3500000',
    'location', 'Head office', 'condition', 'good', 'status', 'in_use'));
  RESET ROLE;
  v_id := (v_a->>'id')::uuid;
  v_ver := (v_a->>'updated_at')::timestamptz;
  r := r || jsonb_build_object('step', 'C asset_code is generated as WEL-AST-NNNNNN',
    'pass', (v_a->>'asset_code') ~ '^WEL-AST-[0-9]{6,}$');
  r := r || jsonb_build_object('step', 'C created event recorded',
    'pass', EXISTS (SELECT 1 FROM public.asset_events WHERE asset_id = v_id AND event_type = 'created'));

  -- D. Duplicate serial (normalised) in the same category is rejected
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.asset_register_create('{"name":"Other laptop","category":"it_equipment","serial_number":"AB12CD"}'::jsonb);
    RESET ROLE;
    v_ok := false;
  EXCEPTION WHEN others THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    v_ok := v_state = '23505';
  END;
  r := r || jsonb_build_object('step', 'D duplicate normalised serial in same category rejected (23505)', 'pass', v_ok);

  SET LOCAL ROLE authenticated;
  v_b := public.asset_register_create('{"name":"Desk unit","category":"furniture","serial_number":"AB12CD"}'::jsonb);
  RESET ROLE;
  r := r || jsonb_build_object('step', 'D same serial in another category is allowed', 'pass', v_b ? 'id');

  -- E. Validation errors are 22023
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.asset_register_create('{"name":"X","category":"spaceship","purchase_cost":"-5"}'::jsonb);
    RESET ROLE;
    v_ok := false;
  EXCEPTION WHEN others THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    v_ok := v_state = '22023';
  END;
  r := r || jsonb_build_object('step', 'E invalid row rejected with 22023', 'pass', v_ok);

  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.asset_register_create('{"name":"Laptop","category":"it_equipment","asset_code":"WEL-AST-999999"}'::jsonb);
    RESET ROLE;
    v_ok := false;
  EXCEPTION WHEN others THEN
    RESET ROLE;
    v_ok := true;
  END;
  r := r || jsonb_build_object('step', 'E client-supplied asset_code is refused', 'pass', v_ok);

  -- Scope: out-of-scope categories (smartphones / bikes) are refused; company vehicles are accepted.
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.asset_register_create('{"name":"Staff phone","category":"phones_tablets"}'::jsonb);
    RESET ROLE;
    v_ok := false;
  EXCEPTION WHEN others THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    v_ok := v_state = '22023';
  END;
  r := r || jsonb_build_object('step', 'E out-of-scope category (phones_tablets) rejected with 22023', 'pass', v_ok);
  SET LOCAL ROLE authenticated;
  v_res := public.asset_register_create('{"name":"Pickup truck","category":"company_vehicles","serial_number":"UBA 123X"}'::jsonb);
  RESET ROLE;
  r := r || jsonb_build_object('step', 'E company_vehicles accepted', 'pass', v_res->>'category' = 'company_vehicles');

  -- F. Update: optimistic lock + audit
  SET LOCAL ROLE authenticated;
  v_res := public.asset_register_update(v_id, v_ver, '{"status":"under_repair"}'::jsonb, 'Screen replacement');
  RESET ROLE;
  r := r || jsonb_build_object('step', 'F update applied and recorded with changed fields',
    'pass', v_res->>'status' = 'under_repair'
        AND EXISTS (SELECT 1 FROM public.asset_events WHERE asset_id = v_id AND event_type = 'updated'
                     AND changed_fields = ARRAY['status'] AND old_values->>'status' = 'in_use'));
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.asset_register_update(v_id, v_ver, '{"status":"in_use"}'::jsonb, NULL);
    RESET ROLE;
    v_ok := false;
  EXCEPTION WHEN others THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    v_ok := v_state = '40001';
  END;
  r := r || jsonb_build_object('step', 'F stale version rejected (40001)', 'pass', v_ok);

  -- G. Append-only and no delete
  BEGIN
    UPDATE public.asset_events SET reason = 'tamper' WHERE asset_id = v_id;
    v_ok := false;
  EXCEPTION WHEN others THEN v_ok := true;
  END;
  r := r || jsonb_build_object('step', 'G asset_events cannot be updated (even by owner)', 'pass', v_ok);
  BEGIN
    DELETE FROM public.assets WHERE id = v_id;
    v_ok := false;
  EXCEPTION WHEN others THEN v_ok := true;
  END;
  r := r || jsonb_build_object('step', 'G assets cannot be deleted', 'pass', v_ok);
  BEGIN
    UPDATE public.assets SET asset_code = 'WEL-AST-000000' WHERE id = v_id;
    v_ok := false;
  EXCEPTION WHEN others THEN v_ok := true;
  END;
  r := r || jsonb_build_object('step', 'G asset_code is immutable', 'pass', v_ok);

  -- H. Import: rejected batch inserts nothing; committed batch is all rows; same file cannot be re-committed
  SELECT count(*) INTO v_n FROM public.assets;
  SET LOCAL ROLE authenticated;
  v_res := public.asset_register_import_commit('assets.xlsx', v_sha, jsonb_build_array(
    jsonb_build_object('row_ref', 2, 'name', 'Chair', 'category', 'furniture'),
    jsonb_build_object('row_ref', 3, 'name', 'Printer', 'category', 'office_equipment', 'serial_number', 'S-1'),
    jsonb_build_object('row_ref', 4, 'name', 'Printer 2', 'category', 'office_equipment', 'serial_number', 's1')));
  RESET ROLE;
  r := r || jsonb_build_object('step', 'H in-file duplicate serial rejects the whole batch',
    'pass', v_res->>'status' = 'rejected' AND (SELECT count(*) FROM public.assets) = v_n);

  SET LOCAL ROLE authenticated;
  v_res := public.asset_register_import_commit('assets.xlsx', v_sha, jsonb_build_array(
    jsonb_build_object('row_ref', 2, 'name', 'Chair', 'category', 'furniture'),
    jsonb_build_object('row_ref', 3, 'name', 'Printer', 'category', 'office_equipment', 'serial_number', 'S-1')));
  RESET ROLE;
  r := r || jsonb_build_object('step', 'H valid batch commits every row with imported events',
    'pass', v_res->>'status' = 'committed' AND (SELECT count(*) FROM public.assets) = v_n + 2
        AND (SELECT count(*) FROM public.asset_events WHERE batch_id = (v_res->>'batch_id')::uuid AND event_type = 'imported') = 2);

  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.asset_register_import_commit('assets-copy.xlsx', v_sha, '[{"name":"Lamp","category":"furniture"}]'::jsonb);
    RESET ROLE;
    v_ok := false;
  EXCEPTION WHEN others THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    v_ok := v_state = '23505';
  END;
  r := r || jsonb_build_object('step', 'H the same file cannot be committed twice', 'pass', v_ok);

  -- I. Reads
  SET LOCAL ROLE authenticated;
  v_res := public.asset_register_list('ab12', NULL, NULL, NULL, NULL, 50, 0);
  RESET ROLE;
  r := r || jsonb_build_object('step', 'I list search matches normalised serial', 'pass', (v_res->>'total_count')::int >= 1);
  SET LOCAL ROLE authenticated;
  v_res := public.asset_register_summary();
  RESET ROLE;
  r := r || jsonb_build_object('step', 'I summary returns totals and breakdowns',
    'pass', v_res ? 'total_assets' AND v_res ? 'by_category' AND v_res ? 'register_cost_ugx');

  -- K. Evidence paths: only assets/<this asset id>/<uuid>.<allowed ext>, only an existing private object, never twice.
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.asset_register_add_evidence(v_id, 'evidence', '../' || v_id::text || '/x.pdf');
    RESET ROLE;
    v_ok := false;
  EXCEPTION WHEN others THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    v_ok := v_state = '22023';
  END;
  r := r || jsonb_build_object('step', 'K traversal / malformed evidence path rejected (22023)', 'pass', v_ok);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.asset_register_add_evidence(v_id, 'evidence', 'assets/' || (v_b->>'id') || '/' || gen_random_uuid()::text || '.pdf');
    RESET ROLE;
    v_ok := false;
  EXCEPTION WHEN others THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    v_ok := v_state = '22023';
  END;
  r := r || jsonb_build_object('step', 'K another asset''s folder rejected (22023)', 'pass', v_ok);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.asset_register_add_evidence(v_id, 'evidence', 'assets/' || v_id::text || '/' || gen_random_uuid()::text || '.exe');
    RESET ROLE;
    v_ok := false;
  EXCEPTION WHEN others THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    v_ok := v_state = '22023';
  END;
  r := r || jsonb_build_object('step', 'K disallowed file type rejected (22023)', 'pass', v_ok);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.asset_register_add_evidence(v_id, 'evidence', 'assets/' || v_id::text || '/' || gen_random_uuid()::text || '.pdf');
    RESET ROLE;
    v_ok := false;
  EXCEPTION WHEN others THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    v_ok := v_state = 'P0002';
  END;
  r := r || jsonb_build_object('step', 'K evidence that was never uploaded is rejected (P0002)', 'pass', v_ok);
  v_msg := 'assets/' || v_id::text || '/' || gen_random_uuid()::text || '.pdf';
  INSERT INTO storage.objects (bucket_id, name) VALUES ('asset-evidence', v_msg);
  SET LOCAL ROLE authenticated;
  v_res := public.asset_register_add_evidence(v_id, 'evidence', v_msg);
  RESET ROLE;
  r := r || jsonb_build_object('step', 'K uploaded evidence attaches and records an evidence_added event',
    'pass', v_res->'evidence_paths' ? v_msg
        AND EXISTS (SELECT 1 FROM public.asset_events WHERE asset_id = v_id AND event_type = 'evidence_added' AND new_values->>'path' = v_msg));
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.asset_register_add_evidence(v_id, 'evidence', v_msg);
    RESET ROLE;
    v_ok := false;
  EXCEPTION WHEN others THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    v_ok := v_state = '23505';
  END;
  r := r || jsonb_build_object('step', 'K the same evidence cannot be attached twice (23505)', 'pass', v_ok);

  -- J. No ledger contact
  r := r || jsonb_build_object('step', 'J general_ledger row count unchanged',
    'pass', (SELECT count(*) FROM public.general_ledger) = v_ledger_before);

  SELECT string_agg(x->>'step', ' | ') INTO v_fails FROM jsonb_array_elements(r) x WHERE NOT COALESCE((x->>'pass')::boolean, false);
  RAISE EXCEPTION 'ROLLED BACK REPORT: % passed of % | failing: %',
    (SELECT count(*) FROM jsonb_array_elements(r) x WHERE COALESCE((x->>'pass')::boolean, false)),
    jsonb_array_length(r), COALESCE(v_fails, 'none');
END
$test$;
