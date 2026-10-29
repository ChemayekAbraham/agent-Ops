-- 2026-10-27: CFO Asset Register: sites and asset tags. NOT APPLIED. Production apply needs explicit CFO approval.
-- Register information only: nothing here reads or writes general_ledger, ledger_account_map, wallets, payments or
-- balances.
--
-- Asset tags (CFO 2026-10-27): every newly registered asset gets a printed tag
--   WEL-<category code>-<site code>-<register number>      e.g. WEL-ICT-HQ-001
-- * WEL-AST-NNNNNN stays the permanent system asset code; the database uuid stays the QR / link identity. The tag is
--   an additional, unique label identifier.
-- * register number = the digits of the asset's WEL-AST code, at least 3 digits (WEL-AST-000001 -> 001,
--   WEL-AST-001234 -> 1234). Unique because asset codes are unique; the UNIQUE constraint is a backstop.
-- * category codes: it_equipment ICT, furniture FUR, office_equipment OFE, company_vehicles VEH, machinery MAC, other OTH.
-- * sites: Entebbe Head Office = HQ, Kololo = KOL (asset_sites). New assets must have a site.
-- * A tag is issued by the server when the asset is registered or imported and is fixed afterwards: a later change of
--   site or category never changes it (printed labels stay valid). Nobody can edit or clear it; the only allowed
--   change is from no tag to exactly the tag computed from the asset's own category, site and code (used by the
--   separately approved backfill for assets registered before this migration). This migration tags nothing.
-- Access: unchanged (cfo, super_admin + staff MFA). asset_sites is SELECT-only, RLS-gated by asset_register_read_ok.
-- TRANSACTION: run as ONE transaction (by hand: BEGIN; ... COMMIT;). The preflight changes nothing when it refuses.
-- Rollback: supabase/rollbacks/20261027150000_asset_register_asset_tags.rollback.sql.
-- Backfill for the asset registered before this migration (WEL-AST-000001 -> WEL-ICT-HQ-001), separate approval:
--   docs/pending-migrations/asset_register_tag_backfill_wel_ast_000001.sql.
-- Tests: scripts/test-asset-register-tags.mjs (PGlite).

SET lock_timeout = '5s';
DO $pre$
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
  IF to_regclass('public.assets') IS NULL OR to_regclass('public.asset_code_seq') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: the Asset Register core (20261026200000) is not applied; nothing was changed';
  END IF;
  IF to_regclass('public.asset_sites') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'assets'
                 AND column_name IN ('asset_tag', 'site_key'))
     OR to_regprocedure('public._asset_register_make_tag(text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition failed: asset tag objects already exist; nothing was changed';
  END IF;
  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'precondition failed: an Asset Register function changed since 2026-10-27 (expected %, found %); nothing was changed',
      v_expected, v_actual;
  END IF;
END
$pre$;

-- ── Sites ──────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.asset_sites (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  name text NOT NULL UNIQUE CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  tag_code text NOT NULL UNIQUE CHECK (tag_code ~ '^[A-Z]{2,4}$'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.asset_sites (key, name, tag_code) VALUES
  ('entebbe_hq', 'Entebbe Head Office', 'HQ'),
  ('kololo', 'Kololo', 'KOL');

-- A site's key and tag code are part of issued tags, so they never change; sites are never deleted (deactivate).
CREATE OR REPLACE FUNCTION public._asset_register_guard_site()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.key IS DISTINCT FROM OLD.key OR NEW.tag_code IS DISTINCT FROM OLD.tag_code THEN
    RAISE EXCEPTION 'SITE_IDENTITY_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER asset_sites_identity_immutable BEFORE UPDATE ON public.asset_sites
  FOR EACH ROW EXECUTE FUNCTION public._asset_register_guard_site();
CREATE TRIGGER asset_sites_no_delete BEFORE DELETE ON public.asset_sites
  FOR EACH ROW EXECUTE FUNCTION public._asset_register_block_mutation();

REVOKE ALL ON public.asset_sites FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.asset_sites TO authenticated;
GRANT ALL ON public.asset_sites TO service_role;
ALTER TABLE public.asset_sites ENABLE ROW LEVEL SECURITY;
CREATE POLICY asset_sites_select ON public.asset_sites FOR SELECT TO authenticated
  USING ((select public.asset_register_read_ok()));
CREATE POLICY mfa_required_for_staff ON public.asset_sites AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));

-- ── Asset columns ──────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.assets
  ADD COLUMN site_key text REFERENCES public.asset_sites(key),
  ADD COLUMN asset_tag text UNIQUE
    CHECK (asset_tag IS NULL OR asset_tag ~ '^WEL-(ICT|FUR|OFE|VEH|MAC|OTH)-[A-Z]{2,4}-[0-9]{3,}$'),
  ADD CONSTRAINT assets_tag_needs_site CHECK (asset_tag IS NULL OR site_key IS NOT NULL);
CREATE INDEX assets_site_idx ON public.assets (site_key);

-- ── Tag construction (single definition) ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._asset_register_category_code(p_category text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE p_category
    WHEN 'it_equipment' THEN 'ICT' WHEN 'furniture' THEN 'FUR' WHEN 'office_equipment' THEN 'OFE'
    WHEN 'company_vehicles' THEN 'VEH' WHEN 'machinery' THEN 'MAC' WHEN 'other' THEN 'OTH' END;
$$;

-- WEL-<category code>-<site tag code>-<register number, at least 3 digits>. Raises rather than returning a partial tag.
CREATE OR REPLACE FUNCTION public._asset_register_make_tag(p_category text, p_site_key text, p_asset_code text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cat text := public._asset_register_category_code(p_category);
  v_site text;
  v_num text := (substring(p_asset_code FROM '^WEL-AST-([0-9]+)$')::bigint)::text;
BEGIN
  SELECT s.tag_code INTO v_site FROM public.asset_sites s WHERE s.key = p_site_key;
  IF v_cat IS NULL OR v_site IS NULL OR v_num IS NULL THEN
    RAISE EXCEPTION 'TAG_INPUT_INVALID' USING ERRCODE = '22023',
      DETAIL = format('category=%s site=%s code=%s', p_category, p_site_key, p_asset_code);
  END IF;
  -- lpad would truncate a longer number, so only pad when shorter than 3 digits.
  RETURN 'WEL-' || v_cat || '-' || v_site || '-' || CASE WHEN length(v_num) < 3 THEN lpad(v_num, 3, '0') ELSE v_num END;
END $$;

-- ── Identity guard: the tag is fixed once issued ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._asset_register_guard_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.asset_code IS DISTINCT FROM OLD.asset_code
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.import_batch_id IS DISTINCT FROM OLD.import_batch_id THEN
    RAISE EXCEPTION 'ASSET_IDENTITY_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  -- An issued tag never changes or disappears. An untagged asset may only receive the tag computed from its own
  -- category, site and code (the approved backfill); never an arbitrary value.
  IF OLD.asset_tag IS NOT NULL AND NEW.asset_tag IS DISTINCT FROM OLD.asset_tag THEN
    RAISE EXCEPTION 'ASSET_TAG_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  IF OLD.asset_tag IS NULL AND NEW.asset_tag IS NOT NULL
     AND NEW.asset_tag IS DISTINCT FROM public._asset_register_make_tag(NEW.category, NEW.site_key, NEW.asset_code) THEN
    RAISE EXCEPTION 'ASSET_TAG_MISMATCH' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

-- ── Validation: adds site_key (required on create / import; when sent on update it must stay a valid site) ─
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
    'custodian_name', 'condition', 'status', 'notes', 'site_key'];
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

  RETURN jsonb_build_object('errors', e, 'value', v);
END $$;

-- ── Row presentation: adds the site name and tag code ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._asset_register_row_json(a public.assets)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT to_jsonb(a) - 'serial_number_norm' || jsonb_build_object(
    'department_name', (SELECT hd.name FROM public.hr_departments hd WHERE hd.key = a.department_key LIMIT 1),
    'site_name', (SELECT s.name FROM public.asset_sites s WHERE s.key = a.site_key),
    'custodian_display', COALESCE(
      (SELECT NULLIF(btrim(pr.full_name), '') FROM public.profiles pr WHERE pr.id = a.custodian_user_id),
      a.custodian_name),
    'created_by_name', (SELECT NULLIF(btrim(pr.full_name), '') FROM public.profiles pr WHERE pr.id = a.created_by),
    'updated_by_name', (SELECT NULLIF(btrim(pr.full_name), '') FROM public.profiles pr WHERE pr.id = a.updated_by)
  );
$$;

-- ── Insert: issues the asset tag in the same statement that creates the row ───────────────────────
CREATE OR REPLACE FUNCTION public._asset_register_insert(p_value jsonb, p_actor uuid, p_batch uuid, p_event text)
RETURNS public.assets LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a public.assets%ROWTYPE;
  v_code text := 'WEL-AST-' || lpad(nextval('public.asset_code_seq')::text, 6, '0');
BEGIN
  INSERT INTO public.assets (
    asset_code, asset_tag, site_key, name, category, brand, model, serial_number, purchase_date, supplier,
    purchase_cost, currency, invoice_reference, department_key, location, custodian_user_id, custodian_name,
    condition, status, notes, import_batch_id, created_by, updated_by
  ) VALUES (
    v_code, public._asset_register_make_tag(p_value->>'category', p_value->>'site_key', v_code), p_value->>'site_key',
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

-- ── Update: site_key is editable; asset_tag is not (it is not an accepted field, and the trigger refuses it) ─
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
    updated_by        = v_actor,
    updated_at        = clock_timestamp()
  WHERE id = b.id
  RETURNING * INTO a;

  INSERT INTO public.asset_events (asset_id, event_type, changed_fields, old_values, new_values, reason, actor_id)
  VALUES (a.id, 'updated', v_changed, v_old, v_new, NULLIF(btrim(p_reason), ''), v_actor);
  RETURN public._asset_register_row_json(a);
END $$;

-- ── List: search also matches the asset tag and the site name ─────────────────────────────────────
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
      LEFT JOIN public.asset_sites st ON st.key = a.site_key
     WHERE (p_category IS NULL OR a.category = p_category)
       AND (p_status IS NULL OR a.status = p_status)
       AND (p_condition IS NULL OR a.condition = p_condition)
       AND (p_department IS NULL OR a.department_key = p_department)
       AND (v_q IS NULL
            OR a.asset_code ILIKE v_q OR a.asset_tag ILIKE v_q OR a.name ILIKE v_q OR a.brand ILIKE v_q
            OR a.model ILIKE v_q OR a.supplier ILIKE v_q OR a.location ILIKE v_q OR st.name ILIKE v_q
            OR a.custodian_name ILIKE v_q OR a.invoice_reference ILIKE v_q OR cp.full_name ILIKE v_q
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

-- ── Reference data: adds the active sites ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.asset_register_reference_data()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._asset_register_require(false);
  RETURN jsonb_build_object(
    'departments', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', hd.key, 'name', hd.name) ORDER BY hd.name)
                               FROM public.hr_departments hd WHERE hd.active), '[]'::jsonb),
    'sites', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', s.key, 'name', s.name, 'tag_code', s.tag_code) ORDER BY s.name)
                         FROM public.asset_sites s WHERE s.active), '[]'::jsonb),
    'custodians', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                 'user_id', sp.user_id,
                                 'name', COALESCE(NULLIF(btrim(pr.full_name), ''), sp.employee_id),
                                 'employee_id', sp.employee_id,
                                 'department', sp.department) ORDER BY COALESCE(NULLIF(btrim(pr.full_name), ''), sp.employee_id))
                              FROM public.staff_profiles sp
                              LEFT JOIN public.profiles pr ON pr.id = sp.user_id
                             WHERE pr.deleted_at IS NULL), '[]'::jsonb));
END $$;

-- ── Function privileges ────────────────────────────────────────────────────────────────────────────
-- CREATE OR REPLACE keeps the existing grants on the replaced functions; the new ones are owner-only internals.
REVOKE ALL ON FUNCTION public._asset_register_guard_site() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._asset_register_category_code(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._asset_register_make_tag(text, text, text) FROM PUBLIC, anon, authenticated;

RESET lock_timeout;
