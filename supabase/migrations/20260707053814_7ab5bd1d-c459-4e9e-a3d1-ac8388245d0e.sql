CREATE OR REPLACE FUNCTION public.get_agent_listing_eligibility(p_user_id uuid DEFAULT auth.uid())
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'user_id', p_user_id,
    'has_referral',        EXISTS (SELECT 1 FROM public.referrals        WHERE referrer_id = p_user_id),
    'referral_count',      (SELECT count(*) FROM public.referrals        WHERE referrer_id = p_user_id),
    'has_rent_request',    EXISTS (SELECT 1 FROM public.rent_requests    WHERE agent_id = p_user_id),
    'rent_request_count',  (SELECT count(*) FROM public.rent_requests    WHERE agent_id = p_user_id),
    'has_collection',      EXISTS (SELECT 1 FROM public.agent_collections WHERE agent_id = p_user_id),
    'collection_count',    (SELECT count(*) FROM public.agent_collections WHERE agent_id = p_user_id),
    'is_privileged',       EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_user_id AND role::text IN ('manager','super_admin','coo','cfo','ceo','operations')),
    'eligible', (
      EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_user_id AND role::text IN ('manager','super_admin','coo','cfo','ceo','operations'))
      OR (
        EXISTS (SELECT 1 FROM public.referrals        WHERE referrer_id = p_user_id)
        AND EXISTS (SELECT 1 FROM public.rent_requests    WHERE agent_id = p_user_id)
        AND EXISTS (SELECT 1 FROM public.agent_collections WHERE agent_id = p_user_id)
      )
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_listing_eligibility(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_agent_listing_eligibility(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.enforce_agent_listing_eligibility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_elig jsonb;
BEGIN
  -- Only gate self-service agent listings. System (service_role → auth.uid() null)
  -- and on-behalf inserts (ops creating for another agent) are not gated here.
  IF v_uid IS NULL OR NEW.agent_id IS NULL OR NEW.agent_id <> v_uid THEN
    RETURN NEW;
  END IF;

  v_elig := public.get_agent_listing_eligibility(v_uid);

  IF COALESCE((v_elig->>'eligible')::boolean, false) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'AGENT_LISTING_INELIGIBLE: To list a house you must have (1) referred at least one user, (2) posted at least one tenant rent request, and (3) recorded at least one rent repayment.'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_agent_listing_eligibility ON public.house_listings;
CREATE TRIGGER trg_enforce_agent_listing_eligibility
  BEFORE INSERT ON public.house_listings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_agent_listing_eligibility();