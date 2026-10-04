CREATE OR REPLACE FUNCTION public.landlord_agreement_actor_can_view(p_landlord_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_ops_role(auth.uid())
    OR EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.enabled = true
        AND ur.role IN ('cfo', 'ceo', 'agent_ops', 'tenant_ops', 'landlord_ops', 'financial_ops', 'partner_ops')
    )
    OR EXISTS (
      SELECT 1 FROM public.landlords l
      WHERE l.id = p_landlord_id
        AND l.registered_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.borrower_landlord_id = p_landlord_id
        AND p.id = auth.uid()
    )
    OR EXISTS (
      SELECT 1
      FROM public.rent_requests rr
      WHERE rr.landlord_id = p_landlord_id
        AND (rr.agent_id = auth.uid() OR rr.assigned_agent_id = auth.uid())
    );
$$;

GRANT EXECUTE ON FUNCTION public.landlord_agreement_actor_can_view(uuid) TO authenticated;

DROP POLICY IF EXISTS "Authorized users can upload landlord agreement files" ON storage.objects;
CREATE POLICY "Authorized users can upload landlord agreement files"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'landlord-agreements'
    AND public.landlord_agreement_actor_can_view(NULLIF(split_part(name, '/', 1), '')::uuid)
  );

DROP POLICY IF EXISTS "Authorized users can view landlord agreement files" ON storage.objects;
CREATE POLICY "Authorized users can view landlord agreement files"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'landlord-agreements'
    AND public.landlord_agreement_actor_can_view(NULLIF(split_part(name, '/', 1), '')::uuid)
  );