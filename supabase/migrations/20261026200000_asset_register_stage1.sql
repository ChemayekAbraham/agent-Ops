-- 2026-10-26: CFO Asset Tracking Register, Stage 1 (core). NOT APPLIED. Production apply needs explicit CFO approval.
-- Register information only: nothing here reads or writes general_ledger, ledger_account_map, wallets, payments or
-- balances. purchase_cost is a recorded register attribute, never posted.
--
-- Scope (CFO 2026-10-26): tangible assets owned and used by Welile: computers and IT equipment, furniture, office
-- equipment, company vehicles, machinery, other. Bikes, resale stock, smartphones and NFC cards are excluded pending a
-- separate scope review (no category for them).
-- Access (CFO 2026-10-26): read AND write = cfo, super_admin (enabled role) + staff MFA. Broader read access (ceo,
-- coo) is NOT granted until it is reviewed. Tables grant SELECT only (RLS-gated); every write goes through the
-- SECURITY DEFINER RPCs below, which validate, write the append-only asset_events row in the same transaction and
-- never upsert or overwrite.
-- Evidence: the PRIVATE bucket `asset-evidence` is created here. Its two storage.objects policies are in the
-- separate migration 20261026200100_asset_register_stage1_storage_policies, because only the owner of storage.objects (supabase_storage_admin) may create them;
-- the CLI's postgres login cannot. Until that file is applied, evidence upload and viewing are refused (deny by
-- default); everything else works.
-- TRANSACTION: run as ONE transaction (by hand: BEGIN; ... COMMIT;). The preflight changes nothing when it refuses.
-- Rollback: supabase/rollbacks/20261026200000_asset_register_stage1.rollback.sql (after the storage-policy rollback, if that file was applied).
-- Tests: scripts/test-asset-register.mjs (PGlite, runs supabase/tests/asset_register_stage1.sql + scenarios).

SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF to_regclass('public.assets') IS NOT NULL
     OR to_regclass('public.asset_events') IS NOT NULL
     OR to_regclass('public.asset_import_batches') IS NOT NULL
     OR to_regclass('public.asset_code_seq') IS NOT NULL
     OR to_regprocedure('public.asset_register_create(jsonb)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'asset-evidence')
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._has_enabled_role(uuid,text[])'::regprocedure)
          IS DISTINCT FROM 'd6ffa5096fedec926c3daf15d2af1aec'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.staff_mfa_ok()'::regprocedure)
          IS DISTINCT FROM 'faf13a32385adbb45377f46a4969ad55'
     OR (SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'public'
            AND (table_name, column_name) IN (('hr_departments', 'key'), ('hr_departments', 'name'), ('hr_departments', 'active'),
                                              ('staff_profiles', 'user_id'), ('staff_profiles', 'employee_id'),
                                              ('staff_profiles', 'department'), ('profiles', 'full_name'), ('profiles', 'deleted_at'))) <> 8 THEN
    RAISE EXCEPTION 'precondition failed: asset register objects already exist, or a dependency changed since 2026-10-26; nothing was changed';
  END IF;
END
$pre$;

-- ── Sequence for server-generated asset codes (WEL-AST-000001) ────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS public.asset_code_seq START 1;
REVOKE ALL ON SEQUENCE public.asset_code_seq FROM PUBLIC, anon, authenticated;

-- ── Tables ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.asset_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name text NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 255),
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  row_count integer NOT NULL CHECK (row_count BETWEEN 1 AND 1000),
  inserted_count integer NOT NULL DEFAULT 0 CHECK (inserted_count >= 0),
  rejected_count integer NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  status text NOT NULL CHECK (status IN ('committed', 'failed')),
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- The same file can never be committed twice.
CREATE UNIQUE INDEX asset_import_batches_committed_sha_uq
  ON public.asset_import_batches (file_sha256) WHERE status = 'committed';

CREATE TABLE public.assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_code text NOT NULL UNIQUE CHECK (asset_code ~ '^WEL-AST-[0-9]{6,}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 200),
  category text NOT NULL CHECK (category IN (
    'it_equipment', 'furniture', 'office_equipment', 'company_vehicles', 'machinery', 'other')),
  brand text CHECK (brand IS NULL OR length(brand) <= 120),
  model text CHECK (model IS NULL OR length(model) <= 120),
  serial_number text CHECK (serial_number IS NULL OR length(serial_number) <= 120),
  serial_number_norm text GENERATED ALWAYS AS (
    NULLIF(upper(regexp_replace(COALESCE(serial_number, ''), '[^A-Za-z0-9]', '', 'g')), '')
  ) STORED,
  purchase_date date CHECK (purchase_date IS NULL OR purchase_date >= DATE '1990-01-01'),
  supplier text CHECK (supplier IS NULL OR length(supplier) <= 200),
  purchase_cost numeric(16, 2) CHECK (purchase_cost IS NULL OR (purchase_cost >= 0 AND purchase_cost <= 1000000000000)),
  currency text NOT NULL DEFAULT 'UGX' CHECK (currency ~ '^[A-Z]{3}$'),
  invoice_reference text CHECK (invoice_reference IS NULL OR length(invoice_reference) <= 120),
  department_key text CHECK (department_key IS NULL OR length(department_key) <= 80),
  location text CHECK (location IS NULL OR length(location) <= 200),
  custodian_user_id uuid,
  custodian_name text CHECK (custodian_name IS NULL OR length(custodian_name) <= 200),
  condition text NOT NULL DEFAULT 'good' CHECK (condition IN ('new', 'good', 'fair', 'poor', 'damaged')),
  status text NOT NULL DEFAULT 'in_use' CHECK (status IN ('in_use', 'in_storage', 'under_repair', 'lost', 'disposed')),
  photo_paths text[] NOT NULL DEFAULT '{}' CHECK (cardinality(photo_paths) <= 20),
  evidence_paths text[] NOT NULL DEFAULT '{}' CHECK (cardinality(evidence_paths) <= 20),
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  import_batch_id uuid REFERENCES public.asset_import_batches(id),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Serial numbers are unique per category (normalised: upper case, letters and digits only).
CREATE UNIQUE INDEX assets_category_serial_uq
  ON public.assets (category, serial_number_norm) WHERE serial_number_norm IS NOT NULL;
CREATE INDEX assets_category_idx ON public.assets (category);
CREATE INDEX assets_status_idx ON public.assets (status);
CREATE INDEX assets_department_idx ON public.assets (department_key);
CREATE INDEX assets_custodian_idx ON public.assets (custodian_user_id);
CREATE INDEX assets_created_idx ON public.assets (created_at DESC, asset_code DESC);

CREATE TABLE public.asset_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES public.assets(id),
  event_type text NOT NULL CHECK (event_type IN ('created', 'imported', 'updated', 'evidence_added')),
  changed_fields text[] NOT NULL DEFAULT '{}',
  old_values jsonb,
  new_values jsonb,
  reason text CHECK (reason IS NULL OR length(reason) <= 1000),
  actor_id uuid NOT NULL,
  batch_id uuid REFERENCES public.asset_import_batches(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX asset_events_asset_idx ON public.asset_events (asset_id, created_at DESC);

-- ── Immutability guards (apply to every role, including service_role) ────────────────────────────
CREATE OR REPLACE FUNCTION public._asset_register_block_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be %d', TG_TABLE_NAME, lower(TG_OP) USING ERRCODE = '42501';
END $$;

CREATE TRIGGER asset_events_append_only BEFORE UPDATE OR DELETE ON public.asset_events
  FOR EACH ROW EXECUTE FUNCTION public._asset_register_block_mutation();
CREATE TRIGGER asset_import_batches_append_only BEFORE UPDATE OR DELETE ON public.asset_import_batches
  FOR EACH ROW EXECUTE FUNCTION public._asset_register_block_mutation();
-- Assets are never deleted: retirement is a status change (lost / disposed).
CREATE TRIGGER assets_no_delete BEFORE DELETE ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public._asset_register_block_mutation();

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
CREATE TRIGGER assets_identity_immutable BEFORE UPDATE ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public._asset_register_guard_identity();

-- ── Access helpers ─────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.asset_register_read_ok()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL
     AND public._has_enabled_role(auth.uid(), ARRAY['cfo', 'super_admin']);  -- ceo/coo pending CFO review
$$;

CREATE OR REPLACE FUNCTION public.asset_register_write_ok()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL
     AND public._has_enabled_role(auth.uid(), ARRAY['cfo', 'super_admin']);
$$;

-- Raises 42501 unless the caller may read (p_write = false) or write (p_write = true). Returns the actor.
CREATE OR REPLACE FUNCTION public._asset_register_require(p_write boolean)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF NOT (CASE WHEN p_write THEN public.asset_register_write_ok() ELSE public.asset_register_read_ok() END)
     OR NOT COALESCE(public.staff_mfa_ok(), false) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;
  RETURN v_actor;
END $$;

-- ── RLS ────────────────────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON public.assets, public.asset_events, public.asset_import_batches FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.assets, public.asset_events, public.asset_import_batches TO authenticated;
GRANT ALL ON public.assets, public.asset_events, public.asset_import_batches TO service_role;

ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_import_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY assets_select ON public.assets FOR SELECT TO authenticated
  USING ((select public.asset_register_read_ok()));
CREATE POLICY asset_events_select ON public.asset_events FOR SELECT TO authenticated
  USING ((select public.asset_register_read_ok()));
CREATE POLICY asset_import_batches_select ON public.asset_import_batches FOR SELECT TO authenticated
  USING ((select public.asset_register_read_ok()));

CREATE POLICY mfa_required_for_staff ON public.assets AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));
CREATE POLICY mfa_required_for_staff ON public.asset_events AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));
CREATE POLICY mfa_required_for_staff ON public.asset_import_batches AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));

-- ── Validation (single definition, used by create, update and import) ─────────────────────────────
-- Returns {"errors": [{"field","message"}], "value": {normalised fields}}. p_partial = true validates only
-- the keys present (update); false validates a full record and fills defaults (create / import).
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

-- ── Row presentation (display names resolved server-side) ─────────────────────────────────────────
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

-- ── Insert (single place a row is created) ────────────────────────────────────────────────────────
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

-- Existing asset holding the same normalised serial in the same category (excluding p_exclude).
CREATE OR REPLACE FUNCTION public._asset_register_serial_owner(p_category text, p_serial text, p_exclude uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.asset_code FROM public.assets a
   WHERE a.category = p_category
     AND a.serial_number_norm = NULLIF(upper(regexp_replace(COALESCE(p_serial, ''), '[^A-Za-z0-9]', '', 'g')), '')
     AND (p_exclude IS NULL OR a.id <> p_exclude)
   LIMIT 1;
$$;

-- ── Public RPCs ────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.asset_register_create(p_asset jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._asset_register_require(true);
  r jsonb;
  v_owner text;
  a public.assets%ROWTYPE;
BEGIN
  r := public._asset_register_validate(p_asset, false);
  IF jsonb_array_length(r->'errors') > 0 THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023', DETAIL = (r->'errors')::text;
  END IF;
  v_owner := public._asset_register_serial_owner(r->'value'->>'category', r->'value'->>'serial_number', NULL);
  IF v_owner IS NOT NULL THEN
    RAISE EXCEPTION 'DUPLICATE_SERIAL' USING ERRCODE = '23505',
      DETAIL = jsonb_build_array(jsonb_build_object('field', 'serial_number',
        'message', 'Serial number already registered as ' || v_owner))::text;
  END IF;
  a := public._asset_register_insert(r->'value', v_actor, NULL, 'created');
  RETURN public._asset_register_row_json(a);
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

CREATE OR REPLACE FUNCTION public.asset_register_get(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a public.assets%ROWTYPE;
BEGIN
  PERFORM public._asset_register_require(false);
  SELECT * INTO a FROM public.assets WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  RETURN jsonb_build_object(
    'asset', public._asset_register_row_json(a),
    'events', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', e.id, 'event_type', e.event_type, 'changed_fields', e.changed_fields,
               'old_values', e.old_values, 'new_values', e.new_values, 'reason', e.reason,
               'actor_id', e.actor_id, 'actor_name', NULLIF(btrim(pr.full_name), ''),
               'batch_id', e.batch_id, 'created_at', e.created_at)
             ORDER BY e.created_at DESC, e.id)
        FROM public.asset_events e
        LEFT JOIN public.profiles pr ON pr.id = e.actor_id
       WHERE e.asset_id = a.id), '[]'::jsonb));
END $$;

-- Overview figures. Register cost is the recorded purchase cost in UGX; it is NOT a ledger / balance-sheet value.
CREATE OR REPLACE FUNCTION public.asset_register_summary()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v jsonb;
BEGIN
  PERFORM public._asset_register_require(false);
  SELECT jsonb_build_object(
    'as_at', now(),
    'total_assets', count(*),
    'active_assets', count(*) FILTER (WHERE status IN ('in_use', 'in_storage', 'under_repair')),
    'register_cost_ugx', COALESCE(sum(purchase_cost) FILTER (WHERE currency = 'UGX'), 0),
    'active_register_cost_ugx', COALESCE(sum(purchase_cost) FILTER (
      WHERE currency = 'UGX' AND status IN ('in_use', 'in_storage', 'under_repair')), 0),
    'cost_missing_count', count(*) FILTER (WHERE purchase_cost IS NULL),
    'non_ugx_count', count(*) FILTER (WHERE currency <> 'UGX'),
    'missing_evidence_count', count(*) FILTER (WHERE cardinality(evidence_paths) = 0 AND invoice_reference IS NULL),
    'missing_photo_count', count(*) FILTER (WHERE cardinality(photo_paths) = 0),
    'missing_serial_count', count(*) FILTER (WHERE serial_number_norm IS NULL),
    'unassigned_count', count(*) FILTER (WHERE custodian_user_id IS NULL AND custodian_name IS NULL)
  ) INTO v FROM public.assets;

  RETURN v || jsonb_build_object(
    'by_status', COALESCE((SELECT jsonb_object_agg(s.status, s.c) FROM (
      SELECT status, count(*) AS c FROM public.assets GROUP BY status) s), '{}'::jsonb),
    'by_condition', COALESCE((SELECT jsonb_object_agg(s.condition, s.c) FROM (
      SELECT condition, count(*) AS c FROM public.assets GROUP BY condition) s), '{}'::jsonb),
    'by_category', COALESCE((SELECT jsonb_agg(jsonb_build_object('category', s.category, 'count', s.c, 'cost_ugx', s.cost)
                                              ORDER BY s.c DESC, s.category) FROM (
      SELECT category, count(*) AS c, COALESCE(sum(purchase_cost) FILTER (WHERE currency = 'UGX'), 0) AS cost
        FROM public.assets GROUP BY category) s), '[]'::jsonb));
END $$;

-- Departments and staff custodians for pickers (read gate).
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

-- Import preview: duplicate serials and possible duplicates against the existing register (read only).
-- Rows: [{"row_ref": 2, "name": ..., "category": ..., "serial_number": ..., ...}] (max 1000).
CREATE OR REPLACE FUNCTION public.asset_register_check_duplicates(p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._asset_register_require(true);
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) > 1000 THEN
    RAISE EXCEPTION 'ROWS_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(s.m ORDER BY s.i) FROM (
      SELECT t.i, jsonb_build_object(
        'row_ref', COALESCE(x->>'row_ref', i::text),
        'serial_match', public._asset_register_serial_owner(lower(btrim(x->>'category')), x->>'serial_number', NULL),
        'possible_match', (
          SELECT a.asset_code FROM public.assets a
           WHERE lower(a.name) = lower(btrim(x->>'name'))
             AND COALESCE(lower(a.brand), '') = COALESCE(lower(NULLIF(btrim(x->>'brand'), '')), '')
             AND COALESCE(lower(a.model), '') = COALESCE(lower(NULLIF(btrim(x->>'model'), '')), '')
             AND COALESCE(lower(a.supplier), '') = COALESCE(lower(NULLIF(btrim(x->>'supplier'), '')), '')
             AND a.purchase_date::text IS NOT DISTINCT FROM NULLIF(btrim(x->>'purchase_date'), '')
           LIMIT 1)) AS m
        FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(x, i)
    ) s
    WHERE s.m->>'serial_match' IS NOT NULL OR s.m->>'possible_match' IS NOT NULL), '[]'::jsonb);
END $$;

-- Import commit: re-validates every row on the server; all-or-nothing; insert only, never update/upsert.
-- A rejected batch inserts nothing (it is recorded as `failed` with its row errors for audit).
CREATE OR REPLACE FUNCTION public.asset_register_import_commit(p_file_name text, p_file_sha256 text, p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._asset_register_require(true);
  v_sha text := lower(btrim(p_file_sha256));
  v_n int;
  rec record;
  r jsonb;
  v_ref text;
  v_key text;
  v_owner text;
  v_seen text[] := '{}';
  v_vals jsonb[] := '{}';
  v_errs jsonb := '[]'::jsonb;
  v_bad_rows text[] := '{}';
  v_batch uuid;
  v_codes jsonb := '[]'::jsonb;
  a public.assets%ROWTYPE;
  e jsonb;
BEGIN
  IF p_file_name IS NULL OR length(btrim(p_file_name)) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'FILE_NAME_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_sha IS NULL OR v_sha !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'FILE_HASH_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'ROWS_INVALID' USING ERRCODE = '22023';
  END IF;
  v_n := jsonb_array_length(p_rows);
  IF v_n < 1 OR v_n > 1000 THEN
    RAISE EXCEPTION 'ROW_COUNT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.asset_import_batches b WHERE b.file_sha256 = v_sha AND b.status = 'committed') THEN
    RAISE EXCEPTION 'FILE_ALREADY_IMPORTED' USING ERRCODE = '23505';
  END IF;

  FOR rec IN SELECT x, i FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(x, i) LOOP
    v_ref := COALESCE(rec.x->>'row_ref', rec.i::text);
    IF jsonb_typeof(rec.x) <> 'object' THEN
      v_errs := v_errs || jsonb_build_object('row_ref', v_ref, 'field', '_', 'message', 'Row must be an object');
      v_bad_rows := v_bad_rows || v_ref;
      CONTINUE;
    END IF;
    r := public._asset_register_validate(rec.x - 'row_ref', false);
    IF jsonb_array_length(r->'errors') > 0 THEN
      FOR e IN SELECT jsonb_array_elements(r->'errors') LOOP
        v_errs := v_errs || (e || jsonb_build_object('row_ref', v_ref));
      END LOOP;
      v_bad_rows := v_bad_rows || v_ref;
      CONTINUE;
    END IF;

    IF NULLIF(upper(regexp_replace(COALESCE(r->'value'->>'serial_number', ''), '[^A-Za-z0-9]', '', 'g')), '') IS NOT NULL THEN
      v_key := (r->'value'->>'category') || ':' || upper(regexp_replace(r->'value'->>'serial_number', '[^A-Za-z0-9]', '', 'g'));
      IF v_key = ANY (v_seen) THEN
        v_errs := v_errs || jsonb_build_object('row_ref', v_ref, 'field', 'serial_number',
                                               'message', 'Duplicate serial number within the file');
        v_bad_rows := v_bad_rows || v_ref;
        CONTINUE;
      END IF;
      v_seen := v_seen || v_key;
      v_owner := public._asset_register_serial_owner(r->'value'->>'category', r->'value'->>'serial_number', NULL);
      IF v_owner IS NOT NULL THEN
        v_errs := v_errs || jsonb_build_object('row_ref', v_ref, 'field', 'serial_number',
                                               'message', 'Serial number already registered as ' || v_owner);
        v_bad_rows := v_bad_rows || v_ref;
        CONTINUE;
      END IF;
    END IF;
    v_vals := v_vals || (r->'value');
  END LOOP;

  IF jsonb_array_length(v_errs) > 0 THEN
    INSERT INTO public.asset_import_batches (file_name, file_sha256, row_count, inserted_count, rejected_count, status, errors, created_by)
    VALUES (btrim(p_file_name), v_sha, v_n, 0,
            (SELECT count(DISTINCT x) FROM unnest(v_bad_rows) AS x), 'failed', v_errs, v_actor)
    RETURNING id INTO v_batch;
    RETURN jsonb_build_object('status', 'rejected', 'batch_id', v_batch, 'row_count', v_n,
                              'inserted_count', 0, 'errors', v_errs);
  END IF;

  INSERT INTO public.asset_import_batches (file_name, file_sha256, row_count, inserted_count, rejected_count, status, created_by)
  VALUES (btrim(p_file_name), v_sha, v_n, v_n, 0, 'committed', v_actor)
  RETURNING id INTO v_batch;

  FOREACH r IN ARRAY v_vals LOOP
    a := public._asset_register_insert(r, v_actor, v_batch, 'imported');
    v_codes := v_codes || to_jsonb(a.asset_code);
  END LOOP;

  RETURN jsonb_build_object('status', 'committed', 'batch_id', v_batch, 'row_count', v_n,
                            'inserted_count', v_n, 'asset_codes', v_codes);
END $$;

-- Attach an already-uploaded private object to an asset (photo or evidence). Append-only.
CREATE OR REPLACE FUNCTION public.asset_register_add_evidence(p_id uuid, p_kind text, p_path text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._asset_register_require(true);
  a public.assets%ROWTYPE;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('photo', 'evidence') THEN
    RAISE EXCEPTION 'KIND_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_id IS NULL OR p_path IS NULL
     OR p_path !~ ('^assets/' || p_id::text || '/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|pdf)$') THEN
    RAISE EXCEPTION 'PATH_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'asset-evidence' AND o.name = p_path) THEN
    RAISE EXCEPTION 'OBJECT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO a FROM public.assets WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF p_path = ANY (a.photo_paths) OR p_path = ANY (a.evidence_paths) THEN
    RAISE EXCEPTION 'EVIDENCE_ALREADY_ATTACHED' USING ERRCODE = '23505';
  END IF;

  UPDATE public.assets SET
    photo_paths = CASE WHEN p_kind = 'photo' THEN array_append(photo_paths, p_path) ELSE photo_paths END,
    evidence_paths = CASE WHEN p_kind = 'evidence' THEN array_append(evidence_paths, p_path) ELSE evidence_paths END,
    updated_by = v_actor,
    updated_at = clock_timestamp()
  WHERE id = p_id
  RETURNING * INTO a;

  INSERT INTO public.asset_events (asset_id, event_type, changed_fields, new_values, actor_id)
  VALUES (a.id, 'evidence_added', ARRAY[CASE WHEN p_kind = 'photo' THEN 'photo_paths' ELSE 'evidence_paths' END],
          jsonb_build_object('kind', p_kind, 'path', p_path), v_actor);
  RETURN public._asset_register_row_json(a);
END $$;

-- ── Function privileges ────────────────────────────────────────────────────────────────────────────
-- Owner-only internals.
REVOKE ALL ON FUNCTION public._asset_register_block_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._asset_register_guard_identity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._asset_register_require(boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._asset_register_validate(jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._asset_register_row_json(public.assets) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._asset_register_insert(jsonb, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._asset_register_serial_owner(text, text, uuid) FROM PUBLIC, anon, authenticated;

-- Gate helpers are evaluated inside RLS policies, so authenticated needs EXECUTE (they only return a boolean).
REVOKE ALL ON FUNCTION public.asset_register_read_ok() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.asset_register_write_ok() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.asset_register_read_ok() TO authenticated;
GRANT EXECUTE ON FUNCTION public.asset_register_write_ok() TO authenticated;

-- Public RPCs (each re-checks the role gate and staff MFA).
REVOKE ALL ON FUNCTION public.asset_register_create(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.asset_register_update(uuid, timestamptz, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.asset_register_list(text, text, text, text, text, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.asset_register_get(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.asset_register_summary() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.asset_register_reference_data() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.asset_register_check_duplicates(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.asset_register_import_commit(text, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.asset_register_add_evidence(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.asset_register_create(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.asset_register_update(uuid, timestamptz, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.asset_register_list(text, text, text, text, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.asset_register_get(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.asset_register_summary() TO authenticated;
GRANT EXECUTE ON FUNCTION public.asset_register_reference_data() TO authenticated;
GRANT EXECUTE ON FUNCTION public.asset_register_check_duplicates(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.asset_register_import_commit(text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.asset_register_add_evidence(uuid, text, text) TO authenticated;

-- ── Private evidence bucket ────────────────────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('asset-evidence', 'asset-evidence', false, 10485760,
        ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
ON CONFLICT (id) DO NOTHING;
UPDATE storage.buckets SET public = false WHERE id = 'asset-evidence';

RESET lock_timeout;
