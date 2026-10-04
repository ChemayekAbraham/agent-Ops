-- Patch the 1-argument overload
DO $do$
DECLARE d text; n text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public' AND p.proname = 'get_agent_products_services_report' AND p.pronargs = 1;

  IF d IS NULL THEN RAISE EXCEPTION '1-arg function not found'; END IF;

  n := replace(d,
    'count(*) FILTER (WHERE s.status = ''pending'') AS pending_total',
    'count(*) FILTER (WHERE s.status = ''pending'') AS pending_total,
      count(*) FILTER (WHERE s.status = ''rejected'') AS rejected_count,
      COALESCE(sum(s.verified_amount) FILTER (WHERE s.status IN (''verified'',''approved'')), 0) AS approved_volume');

  n := replace(n,
    '''pending_total'', (SELECT pending_total FROM sc),',
    '''pending_total'', (SELECT pending_total FROM sc),
      ''rejected_count'', (SELECT rejected_count FROM sc),
      ''approved_volume'', (SELECT approved_volume FROM sc),');

  IF position('approved_volume' in n) = 0 OR n = d THEN
    RAISE EXCEPTION '1-arg patch failed';
  END IF;

  EXECUTE n;
END
$do$;

-- Patch the 2-argument overload
DO $do$
DECLARE d text; n text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public' AND p.proname = 'get_agent_products_services_report' AND p.pronargs = 2;

  IF d IS NULL THEN RAISE EXCEPTION '2-arg function not found'; END IF;

  n := replace(d,
    'count(*) FILTER (WHERE s.status = ''pending'' AND NOT s.is_test) AS pending_total',
    'count(*) FILTER (WHERE s.status = ''pending'' AND NOT s.is_test) AS pending_total,
      count(*) FILTER (WHERE s.status = ''rejected'' AND NOT s.is_test) AS rejected_count,
      COALESCE(sum(s.verified_amount) FILTER (WHERE s.status IN (''verified'',''approved'') AND NOT s.is_test), 0) AS approved_volume');

  n := replace(n,
    '''pending_total'', (SELECT pending_total FROM sc),',
    '''pending_total'', (SELECT pending_total FROM sc),
      ''rejected_count'', (SELECT rejected_count FROM sc),
      ''approved_volume'', (SELECT approved_volume FROM sc),');

  IF position('approved_volume' in n) = 0 OR n = d THEN
    RAISE EXCEPTION '2-arg patch failed';
  END IF;

  EXECUTE n;
END
$do$;

REVOKE ALL ON FUNCTION public.get_agent_products_services_report(date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_agent_products_services_report(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_agent_products_services_report(date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_agent_products_services_report(date, date) TO authenticated, service_role;
