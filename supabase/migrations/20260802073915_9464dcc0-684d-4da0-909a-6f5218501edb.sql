-- 1) Tighten the linking rule: the platform grants EVERY user the 'agent' role and
--    default agent_capabilities, so those signals cannot distinguish a recruited
--    sub-agent from a tenant the agent registered. Require real agent evidence.
CREATE OR REPLACE FUNCTION public.link_referred_agent_to_parent(p_sub_agent_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_referrer uuid;
BEGIN
  IF p_sub_agent_id IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT referrer_id INTO v_referrer
  FROM public.profiles
  WHERE id = p_sub_agent_id;

  IF v_referrer IS NULL OR v_referrer = p_sub_agent_id THEN
    RETURN FALSE;
  END IF;

  IF EXISTS (SELECT 1 FROM public.agent_subagents WHERE sub_agent_id = p_sub_agent_id) THEN
    RETURN FALSE;
  END IF;

  -- Parent must hold the agent role.
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = v_referrer AND role = 'agent' AND COALESCE(enabled, TRUE)
  ) THEN
    RETURN FALSE;
  END IF;

  -- The recruit must show EXPLICIT agent intent / activity. The default
  -- 'agent' role and default capabilities are deliberately NOT accepted.
  IF NOT (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_sub_agent_id AND p.primary_persona = 'agent')
    OR EXISTS (SELECT 1 FROM public.house_listings h WHERE h.agent_id = p_sub_agent_id)
    OR EXISTS (SELECT 1 FROM public.agent_collections c WHERE c.agent_id = p_sub_agent_id)
    OR EXISTS (SELECT 1 FROM public.agent_earnings e WHERE e.agent_id = p_sub_agent_id)
    OR EXISTS (SELECT 1 FROM public.rent_requests r WHERE r.agent_id = p_sub_agent_id)
  ) THEN
    RETURN FALSE;
  END IF;

  INSERT INTO public.agent_subagents (parent_agent_id, sub_agent_id, source, status, verified_at)
  VALUES (v_referrer, p_sub_agent_id, 'referral_link', 'verified', now())
  ON CONFLICT (sub_agent_id) DO NOTHING;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.link_referred_agent_to_parent(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_referred_agent_to_parent(uuid) TO service_role;

-- 2) Clean up the bad links created by the 2026-08-01 referral backfill.
DO $$
DECLARE
  v_deleted int;
  v_kept int;
BEGIN
  CREATE TEMP TABLE _keep_links ON COMMIT DROP AS
  SELECT s.sub_agent_id
  FROM public.agent_subagents s
  WHERE s.source IN ('referral_link_backfill', 'referral_link')
    AND (
      EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = s.sub_agent_id AND p.primary_persona = 'agent')
      OR EXISTS (SELECT 1 FROM public.house_listings h WHERE h.agent_id = s.sub_agent_id)
      OR EXISTS (SELECT 1 FROM public.agent_collections c WHERE c.agent_id = s.sub_agent_id)
      OR EXISTS (SELECT 1 FROM public.agent_earnings e WHERE e.agent_id = s.sub_agent_id)
      OR EXISTS (SELECT 1 FROM public.rent_requests r WHERE r.agent_id = s.sub_agent_id)
    );

  DELETE FROM public.agent_subagents s
  WHERE s.source IN ('referral_link_backfill', 'referral_link')
    AND s.sub_agent_id NOT IN (SELECT sub_agent_id FROM _keep_links);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  UPDATE public.agent_subagents s
  SET source = 'referral_link'
  WHERE s.source = 'referral_link_backfill';
  GET DIAGNOSTICS v_kept = ROW_COUNT;

  INSERT INTO public.system_events (event_type, metadata)
  VALUES (
    'role_changed',
    jsonb_build_object(
      'description', 'Sub-agent list cleanup: removed referral links that were tenants/funders, not recruited agents',
      'incident', 'SUBAGENT-REFERRAL-BACKFILL-2026-08-02',
      'links_deleted', v_deleted,
      'links_kept_with_agent_activity', v_kept,
      'rule', 'default agent role + default agent_capabilities are no longer accepted as agent intent'
    )
  );
END $$;