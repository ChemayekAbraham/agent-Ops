DO $mig$
DECLARE d text; o text; n text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
  WHERE ns.nspname='public' AND p.proname='get_agent_ops_comprehensive_report';
  IF d IS NULL THEN RAISE EXCEPTION 'function not found'; END IF;

  o := ' WITH rent_agents AS (
   SELECT DISTINCT COALESCE(assigned_agent_id,agent_id) agent_id FROM public.rent_requests WHERE COALESCE(assigned_agent_id,agent_id) IS NOT NULL
 ), sub_agents AS (
   SELECT DISTINCT sub_agent_id agent_id FROM public.agent_subagents WHERE sub_agent_id IS NOT NULL AND COALESCE(status,'''')<>''rejected''
 ), all_agents AS (
   SELECT agent_id FROM rent_agents UNION SELECT agent_id FROM sub_agents
 ),';
  n := ' WITH rent_agents AS (
   SELECT DISTINCT COALESCE(assigned_agent_id,agent_id) agent_id FROM public.rent_requests WHERE COALESCE(assigned_agent_id,agent_id) IS NOT NULL AND COALESCE(assigned_agent_id,agent_id)<>tenant_id
 ), collection_agents AS (
   SELECT DISTINCT agent_id FROM public.agent_collections WHERE agent_id IS NOT NULL
 ), sub_agents AS (
   SELECT DISTINCT sub_agent_id agent_id FROM public.agent_subagents WHERE sub_agent_id IS NOT NULL
 ), all_agents AS (
   SELECT agent_id FROM rent_agents UNION SELECT agent_id FROM collection_agents
 ),';
  IF position(o in d)=0 THEN RAISE EXCEPTION 'CTE block not matched'; END IF;
  d := replace(d,o,n);

  o := '''overview'',jsonb_build_object(''all_agents'',(SELECT count(*) FROM all_agents),''agents'',(SELECT count(*) FROM rent_agents),''sub_agents'',(SELECT count(*) FROM sub_agents),';
  n := '''overview'',jsonb_build_object(''all_agents'',(SELECT count(*) FROM all_agents),''agents'',(SELECT count(*) FROM collection_agents),''active_agents'',(SELECT count(*) FROM collection_agents),''sub_agents'',(SELECT count(*) FROM sub_agents),';
  IF position(o in d)=0 THEN RAISE EXCEPTION 'overview block not matched'; END IF;
  d := replace(d,o,n);

  EXECUTE d;
END
$mig$;