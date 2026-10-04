DO $mig$
DECLARE
  src text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO src
  FROM pg_proc WHERE proname = 'get_agent_service_center' AND pronamespace = 'public'::regnamespace;

  IF position('''name'', pr.full_name,' IN src) = 0 THEN
    RAISE EXCEPTION 'name projection not found - aborting';
  END IF;

  src := replace(
    src,
    '''name'', pr.full_name,',
    '''name'', COALESCE(NULLIF(btrim(pr.full_name), ''''), u.email, ''Sub-agent (profile missing)''),
        ''avatar_url'', pr.avatar_url,
        ''agent_tier'', pr.agent_tier,
        ''nested_subagents'', COALESCE(ns.cnt, 0),
        ''wallet'', jsonb_build_object(
          ''withdrawable'', COALESCE(w.withdrawable_balance, 0),
          ''float'', COALESCE(w.float_balance, 0),
          ''advance'', COALESCE(w.advance_balance, 0)
        ),'
  );

  src := replace(
    src,
    'LEFT JOIN public.profiles pr ON pr.id = k.sub_agent_id',
    'LEFT JOIN public.profiles pr ON pr.id = k.sub_agent_id
  LEFT JOIN auth.users u ON u.id = k.sub_agent_id
  LEFT JOIN public.wallets w ON w.user_id = k.sub_agent_id
  LEFT JOIN (
    SELECT ns2.parent_agent_id, COUNT(*)::int AS cnt
    FROM public.agent_subagents ns2
    WHERE ns2.status = ''verified''
    GROUP BY ns2.parent_agent_id
  ) ns ON ns.parent_agent_id = k.sub_agent_id'
  );

  src := replace(src, 'ORDER BY pr.full_name NULLS LAST', 'ORDER BY COALESCE(pr.full_name, u.email) NULLS LAST');

  EXECUTE src;
END
$mig$;

INSERT INTO public.profiles (id, full_name, email)
SELECT u.id,
       NULLIF(btrim(COALESCE(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', '')), ''),
       u.email
FROM auth.users u
JOIN public.agent_subagents s ON s.sub_agent_id = u.id
WHERE s.status IN ('verified','pending_acceptance')
  AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id)
ON CONFLICT (id) DO NOTHING;