DO $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN SELECT DISTINCT ca.agent_id FROM public.cashout_agents ca WHERE ca.agent_id IS NOT NULL LOOP
    PERFORM public.refresh_wallet_projection_for(r.agent_id);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'refreshed % merchant desk wallet projections', n;
END $$;