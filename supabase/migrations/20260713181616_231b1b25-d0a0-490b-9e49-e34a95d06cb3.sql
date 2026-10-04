CREATE OR REPLACE FUNCTION public.user_can_access_landlord(_landlord_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM public.landlords l
      WHERE l.id = _landlord_id
        AND (l.managed_by_agent_id = _user_id
             OR l.registered_by = _user_id
             OR l.tenant_id = _user_id
             OR l.verified_by = _user_id)
    )
    OR EXISTS (
      SELECT 1 FROM public.agent_landlord_assignments a
      WHERE a.landlord_id = _landlord_id AND a.agent_id = _user_id
    )
    OR EXISTS (
      SELECT 1 FROM public.rent_requests r
      WHERE r.landlord_id = _landlord_id
        AND (r.agent_id = _user_id OR r.assigned_agent_id = _user_id)
    );
$$;

CREATE OR REPLACE FUNCTION public.agent_can_view_trust(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM public.rent_requests r
      WHERE r.tenant_id = _user_id
        AND (r.agent_id = auth.uid() OR r.assigned_agent_id = auth.uid())
    )
    OR EXISTS (
      SELECT 1 FROM public.referrals rf
      WHERE rf.referred_id = _user_id AND rf.referrer_id = auth.uid()
    );
$$;

DROP POLICY IF EXISTS "Users and staff can read trust cache" ON public.welile_trust_score_cache;

CREATE POLICY "Users and staff can read trust cache"
  ON public.welile_trust_score_cache FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
    OR has_role(auth.uid(), 'ceo'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'cfo'::app_role)
    OR has_role(auth.uid(), 'employee'::app_role)
    OR has_role(auth.uid(), 'operations'::app_role)
    OR (has_role(auth.uid(), 'agent'::app_role) AND public.agent_can_view_trust(user_id))
  );