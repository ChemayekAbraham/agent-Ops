
-- =========================================================================
-- 1. credit_request_details: scope supporter SELECT to funded requests only
-- =========================================================================
DROP POLICY IF EXISTS "Supporters can view credit requests" ON public.credit_request_details;

CREATE POLICY "Supporters can view funded credit requests"
ON public.credit_request_details
FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'supporter'::app_role)
  AND loan_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.rent_requests rr
    WHERE rr.id = credit_request_details.loan_id
      AND rr.supporter_id = auth.uid()
  )
);

-- =========================================================================
-- 2. payout_codes: scope agent SELECT to codes they are processing
-- =========================================================================
DROP POLICY IF EXISTS "Owners agents and managers can read payout_codes" ON public.payout_codes;

CREATE POLICY "Owners and assigned agents can read payout_codes"
ON public.payout_codes
FOR SELECT
TO authenticated
USING (
  -- Owner of the payout
  user_id = auth.uid()
  -- Agent who has already claimed / paid this code
  OR claimed_by = auth.uid()
  OR paid_by = auth.uid()
  -- Privileged operational roles
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'cfo'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  -- Agents may only read codes for withdrawals assigned to them
  OR (
    has_role(auth.uid(), 'agent'::app_role)
    AND EXISTS (
      SELECT 1
      FROM public.withdrawal_requests wr
      LEFT JOIN public.cashout_agents ca ON ca.id = wr.assigned_cashout_agent_id
      WHERE wr.id = payout_codes.withdrawal_request_id
        AND (
          wr.agent_id = auth.uid()
          OR ca.agent_id = auth.uid()
        )
    )
  )
);

-- Also tighten the UPDATE policy: only owner, assigned agent, or managers
DROP POLICY IF EXISTS "Agents can update payout_codes" ON public.payout_codes;

CREATE POLICY "Assigned agents and managers can update payout_codes"
ON public.payout_codes
FOR UPDATE
TO authenticated
USING (
  has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR (
    has_role(auth.uid(), 'agent'::app_role)
    AND EXISTS (
      SELECT 1
      FROM public.withdrawal_requests wr
      LEFT JOIN public.cashout_agents ca ON ca.id = wr.assigned_cashout_agent_id
      WHERE wr.id = payout_codes.withdrawal_request_id
        AND (
          wr.agent_id = auth.uid()
          OR ca.agent_id = auth.uid()
        )
    )
  )
);

-- =========================================================================
-- 3. location_requests: require token header on anonymous UPDATE
-- =========================================================================
DROP POLICY IF EXISTS "Public can update pending by token" ON public.location_requests;

CREATE POLICY "Public can update pending with matching token header"
ON public.location_requests
FOR UPDATE
TO anon, authenticated
USING (
  status = 'pending'
  AND token IS NOT NULL
  AND token::text = nullif(
    current_setting('request.headers', true)::json ->> 'x-location-token',
    ''
  )
)
WITH CHECK (
  status = 'captured'
  AND latitude IS NOT NULL
  AND longitude IS NOT NULL
  AND token IS NOT NULL
  AND token::text = nullif(
    current_setting('request.headers', true)::json ->> 'x-location-token',
    ''
  )
);

-- =========================================================================
-- 4. supporter_invites: wipe temp_password on activation
-- =========================================================================
CREATE OR REPLACE FUNCTION public.wipe_supporter_invite_temp_password()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- The moment activated_at is set, clear the plaintext temporary password.
  IF NEW.activated_at IS NOT NULL THEN
    NEW.temp_password := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wipe_supporter_invite_temp_password ON public.supporter_invites;
CREATE TRIGGER trg_wipe_supporter_invite_temp_password
BEFORE INSERT OR UPDATE OF activated_at, temp_password
ON public.supporter_invites
FOR EACH ROW
EXECUTE FUNCTION public.wipe_supporter_invite_temp_password();

-- Clear historical activated rows that still carry a plaintext password.
UPDATE public.supporter_invites
SET temp_password = NULL
WHERE activated_at IS NOT NULL
  AND temp_password IS NOT NULL;
