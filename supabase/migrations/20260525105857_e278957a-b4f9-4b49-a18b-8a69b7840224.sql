CREATE OR REPLACE FUNCTION public.extract_public_schema_sql()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_out text := '';
  v_caller uuid := auth.uid();
  v_allowed boolean;
  r record;
  v_cols text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = v_caller
      AND role::text IN ('cto','manager','super_admin')
  ) INTO v_allowed;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'forbidden: CTO role required';
  END IF;

  v_out := v_out || '-- Welile public schema export' || E'\n';
  v_out := v_out || '-- Generated: ' || now()::text || E'\n\n';

  v_out := v_out || '-- ============ ENUMS ============' || E'\n';
  FOR r IN
    SELECT t.typname,
           string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) AS labels
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    GROUP BY t.typname
    ORDER BY t.typname
  LOOP
    v_out := v_out || format('CREATE TYPE public.%I AS ENUM (%s);', r.typname, r.labels) || E'\n';
  END LOOP;
  v_out := v_out || E'\n';

  v_out := v_out || '-- ============ TABLES ============' || E'\n';
  FOR r IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
    ORDER BY c.relname
  LOOP
    SELECT string_agg(
      format('  %I %s%s%s',
        a.attname,
        pg_catalog.format_type(a.atttypid, a.atttypmod),
        CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END,
        COALESCE(' DEFAULT ' || pg_get_expr(ad.adbin, ad.adrelid), '')
      ),
      E',\n'
      ORDER BY a.attnum
    )
    INTO v_cols
    FROM pg_attribute a
    LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE a.attrelid = ('public.' || quote_ident(r.table_name))::regclass
      AND a.attnum > 0
      AND NOT a.attisdropped;

    v_out := v_out || format('-- ---- %s ----', r.table_name) || E'\n';
    v_out := v_out || format('CREATE TABLE IF NOT EXISTS public.%I (', r.table_name) || E'\n';
    v_out := v_out || COALESCE(v_cols, '') || E'\n);' || E'\n\n';
  END LOOP;

  v_out := v_out || '-- ============ CONSTRAINTS ============' || E'\n';
  FOR r IN
    SELECT
      c.conrelid::regclass::text AS tbl,
      c.conname,
      pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'public'
    ORDER BY c.conrelid::regclass::text, c.conname
  LOOP
    v_out := v_out || format('ALTER TABLE %s ADD CONSTRAINT %I %s;',
      r.tbl, r.conname, r.def) || E'\n';
  END LOOP;
  v_out := v_out || E'\n';

  v_out := v_out || '-- ============ INDEXES ============' || E'\n';
  FOR r IN
    SELECT indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname NOT IN (
        SELECT conname FROM pg_constraint WHERE contype IN ('p','u','x')
      )
    ORDER BY tablename, indexname
  LOOP
    v_out := v_out || r.indexdef || ';' || E'\n';
  END LOOP;
  v_out := v_out || E'\n';

  v_out := v_out || '-- ============ RLS POLICIES ============' || E'\n';
  FOR r IN
    SELECT
      schemaname, tablename, policyname, permissive, roles, cmd,
      qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
    ORDER BY tablename, policyname
  LOOP
    v_out := v_out || format(
      'CREATE POLICY %I ON public.%I AS %s FOR %s TO %s%s%s;',
      r.policyname, r.tablename, r.permissive, r.cmd,
      array_to_string(r.roles, ', '),
      COALESCE(' USING (' || r.qual || ')', ''),
      COALESCE(' WITH CHECK (' || r.with_check || ')', '')
    ) || E'\n';
  END LOOP;
  v_out := v_out || E'\n';

  v_out := v_out || '-- ============ TRIGGERS ============' || E'\n';
  FOR r IN
    SELECT pg_get_triggerdef(t.oid, true) AS def
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND NOT t.tgisinternal
    ORDER BY c.relname, t.tgname
  LOOP
    v_out := v_out || r.def || ';' || E'\n';
  END LOOP;
  v_out := v_out || E'\n';

  v_out := v_out || '-- ============ FUNCTIONS ============' || E'\n';
  FOR r IN
    SELECT pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
    ORDER BY p.proname
  LOOP
    v_out := v_out || r.def || E';\n\n';
  END LOOP;

  RETURN v_out;
END;
$fn$;

REVOKE ALL ON FUNCTION public.extract_public_schema_sql() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.extract_public_schema_sql() TO authenticated;