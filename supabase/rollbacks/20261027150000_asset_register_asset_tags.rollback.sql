-- Rollback of 20261027150000_asset_register_asset_tags. NOT FOR ROUTINE USE: needs explicit CFO approval.
-- Restores the seven Asset Register functions to their 20261026200000 definitions (verbatim), then drops the asset
-- tag and site columns, the asset_sites table and the tag helpers. Assets, codes, history and evidence are kept.
-- Refuses (changing nothing) while any asset has a tag or a site, unless the operator deliberately discards them:
--   SET LOCAL asset_register.rollback_discard_tags = 'yes';
-- (issued tags may already be printed on labels; discarding them loses the tag column, not the assets.)
-- TRANSACTION: run as ONE transaction (by hand: BEGIN; ... COMMIT;).

SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF to_regclass('public.asset_sites') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'assets'
                     AND column_name = 'asset_tag') THEN
    RAISE EXCEPTION 'precondition failed: the asset tag migration is not applied; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.assets WHERE asset_tag IS NOT NULL OR site_key IS NOT NULL)
     AND COALESCE(current_setting('asset_register.rollback_discard_tags', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'precondition failed: % asset(s) carry a tag or site; set asset_register.rollback_discard_tags = yes to discard them; nothing was changed',
      (SELECT count(*) FROM public.assets WHERE asset_tag IS NOT NULL OR site_key IS NOT NULL);
  END IF;
END
$pre$;

-- ── Original (20261026200000) function definitions ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._asset_register_guard_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.asset_code IS DISTINCT FROM OLD.asset_code
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.import_batch_id IS DISTINCT FROM OLD.import_batch_id THEN
    RAISE EXCEPTION 'ASSET_IDENTITY_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public._asset_register_validate(p jsonb, p_partial boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  e jsonb := '[]'::jsonb;
  v jsonb := '{}'::jsonb;
  k text;
  t text;
  d date;
  n numeric;
  f record;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_allowed text[] := ARRAY['name', 'category', 'brand', 'model', 'serial_number', 'purchase_date', 'supplier',
    'purchase_cost', 'currency', 'invoice_reference', 'department_key', 'location', 'custodian_user_id',
    'custodian_name', 'condition', 'status', 'notes'];
  v_categories text[] := ARRAY['it_equipment', 'furniture', 'office_equipment', 'company_vehicles',
    'machinery', 'other'];
  v_conditions text[] := ARRAY['new', 'good', 'fair', 'poor', 'damaged'];
  v_statuses text[] := ARRAY['in_use', 'in_storage', 'under_repair', 'lost', 'disposed'];
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RETURN jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('field', '_', 'message', 'Asset data must be an object')),
                              'value', '{}'::jsonb);
  END IF;

  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF NOT k = ANY (v_allowed) THEN
      e := e || jsonb_build_object('field', k, 'message', 'Unknown or read-only field');
    END IF;
  END LOOP;

  -- name (required)
  IF NOT p_partial OR p ? 'name' THEN
    t := NULLIF(btrim(p->>'name'), '');
    IF t IS NULL THEN
      e := e || jsonb_build_object('field', 'name', 'message', 'Name is required');
    ELSIF length(t) < 2 OR length(t) > 200 THEN
      e := e || jsonb_build_object('field', 'name', 'message', 'Name must be 2 to 200 characters');
    END IF;
    v := v || jsonb_build_object('name', t);
  END IF;

  -- category (required, fixed list)
  IF NOT p_partial OR p ? 'category' THEN
    t := lower(NULLIF(btrim(p->>'category'), ''));
    IF t IS NULL THEN
      e := e || jsonb_build_object('field', 'category', 'message', 'Category is required');
    ELSIF NOT t = ANY (v_categories) THEN
      e := e || jsonb_build_object('field', 'category', 'message', 'Category is not one of the allowed values');
    END IF;
    v := v || jsonb_build_object('category', t);
  END IF;

  -- condition (defaults to good)
  IF NOT p_partial OR p ? 'condition' THEN
    t := lower(NULLIF(btrim(p->>'condition'), ''));
    IF t IS NULL AND NOT p_partial THEN t := 'good'; END IF;
    IF t IS NULL OR NOT t = ANY (v_conditions) THEN
      e := e || jsonb_build_object('field', 'condition', 'message', 'Condition is not one of the allowed values');
    END IF;
    v := v || jsonb_build_object('condition', t);
  END IF;

  -- status (defaults to in_use)
  IF NOT p_partial OR p ? 'status' THEN
    t := lower(NULLIF(btrim(p->>'status'), ''));
    IF t IS NULL AND NOT p_partial THEN t := 'in_use'; END IF;
    IF t IS NULL OR NOT t = ANY (v_statuses) THEN
      e := e || jsonb_build_object('field', 'status', 'message', 'Status is not one of the allowed values');
    END IF;
    v := v || jsonb_build_object('status', t);
  END IF;

  -- optional free-text fields with length limits
  FOR f IN SELECT * FROM (VALUES
      ('brand', 120), ('model', 120), ('serial_number', 120), ('supplier', 200), ('invoice_reference', 120),
      ('location', 200), ('custodian_name', 200), ('notes', 2000)) AS x(field, max_len)
  LOOP
    IF NOT p_partial OR p ? f.field THEN
      t := NULLIF(btrim(p->>f.field), '');
      IF t IS NOT NULL AND length(t) > f.max_len THEN
        e := e || jsonb_build_object('field', f.field, 'message', format('Must be at most %s characters', f.max_len));
      END IF;
      v := v || jsonb_build_object(f.field, t);
    END IF;
  END LOOP;

  -- purchase_date (optional, ISO yyyy-mm-dd, 1990-01-01 .. today in Kampala)
  IF NOT p_partial OR p ? 'purchase_date' THEN
    t := NULLIF(btrim(p->>'purchase_date'), '');
    d := NULL;
    IF t IS NOT NULL THEN
      IF t !~ '^\d{4}-\d{2}-\d{2}$' THEN
        e := e || jsonb_build_object('field', 'purchase_date', 'message', 'Purchase date must be YYYY-MM-DD');
      ELSE
        BEGIN
          d := t::date;
        EXCEPTION WHEN others THEN
          e := e || jsonb_build_object('field', 'purchase_date', 'message', 'Purchase date is not a real date');
        END;
        IF d IS NOT NULL AND (d < DATE '1990-01-01' OR d > v_today) THEN
          e := e || jsonb_build_object('field', 'purchase_date', 'message', 'Purchase date must be between 1990-01-01 and today');
        END IF;
      END IF;
    END IF;
    v := v || jsonb_build_object('purchase_date', to_jsonb(d));
  END IF;

  -- purchase_cost (optional, register information only; 0 .. 1,000,000,000,000 with at most 2 decimals)
  IF NOT p_partial OR p ? 'purchase_cost' THEN
    t := NULLIF(btrim(p->>'purchase_cost'), '');
    n := NULL;
    IF t IS NOT NULL THEN
      IF t !~ '^\d{1,13}(\.\d{1,2})?$' THEN
        e := e || jsonb_build_object('field', 'purchase_cost', 'message', 'Purchase cost must be a positive number with at most 2 decimals');
      ELSE
        n := t::numeric;
        IF n > 1000000000000 THEN
          e := e || jsonb_build_object('field', 'purchase_cost', 'message', 'Purchase cost is too large');
        END IF;
      END IF;
    END IF;
    v := v || jsonb_build_object('purchase_cost', to_jsonb(n));
  END IF;

  -- currency (defaults to UGX)
  IF NOT p_partial OR p ? 'currency' THEN
    t := upper(NULLIF(btrim(p->>'currency'), ''));
    IF t IS NULL AND NOT p_partial THEN t := 'UGX'; END IF;
    IF t IS NULL OR t !~ '^[A-Z]{3}$' THEN
      e := e || jsonb_build_object('field', 'currency', 'message', 'Currency must be a 3-letter code');
    END IF;
    v := v || jsonb_build_object('currency', t);
  END IF;

  -- department_key (optional, must be an active hr_departments key)
  IF NOT p_partial OR p ? 'department_key' THEN
    t := NULLIF(btrim(p->>'department_key'), '');
    IF t IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.hr_departments hd WHERE hd.key = t AND hd.active) THEN
      e := e || jsonb_build_object('field', 'department_key', 'message', 'Department is not an active department');
    END IF;
    v := v || jsonb_build_object('department_key', t);
  END IF;

  -- custodian_user_id (optional, must be a staff account)
  IF NOT p_partial OR p ? 'custodian_user_id' THEN
    t := NULLIF(btrim(p->>'custodian_user_id'), '');
    IF t IS NOT NULL THEN
      IF t !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        e := e || jsonb_build_object('field', 'custodian_user_id', 'message', 'Custodian is not a valid staff account');
        t := NULL;
      ELSIF NOT EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id = t::uuid) THEN
        e := e || jsonb_build_object('field', 'custodian_user_id', 'message', 'Custodian is not a staff account');
      END IF;
    END IF;
    v := v || jsonb_build_object('custodian_user_id', t);
  END IF;

  RETURN jsonb_build_object('errors', e, 'value', v);
END $$;

CREATE OR REPLACE FUNCTION public._asset_register_row_json(a public.assets)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT to_jsonb(a) - 'serial_number_norm' || jsonb_build_object(
    'department_name', (SELECT hd.name FROM public.hr_departments hd WHERE hd.key = a.department_key LIMIT 1),
    'custodian_display', COALESCE(
      (SELECT NULLIF(btrim(pr.full_name), '') FROM public.profiles pr WHERE pr.id = a.custodian_user_id),
      a.custodian_name),
    'created_by_name', (SELECT NULLIF(btrim(pr.full_name), '') FROM public.profiles pr WHERE pr.id = a.created_by),
    'updated_by_name', (SELECT NULLIF(btrim(pr.full_name), '') FROM public.profiles pr WHERE pr.id = a.updated_by)
  );
$$;

CREATE OR REPLACE FUNCTION public._asset_register_insert(p_value jsonb, p_actor uuid, p_batch uuid, p_event text)
RETURNS public.assets LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a public.assets%ROWTYPE;
BEGIN
  INSERT INTO public.assets (
    asset_code, name, category, brand, model, serial_number, purchase_date, supplier, purchase_cost, currency,
    invoice_reference, department_key, location, custodian_user_id, custodian_name, condition, status, notes,
    import_batch_id, created_by, updated_by
  ) VALUES (
    'WEL-AST-' || lpad(nextval('public.asset_code_seq')::text, 6, '0'),
    p_value->>'name', p_value->>'category', p_value->>'brand', p_value->>'model', p_value->>'serial_number',
    (p_value->>'purchase_date')::date, p_value->>'supplier', (p_value->>'purchase_cost')::numeric,
    COALESCE(p_value->>'currency', 'UGX'), p_value->>'invoice_reference', p_value->>'department_key',
    p_value->>'location', (p_value->>'custodian_user_id')::uuid, p_value->>'custodian_name',
    COALESCE(p_value->>'condition', 'good'), COALESCE(p_value->>'status', 'in_use'), p_value->>'notes',
    p_batch, p_actor, p_actor
  ) RETURNING * INTO a;

  INSERT INTO public.asset_events (asset_id, event_type, new_values, actor_id, batch_id)
  VALUES (a.id, p_event, to_jsonb(a) - 'serial_number_norm', p_actor, p_batch);
  RETURN a;
END $$;

CREATE OR REPLACE FUNCTION public.asset_register_update(
  p_id uuid, p_expected_updated_at timestamptz, p_changes jsonb, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._asset_register_require(true);
  r jsonb;
  v jsonb;
  b public.assets%ROWTYPE;
  a public.assets%ROWTYPE;
  k text;
  v_changed text[] := '{}';
  v_old jsonb := '{}'::jsonb;
  v_new jsonb := '{}'::jsonb;
  v_owner text;
BEGIN
  IF p_id IS NULL OR p_expected_updated_at IS NULL THEN
    RAISE EXCEPTION 'VERSION_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NOT NULL AND length(btrim(p_reason)) > 1000 THEN
    RAISE EXCEPTION 'REASON_TOO_LONG' USING ERRCODE = '22023';
  END IF;
  r := public._asset_register_validate(p_changes, true);
  IF jsonb_array_length(r->'errors') > 0 THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023', DETAIL = (r->'errors')::text;
  END IF;
  v := r->'value';

  SELECT * INTO b FROM public.assets WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  -- Optimistic lock: never overwrite a newer version.
  IF b.updated_at <> p_expected_updated_at THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = '40001';
  END IF;

  FOR k IN SELECT jsonb_object_keys(v) LOOP
    IF (to_jsonb(b)->k) IS DISTINCT FROM (v->k) THEN
      v_changed := v_changed || k;
      v_old := v_old || jsonb_build_object(k, to_jsonb(b)->k);
      v_new := v_new || jsonb_build_object(k, v->k);
    END IF;
  END LOOP;
  IF cardinality(v_changed) = 0 THEN
    RAISE EXCEPTION 'NO_CHANGES' USING ERRCODE = '22023';
  END IF;

  IF 'category' = ANY (v_changed) OR 'serial_number' = ANY (v_changed) THEN
    v_owner := public._asset_register_serial_owner(
      COALESCE(v->>'category', b.category),
      CASE WHEN v ? 'serial_number' THEN v->>'serial_number' ELSE b.serial_number END,
      b.id);
    IF v_owner IS NOT NULL THEN
      RAISE EXCEPTION 'DUPLICATE_SERIAL' USING ERRCODE = '23505',
        DETAIL = jsonb_build_array(jsonb_build_object('field', 'serial_number',
          'message', 'Serial number already registered as ' || v_owner))::text;
    END IF;
  END IF;

  UPDATE public.assets SET
    name              = CASE WHEN v ? 'name' THEN v->>'name' ELSE name END,
    category          = CASE WHEN v ? 'category' THEN v->>'category' ELSE category END,
    brand             = CASE WHEN v ? 'brand' THEN v->>'brand' ELSE brand END,
    model             = CASE WHEN v ? 'model' THEN v->>'model' ELSE model END,
    serial_number     = CASE WHEN v ? 'serial_number' THEN v->>'serial_number' ELSE serial_number END,
    purchase_date     = CASE WHEN v ? 'purchase_date' THEN (v->>'purchase_date')::date ELSE purchase_date END,
    supplier          = CASE WHEN v ? 'supplier' THEN v->>'supplier' ELSE supplier END,
    purchase_cost     = CASE WHEN v ? 'purchase_cost' THEN (v->>'purchase_cost')::numeric ELSE purchase_cost END,
    currency          = CASE WHEN v ? 'currency' THEN v->>'currency' ELSE currency END,
    invoice_reference = CASE WHEN v ? 'invoice_reference' THEN v->>'invoice_reference' ELSE invoice_reference END,
    department_key    = CASE WHEN v ? 'department_key' THEN v->>'department_key' ELSE department_key END,
    location          = CASE WHEN v ? 'location' THEN v->>'location' ELSE location END,
    custodian_user_id = CASE WHEN v ? 'custodian_user_id' THEN (v->>'custodian_user_id')::uuid ELSE custodian_user_id END,
    custodian_name    = CASE WHEN v ? 'custodian_name' THEN v->>'custodian_name' ELSE custodian_name END,
    condition         = CASE WHEN v ? 'condition' THEN v->>'condition' ELSE condition END,
    status            = CASE WHEN v ? 'status' THEN v->>'status' ELSE status END,
    notes             = CASE WHEN v ? 'notes' THEN v->>'notes' ELSE notes END,
    updated_by        = v_actor,
    updated_at        = clock_timestamp()
  WHERE id = b.id
  RETURNING * INTO a;

  INSERT INTO public.asset_events (asset_id, event_type, changed_fields, old_values, new_values, reason, actor_id)
  VALUES (a.id, 'updated', v_changed, v_old, v_new, NULLIF(btrim(p_reason), ''), v_actor);
  RETURN public._asset_register_row_json(a);
END $$;

CREATE OR REPLACE FUNCTION public.asset_register_list(
  p_search text DEFAULT NULL, p_category text DEFAULT NULL, p_status text DEFAULT NULL,
  p_condition text DEFAULT NULL, p_department text DEFAULT NULL, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_q text;
  v_qnorm text;
  v_total bigint;
  v_items jsonb;
BEGIN
  PERFORM public._asset_register_require(false);
  IF p_search IS NOT NULL AND length(p_search) > 100 THEN
    RAISE EXCEPTION 'SEARCH_TOO_LONG' USING ERRCODE = '22023';
  END IF;
  v_q := NULLIF(btrim(p_search), '');
  IF v_q IS NOT NULL THEN
    v_qnorm := NULLIF(upper(regexp_replace(v_q, '[^A-Za-z0-9]', '', 'g')), '');
    v_q := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  END IF;

  WITH f AS (
    SELECT a.id, a.created_at, a.asset_code
      FROM public.assets a
      LEFT JOIN public.profiles cp ON cp.id = a.custodian_user_id
     WHERE (p_category IS NULL OR a.category = p_category)
       AND (p_status IS NULL OR a.status = p_status)
       AND (p_condition IS NULL OR a.condition = p_condition)
       AND (p_department IS NULL OR a.department_key = p_department)
       AND (v_q IS NULL
            OR a.asset_code ILIKE v_q OR a.name ILIKE v_q OR a.brand ILIKE v_q OR a.model ILIKE v_q
            OR a.supplier ILIKE v_q OR a.location ILIKE v_q OR a.custodian_name ILIKE v_q
            OR a.invoice_reference ILIKE v_q OR cp.full_name ILIKE v_q
            OR (v_qnorm IS NOT NULL AND a.serial_number_norm LIKE '%' || v_qnorm || '%'))
  ), page AS (
    SELECT id FROM f ORDER BY created_at DESC, asset_code DESC LIMIT v_limit OFFSET v_offset
  )
  SELECT (SELECT count(*) FROM f),
         COALESCE((SELECT jsonb_agg(public._asset_register_row_json(a) ORDER BY a.created_at DESC, a.asset_code DESC)
                     FROM public.assets a JOIN page USING (id)), '[]'::jsonb)
    INTO v_total, v_items;

  RETURN jsonb_build_object('total_count', v_total, 'limit', v_limit, 'offset', v_offset, 'items', v_items);
END $$;

CREATE OR REPLACE FUNCTION public.asset_register_reference_data()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._asset_register_require(false);
  RETURN jsonb_build_object(
    'departments', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', hd.key, 'name', hd.name) ORDER BY hd.name)
                               FROM public.hr_departments hd WHERE hd.active), '[]'::jsonb),
    'custodians', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                 'user_id', sp.user_id,
                                 'name', COALESCE(NULLIF(btrim(pr.full_name), ''), sp.employee_id),
                                 'employee_id', sp.employee_id,
                                 'department', sp.department) ORDER BY COALESCE(NULLIF(btrim(pr.full_name), ''), sp.employee_id))
                              FROM public.staff_profiles sp
                              LEFT JOIN public.profiles pr ON pr.id = sp.user_id
                             WHERE pr.deleted_at IS NULL), '[]'::jsonb));
END $$;

-- ── Drop the tag objects ───────────────────────────────────────────────────────────────────────────
ALTER TABLE public.assets DROP CONSTRAINT assets_tag_needs_site;
ALTER TABLE public.assets DROP COLUMN asset_tag;
ALTER TABLE public.assets DROP COLUMN site_key;
DROP TABLE public.asset_sites;
DROP FUNCTION public._asset_register_guard_site();
DROP FUNCTION public._asset_register_make_tag(text, text, text);
DROP FUNCTION public._asset_register_category_code(text);

DO $post$
DECLARE
  v_expected jsonb := jsonb_build_object(
    '_asset_register_validate(jsonb,boolean)', '068c905f06a2a5708eeac4fd511f4058',
    '_asset_register_row_json(assets)', '838116e871cee8076259514cf7ec6590',
    '_asset_register_insert(jsonb,uuid,uuid,text)', '2083a8629669bfefc30e4d89bc850bf5',
    '_asset_register_guard_identity()', 'd3abfc8367437ac630c76f2b4a9a3e22',
    'asset_register_update(uuid,timestamp with time zone,jsonb,text)', '0aff4cf709118c21c0b5b7339aac5d3c',
    'asset_register_list(text,text,text,text,text,integer,integer)', '710528d71b83b8df9cbec896a2d812b8',
    'asset_register_reference_data()', '751a94822a20f80722481c84a9a3d106');
  v_actual jsonb;
BEGIN
  SELECT jsonb_object_agg(p.oid::regprocedure::text, md5(replace(p.prosrc, chr(13), ''))) INTO v_actual
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('_asset_register_validate', '_asset_register_row_json', '_asset_register_insert',
                       '_asset_register_guard_identity', 'asset_register_update', 'asset_register_list',
                       'asset_register_reference_data');
  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'rollback check failed: functions not restored to their 20261026200000 definitions (found %)', v_actual;
  END IF;
END
$post$;

RESET lock_timeout;
