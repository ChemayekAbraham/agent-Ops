SET lock_timeout = '20s';

-- 1. Stored, user-entered number of items per asset record.
ALTER TABLE public.assets
  ADD COLUMN quantity integer NOT NULL DEFAULT 1
  CHECK (quantity >= 1 AND quantity <= 100000);

-- Existing rows keep the number they show today (the same-item count).
UPDATE public.assets a
   SET quantity = c.n
  FROM (SELECT category, lower(btrim(name)) AS nm, site_key, count(*) AS n
          FROM public.assets GROUP BY 1, 2, 3) c
 WHERE c.category = a.category
   AND c.nm = lower(btrim(a.name))
   AND c.site_key IS NOT DISTINCT FROM a.site_key;

-- 2. Validation accepts quantity (optional whole number 1..100000; defaults to 1 on create).
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
    'custodian_name', 'condition', 'status', 'notes', 'site_key', 'quantity'];
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

  -- site_key (required on create / import; when sent on update it cannot be cleared): an active asset_sites key.
  -- Changing the site later never changes an issued asset tag.
  IF NOT p_partial OR p ? 'site_key' THEN
    t := NULLIF(btrim(p->>'site_key'), '');
    IF t IS NULL THEN
      e := e || jsonb_build_object('field', 'site_key', 'message', 'Site is required');
    ELSIF NOT EXISTS (SELECT 1 FROM public.asset_sites s WHERE s.key = t AND s.active) THEN
      e := e || jsonb_build_object('field', 'site_key', 'message', 'Site is not an active site');
    END IF;
    v := v || jsonb_build_object('site_key', t);
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

  -- quantity (optional whole number 1..100000; defaults to 1 on create)
  IF NOT p_partial OR p ? 'quantity' THEN
    t := NULLIF(btrim(p->>'quantity'), '');
    IF t IS NULL AND NOT p_partial THEN t := '1'; END IF;
    IF t IS NOT NULL THEN
      IF t !~ '^\d{1,6}$' THEN
        e := e || jsonb_build_object('field', 'quantity', 'message', 'Number of items must be a whole number from 1 to 100000');
      ELSIF t::integer < 1 OR t::integer > 100000 THEN
        e := e || jsonb_build_object('field', 'quantity', 'message', 'Number of items must be a whole number from 1 to 100000');
      END IF;
    END IF;
    v := v || jsonb_build_object('quantity', CASE WHEN t IS NULL THEN to_jsonb(NULL::integer) ELSE to_jsonb(t::integer) END);
  END IF;

  RETURN jsonb_build_object('errors', e, 'value', v);
END $$;

-- 3. Insert stores the quantity.
CREATE OR REPLACE FUNCTION public._asset_register_insert(p_value jsonb, p_actor uuid, p_batch uuid, p_event text)
RETURNS public.assets LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a public.assets%ROWTYPE;
  v_code text := 'WEL-AST-' || lpad(nextval('public.asset_code_seq')::text, 6, '0');
BEGIN
  INSERT INTO public.assets (
    asset_code, asset_tag, site_key, name, category, brand, model, serial_number, purchase_date, supplier,
    purchase_cost, currency, invoice_reference, department_key, location, custodian_user_id, custodian_name,
    condition, status, notes, quantity, import_batch_id, created_by, updated_by
  ) VALUES (
    v_code, public._asset_register_make_tag(p_value->>'category', p_value->>'site_key', v_code), p_value->>'site_key',
    p_value->>'name', p_value->>'category', p_value->>'brand', p_value->>'model', p_value->>'serial_number',
    (p_value->>'purchase_date')::date, p_value->>'supplier', (p_value->>'purchase_cost')::numeric,
    COALESCE(p_value->>'currency', 'UGX'), p_value->>'invoice_reference', p_value->>'department_key',
    p_value->>'location', (p_value->>'custodian_user_id')::uuid, p_value->>'custodian_name',
    COALESCE(p_value->>'condition', 'good'), COALESCE(p_value->>'status', 'in_use'), p_value->>'notes',
    COALESCE((p_value->>'quantity')::integer, 1),
    p_batch, p_actor, p_actor
  ) RETURNING * INTO a;

  INSERT INTO public.asset_events (asset_id, event_type, new_values, actor_id, batch_id)
  VALUES (a.id, p_event, to_jsonb(a) - 'serial_number_norm', p_actor, p_batch);
  RETURN a;
END $$;

-- 4. Update can change the quantity (recorded in the asset history like any other field).
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
    site_key          = CASE WHEN v ? 'site_key' THEN v->>'site_key' ELSE site_key END,
    location          = CASE WHEN v ? 'location' THEN v->>'location' ELSE location END,
    custodian_user_id = CASE WHEN v ? 'custodian_user_id' THEN (v->>'custodian_user_id')::uuid ELSE custodian_user_id END,
    custodian_name    = CASE WHEN v ? 'custodian_name' THEN v->>'custodian_name' ELSE custodian_name END,
    condition         = CASE WHEN v ? 'condition' THEN v->>'condition' ELSE condition END,
    status            = CASE WHEN v ? 'status' THEN v->>'status' ELSE status END,
    notes             = CASE WHEN v ? 'notes' THEN v->>'notes' ELSE notes END,
    quantity          = CASE WHEN v ? 'quantity' THEN (v->>'quantity')::integer ELSE quantity END,
    updated_by        = v_actor,
    updated_at        = clock_timestamp()
  WHERE id = b.id
  RETURNING * INTO a;

  INSERT INTO public.asset_events (asset_id, event_type, changed_fields, old_values, new_values, reason, actor_id)
  VALUES (a.id, 'updated', v_changed, v_old, v_new, NULLIF(btrim(p_reason), ''), v_actor);
  RETURN public._asset_register_row_json(a);
END $$;

RESET lock_timeout;