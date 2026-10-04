-- 1. Stop minting phantom self-pending proxy rows.
DROP TRIGGER IF EXISTS trg_ensure_supporter_pending_approval_ins ON public.user_roles;
DROP TRIGGER IF EXISTS trg_ensure_supporter_pending_approval_upd ON public.user_roles;
DROP FUNCTION IF EXISTS public.ensure_supporter_pending_approval();

-- 2a. Auto-approve self-pointing rows whose user is already verified.
UPDATE public.proxy_agent_assignments paa
SET approval_status = 'approved',
    is_active       = true,
    approved_at     = COALESCE(paa.approved_at, p.funder_verified_at)
FROM public.profiles p
WHERE paa.beneficiary_id = paa.agent_id
  AND paa.beneficiary_role = 'supporter'
  AND paa.approval_status = 'pending'
  AND p.id = paa.beneficiary_id
  AND p.funder_verified_at IS NOT NULL;

-- 2b. Drop the remaining self-pointing pending rows. They are not real
--     proxy delegations (a user cannot be their own proxy) and their
--     verification, when needed, lives on profiles.funder_verified_at.
DELETE FROM public.proxy_agent_assignments
WHERE beneficiary_id = agent_id
  AND beneficiary_role = 'supporter'
  AND approval_status = 'pending';

-- 3. is_funder_approved now respects profile verification too, matching
--    the (already-correct) get_funder_approval_status RPC. Without this,
--    any code path still calling is_funder_approved would block verified
--    self-registered funders.
CREATE OR REPLACE FUNCTION public.is_funder_approved(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = _user_id
        AND p.signup_source = 'funder-onboarding'
        AND p.funder_verified_at IS NOT NULL
    )
    OR EXISTS (
      SELECT 1
      FROM public.proxy_agent_assignments
      WHERE beneficiary_id = _user_id
        AND beneficiary_role = 'supporter'
        AND approval_status = 'approved'
        AND is_active = true
        AND beneficiary_id <> agent_id  -- exclude any leftover self-rows
    )
    OR EXISTS (
      -- Legacy / agent-onboarded supporters: the existence of a supporter
      -- role is sufficient (matches the RPC's "everyone else = approved"
      -- branch driven by signup_source).
      SELECT 1
      FROM public.user_roles ur
      JOIN public.profiles p ON p.id = ur.user_id
      WHERE ur.user_id = _user_id
        AND ur.role = 'supporter'
        AND (ur.enabled IS NULL OR ur.enabled = true)
        AND COALESCE(p.signup_source, '') <> 'funder-onboarding'
    );
$$;

GRANT EXECUTE ON FUNCTION public.is_funder_approved(uuid) TO authenticated;