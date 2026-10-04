-- One-click safe account deletion: dynamically detect and clear blocking FK
-- dependents (ledger + rent_request children, and profile references) so that
-- deleting the auth user no longer fails with "Database error deleting user".

-- Recursive helper: removes every row that blocks deletion of rows in
-- p_parent_table whose primary key is in p_parent_pk_values, by walking
-- NO ACTION / RESTRICT foreign keys depth-first (grandchildren first).
CREATE OR REPLACE FUNCTION public.admin_purge_table_refs(
  p_parent_table text,
  p_parent_pk_values uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec record;
  v_child_ids uuid[];
  v_total integer := 0;
  v_n integer;
BEGIN
  IF p_parent_pk_values IS NULL OR array_length(p_parent_pk_values, 1) IS NULL THEN
    RETURN 0;
  END IF;

  FOR rec IN
    SELECT cl.relname AS child_table,
           catt.attname AS child_column
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_class pcl ON pcl.oid = con.confrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    JOIN pg_attribute catt ON catt.attrelid = con.conrelid AND catt.attnum = con.conkey[1]
    WHERE con.contype = 'f'
      AND ns.nspname = 'public'
      AND pcl.relname = p_parent_table
      AND con.confdeltype IN ('a', 'r')        -- NO ACTION / RESTRICT (the blocking ones)
      AND array_length(con.conkey, 1) = 1
  LOOP
    -- Collect this child's own ids so we can recurse into grandchildren first.
    BEGIN
      EXECUTE format('SELECT array_agg(id) FROM public.%I WHERE %I = ANY($1)',
                     rec.child_table, rec.child_column)
        INTO v_child_ids USING p_parent_pk_values;
    EXCEPTION WHEN undefined_column THEN
      v_child_ids := NULL;
    END;

    IF v_child_ids IS NOT NULL THEN
      v_total := v_total + public.admin_purge_table_refs(rec.child_table, v_child_ids);
    END IF;

    EXECUTE format('DELETE FROM public.%I WHERE %I = ANY($1)',
                   rec.child_table, rec.child_column)
      USING p_parent_pk_values;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_total := v_total + v_n;
  END LOOP;

  RETURN v_total;
END;
$$;

-- Main entry point: prepares a user for hard deletion by clearing everything
-- that would otherwise block the auth.users cascade.
CREATE OR REPLACE FUNCTION public.admin_purge_user_dependencies(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rent_ids uuid[];
  rec record;
  v_n integer;
  v_ids uuid[];
  v_rent_children integer := 0;
  v_profile_reassigned integer := 0;
  v_profile_deleted integer := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;

  -- 1. rent_requests where the user is the tenant cascade-delete with the auth
  --    user; proactively remove their blocking ledger/children rows first.
  SELECT array_agg(id) INTO v_rent_ids
  FROM public.rent_requests
  WHERE tenant_id = p_user_id;

  IF v_rent_ids IS NOT NULL THEN
    v_rent_children := public.admin_purge_table_refs('rent_requests', v_rent_ids);
  END IF;

  -- 2. Break every remaining blocking reference to this user's profile:
  --    reassign to NULL where the column is nullable, otherwise remove the
  --    dependent row (and recursively its own blocking children).
  FOR rec IN
    SELECT cl.relname AS child_table,
           catt.attname AS child_column,
           (catt.attnotnull = false) AS nullable
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_class pcl ON pcl.oid = con.confrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    JOIN pg_attribute catt ON catt.attrelid = con.conrelid AND catt.attnum = con.conkey[1]
    WHERE con.contype = 'f'
      AND ns.nspname = 'public'
      AND pcl.relname = 'profiles'
      AND con.confdeltype IN ('a', 'r')
      AND array_length(con.conkey, 1) = 1
  LOOP
    IF rec.nullable THEN
      EXECUTE format('UPDATE public.%I SET %I = NULL WHERE %I = $1',
                     rec.child_table, rec.child_column, rec.child_column)
        USING p_user_id;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_profile_reassigned := v_profile_reassigned + v_n;
    ELSE
      BEGIN
        EXECUTE format('SELECT array_agg(id) FROM public.%I WHERE %I = $1',
                       rec.child_table, rec.child_column)
          INTO v_ids USING p_user_id;
      EXCEPTION WHEN undefined_column THEN
        v_ids := NULL;
      END;

      IF v_ids IS NOT NULL THEN
        v_profile_deleted := v_profile_deleted + public.admin_purge_table_refs(rec.child_table, v_ids);
      END IF;

      EXECUTE format('DELETE FROM public.%I WHERE %I = $1',
                     rec.child_table, rec.child_column)
        USING p_user_id;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_profile_deleted := v_profile_deleted + v_n;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'rent_requests', coalesce(array_length(v_rent_ids, 1), 0),
    'rent_request_children_removed', v_rent_children,
    'profile_refs_reassigned', v_profile_reassigned,
    'profile_dependents_removed', v_profile_deleted
  );
END;
$$;

-- Lock down: only the service role (used by the delete-user edge function) may run these.
REVOKE ALL ON FUNCTION public.admin_purge_table_refs(text, uuid[]) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_purge_user_dependencies(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_purge_table_refs(text, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_purge_user_dependencies(uuid) TO service_role;