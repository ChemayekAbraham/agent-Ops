-- Let a referral attach to someone who already had an account.
--
-- THE GAP
-- `profiles.referrer_id` was only ever written during sign-up, through auth
-- metadata. `tenant-self-onboarding` then reads attribution ONLY from that
-- column - deliberately, so an agent id supplied by the browser cannot move a
-- tenant into someone else's portfolio.
--
-- The consequence: send a referral link to somebody who already has a Welile
-- account and they sign IN rather than UP. referrer_id is never written, the
-- onboarding function finds nothing, and the rent request lands with no agent.
-- The link was right, the agent was right, and the attribution was lost anyway
-- (Timothy Christian Waniaye, 2026-09-14).
--
-- THE FIX, without weakening the rule
-- The browser is still not trusted. It may only ASK, via this function, and
-- every condition is checked server-side against the caller's own identity:
--
--   * the caller may only set their OWN referrer (auth.uid(), never a
--     parameter), so nobody can attribute somebody else's tenant;
--   * first touch wins - it writes only when referrer_id IS NULL, so an
--     existing attribution can never be overwritten or stolen later;
--   * no self-referral;
--   * the referrer must exist, not be frozen, and hold an ENABLED agent role -
--     the same three tests tenant-self-onboarding applies before it will use
--     an attribution.
--
-- It returns quietly rather than raising when the claim is not allowed: this
-- is called on page load and a failed claim must never block onboarding.

CREATE OR REPLACE FUNCTION public.claim_tenant_referrer(p_referrer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_current uuid;
  v_ok boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_signed_in');
  END IF;
  IF p_referrer_id IS NULL OR p_referrer_id = v_uid THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'invalid_referrer');
  END IF;

  SELECT referrer_id INTO v_current FROM public.profiles WHERE id = v_uid;
  IF v_current IS NOT NULL THEN
    -- First touch wins. Never move an existing attribution.
    RETURN jsonb_build_object('claimed', false, 'reason', 'already_attributed');
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.profiles rp
      JOIN public.user_roles ur
        ON ur.user_id = rp.id AND ur.role = 'agent'::app_role AND ur.enabled = true
     WHERE rp.id = p_referrer_id
       AND COALESCE(rp.is_frozen, false) = false
  ) INTO v_ok;

  IF NOT v_ok THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'referrer_not_an_active_agent');
  END IF;

  UPDATE public.profiles SET referrer_id = p_referrer_id WHERE id = v_uid AND referrer_id IS NULL;

  RETURN jsonb_build_object('claimed', true, 'referrer_id', p_referrer_id);
END;
$function$;

COMMENT ON FUNCTION public.claim_tenant_referrer(uuid) IS
  'Attaches a referring agent to the CALLER''s own profile when they have none. '
  'Used when a referral link is opened by someone who already had an account, so signup metadata never carried the referrer. '
  'First touch wins; the referrer must be a live, unfrozen, enabled agent.';

GRANT EXECUTE ON FUNCTION public.claim_tenant_referrer(uuid) TO authenticated;
