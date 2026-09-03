-- Helper: are the protected verification/bonus columns unchanged from what is stored?
-- SECURITY DEFINER so the policy can read the stored row without recursing into RLS.
CREATE OR REPLACE FUNCTION public.house_listing_protected_unchanged(
  _id uuid,
  _verified boolean,
  _listing_bonus_paid boolean,
  _listed_bonus_paid boolean,
  _house_verified_bonus_paid boolean
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.house_listings h
    WHERE h.id = _id
      AND (
        h.verified IS DISTINCT FROM _verified
        OR h.listing_bonus_paid IS DISTINCT FROM _listing_bonus_paid
        OR h.listed_bonus_paid IS DISTINCT FROM _listed_bonus_paid
        OR h.house_verified_bonus_paid IS DISTINCT FROM _house_verified_bonus_paid
      )
  )
$$;

DROP POLICY IF EXISTS "Agents can update own listings" ON public.house_listings;
CREATE POLICY "Agents can update own listings"
ON public.house_listings
FOR UPDATE
TO authenticated
USING (auth.uid() = agent_id)
WITH CHECK (
  auth.uid() = agent_id
  AND public.house_listing_protected_unchanged(
        id, verified, listing_bonus_paid, listed_bonus_paid, house_verified_bonus_paid
      )
);

-- Helper: are the financial terms unchanged from what is stored?
CREATE OR REPLACE FUNCTION public.rent_request_financials_unchanged(
  _id uuid,
  _rent_amount numeric,
  _total_repayment numeric,
  _daily_repayment numeric,
  _amount_repaid numeric
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.rent_requests r
    WHERE r.id = _id
      AND (
        r.rent_amount IS DISTINCT FROM _rent_amount
        OR r.total_repayment IS DISTINCT FROM _total_repayment
        OR r.daily_repayment IS DISTINCT FROM _daily_repayment
        OR r.amount_repaid IS DISTINCT FROM _amount_repaid
      )
  )
$$;

DROP POLICY IF EXISTS "Agents can verify their requests" ON public.rent_requests;
CREATE POLICY "Agents can verify their requests"
ON public.rent_requests
FOR UPDATE
TO authenticated
USING (has_role(auth.uid(), 'agent'::app_role) AND agent_id = auth.uid())
WITH CHECK (
  has_role(auth.uid(), 'agent'::app_role)
  AND agent_id = auth.uid()
  AND status = ANY (ARRAY['pending','service_center_review','rejected','cancelled','deleted_by_agent','repaying'])
  AND public.rent_request_financials_unchanged(id, rent_amount, total_repayment, daily_repayment, amount_repaid)
);

DROP POLICY IF EXISTS "Agents can edit own rejected requests" ON public.rent_requests;
CREATE POLICY "Agents can edit own rejected requests"
ON public.rent_requests
FOR UPDATE
TO authenticated
USING (
  has_role(auth.uid(), 'agent'::app_role)
  AND agent_id = auth.uid()
  AND status = ANY (ARRAY['rejected','deleted_by_agent'])
)
WITH CHECK (
  has_role(auth.uid(), 'agent'::app_role)
  AND agent_id = auth.uid()
  AND public.rent_request_financials_unchanged(id, rent_amount, total_repayment, daily_repayment, amount_repaid)
);

DROP POLICY IF EXISTS "Agents and managers can verify unverified requests" ON public.rent_requests;
CREATE POLICY "Agents and managers can verify unverified requests"
ON public.rent_requests
FOR UPDATE
TO authenticated
USING (
  agent_verified = false
  AND status = ANY (ARRAY['pending','approved'])
  AND (
    has_role(auth.uid(), 'manager'::app_role)
    OR (
      (has_role(auth.uid(), 'agent'::app_role) OR has_role(auth.uid(), 'senior_agent'::app_role))
      AND (agent_id IS NULL OR agent_id = auth.uid() OR agent_verified_by = auth.uid())
    )
  )
)
WITH CHECK (
  has_role(auth.uid(), 'manager'::app_role)
  OR (
    (has_role(auth.uid(), 'agent'::app_role) OR has_role(auth.uid(), 'senior_agent'::app_role))
    AND status = ANY (ARRAY['pending','service_center_review','rejected','cancelled','deleted_by_agent','repaying'])
    AND public.rent_request_financials_unchanged(id, rent_amount, total_repayment, daily_repayment, amount_repaid)
  )
);