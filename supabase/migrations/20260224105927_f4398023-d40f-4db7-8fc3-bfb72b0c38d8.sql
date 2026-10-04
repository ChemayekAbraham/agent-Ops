
-- ============================================================
-- FIX 1: landlords - Remove USING (true) policy
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users can view landlords" ON public.landlords;

CREATE POLICY "Agents can view relevant landlords" ON public.landlords
  FOR SELECT USING (
    has_role(auth.uid(), 'agent'::app_role)
    AND (
      managed_by_agent_id = auth.uid()
      OR registered_by = auth.uid()
      OR tenant_id IN (
        SELECT rr.tenant_id FROM rent_requests rr WHERE rr.agent_id = auth.uid()
      )
    )
  );

CREATE POLICY "Managers can view all landlords" ON public.landlords
  FOR SELECT USING (has_role(auth.uid(), 'manager'::app_role));

CREATE POLICY "Managers can update landlords" ON public.landlords
  FOR UPDATE USING (has_role(auth.uid(), 'manager'::app_role));

CREATE POLICY "Agents can update managed landlords" ON public.landlords
  FOR UPDATE USING (
    has_role(auth.uid(), 'agent'::app_role)
    AND (managed_by_agent_id = auth.uid() OR registered_by = auth.uid())
  );

-- ============================================================
-- FIX 2: profiles - Restrict agent and supporter access
-- ============================================================
DROP POLICY IF EXISTS "Agents can view all profiles" ON public.profiles;
DROP POLICY IF EXISTS "Supporters can view all profiles" ON public.profiles;

CREATE POLICY "Agents can view managed profiles" ON public.profiles
  FOR SELECT USING (
    has_role(auth.uid(), 'agent'::app_role)
    AND (
      referrer_id = auth.uid()
      OR id IN (SELECT rr.tenant_id FROM rent_requests rr WHERE rr.agent_id = auth.uid())
    )
  );

CREATE POLICY "Supporters can view funded tenant profiles" ON public.profiles
  FOR SELECT USING (
    is_supporter()
    AND id IN (SELECT rr.tenant_id FROM rent_requests rr WHERE rr.supporter_id = auth.uid())
  );

-- ============================================================
-- FIX 3: rent_requests - Restrict supporter access
-- ============================================================
DROP POLICY IF EXISTS "Supporters view all rent requests" ON public.rent_requests;

CREATE POLICY "Supporters view funded or available requests" ON public.rent_requests
  FOR SELECT USING (
    is_supporter()
    AND (
      supporter_id = auth.uid()
      OR (status = 'approved' AND funded_at IS NULL)
    )
  );

-- ============================================================
-- FIX 4: credit_request_details - Restrict agent access
-- ============================================================
DROP POLICY IF EXISTS "Agents can view credit requests" ON public.credit_request_details;
DROP POLICY IF EXISTS "Agents can verify credit requests" ON public.credit_request_details;

CREATE POLICY "Agents can view assigned credit requests" ON public.credit_request_details
  FOR SELECT USING (
    has_role(auth.uid(), 'agent'::app_role)
    AND agent_id = auth.uid()
  );

CREATE POLICY "Agents can verify assigned credit requests" ON public.credit_request_details
  FOR UPDATE USING (
    has_role(auth.uid(), 'agent'::app_role)
    AND agent_id = auth.uid()
  );

-- ============================================================
-- FIX 5: supporter_invites - Restrict agent access after activation
-- ============================================================
DROP POLICY IF EXISTS "Agents can view own invites" ON public.supporter_invites;

CREATE POLICY "Agents can view own pending invites" ON public.supporter_invites
  FOR SELECT USING (
    auth.uid() = created_by
    AND activated_at IS NULL
  );
