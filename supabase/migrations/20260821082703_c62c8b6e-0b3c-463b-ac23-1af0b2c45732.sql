CREATE OR REPLACE FUNCTION public.admin_purge_user_dependencies(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- 2. Break every remaining blocking reference to this user's profile OR to the
  --    auth.users row itself: reassign to NULL where the column is nullable,
  --    otherwise remove the dependent row (and recursively its own children).
  FOR rec IN
    SELECT DISTINCT cl.relname AS child_table,
           catt.attname AS child_column,
           (catt.attnotnull = false) AS nullable
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_class pcl ON pcl.oid = con.confrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    JOIN pg_namespace pns ON pns.oid = pcl.relnamespace
    JOIN pg_attribute catt ON catt.attrelid = con.conrelid AND catt.attnum = con.conkey[1]
    WHERE con.contype = 'f'
      AND ns.nspname = 'public'
      AND con.confdeltype IN ('a', 'r')
      AND array_length(con.conkey, 1) = 1
      AND (
        (pns.nspname = 'public' AND pcl.relname = 'profiles')
        OR (pns.nspname = 'auth' AND pcl.relname = 'users')
      )
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
$function$;