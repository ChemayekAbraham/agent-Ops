-- Link a referred user to their recruiting agent whenever both sides qualify.
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

  -- Both sides must actually hold the agent role.
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = v_referrer AND role = 'agent' AND COALESCE(enabled, TRUE)
  ) OR NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = p_sub_agent_id AND role = 'agent' AND COALESCE(enabled, TRUE)
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

-- Trigger wrapper: fires from profiles (referrer arrives) and user_roles (agent role arrives).
CREATE OR REPLACE FUNCTION public.trg_link_referred_agent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    IF TG_TABLE_NAME = 'user_roles' THEN
      IF NEW.role = 'agent' AND COALESCE(NEW.enabled, TRUE) THEN
        PERFORM public.link_referred_agent_to_parent(NEW.user_id);
      END IF;
    ELSE
      IF NEW.referrer_id IS NOT NULL THEN
        PERFORM public.link_referred_agent_to_parent(NEW.id);
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'trg_link_referred_agent failed: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_link_referred_agent_profiles ON public.profiles;
CREATE TRIGGER zz_link_referred_agent_profiles
AFTER INSERT OR UPDATE OF referrer_id ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.trg_link_referred_agent();

DROP TRIGGER IF EXISTS zz_link_referred_agent_roles ON public.user_roles;
CREATE TRIGGER zz_link_referred_agent_roles
AFTER INSERT OR UPDATE OF enabled ON public.user_roles
FOR EACH ROW EXECUTE FUNCTION public.trg_link_referred_agent();

-- Backfill every historical recruit that never got a sub-agent row.
INSERT INTO public.agent_subagents (parent_agent_id, sub_agent_id, source, status, verified_at)
SELECT p.referrer_id, p.id, 'referral_link_backfill', 'verified', now()
FROM public.profiles p
WHERE p.referrer_id IS NOT NULL
  AND p.referrer_id <> p.id
  AND NOT EXISTS (SELECT 1 FROM public.agent_subagents s WHERE s.sub_agent_id = p.id)
  AND EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = p.referrer_id AND r.role = 'agent' AND COALESCE(r.enabled, TRUE))
  AND EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = p.id AND r.role = 'agent' AND COALESCE(r.enabled, TRUE))
ON CONFLICT (sub_agent_id) DO NOTHING;