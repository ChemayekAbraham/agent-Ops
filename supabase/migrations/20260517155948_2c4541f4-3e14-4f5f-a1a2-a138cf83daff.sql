CREATE OR REPLACE FUNCTION public.get_business_advance_audit_log(
  p_advance_id uuid,
  p_phone text DEFAULT NULL
)
RETURNS TABLE(
  stage text,
  label text,
  occurred_at timestamptz,
  actor_id uuid,
  actor_name text,
  actor_role text,
  notes text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  adv public.business_advances%ROWTYPE;
  v_caller uuid := auth.uid();
  v_norm_phone text;
  v_tenant_phone text;
  v_allowed boolean := false;
BEGIN
  SELECT * INTO adv FROM public.business_advances WHERE id = p_advance_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- Auth: tenant themselves
  IF v_caller IS NOT NULL AND v_caller = adv.tenant_id THEN
    v_allowed := true;
  -- Auth: agent who filed it
  ELSIF v_caller IS NOT NULL AND v_caller = adv.agent_id THEN
    v_allowed := true;
  -- Auth: staff / managers
  ELSIF v_caller IS NOT NULL AND (
    public.has_role(v_caller, 'manager') OR
    public.has_role(v_caller, 'cfo') OR
    public.has_role(v_caller, 'coo') OR
    public.has_role(v_caller, 'agent_ops') OR
    public.has_role(v_caller, 'tenant_ops') OR
    public.has_role(v_caller, 'landlord_ops') OR
    public.has_role(v_caller, 'financial_ops')
  ) THEN
    v_allowed := true;
  -- Public: phone match against tenant profile
  ELSIF p_phone IS NOT NULL THEN
    v_norm_phone := regexp_replace(p_phone, '[^0-9]', '', 'g');
    SELECT regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g')
      INTO v_tenant_phone
    FROM public.profiles WHERE id = adv.tenant_id;
    IF v_tenant_phone IS NOT NULL AND length(v_norm_phone) >= 9
       AND right(v_tenant_phone, 9) = right(v_norm_phone, 9) THEN
      v_allowed := true;
    END IF;
  END IF;

  IF NOT v_allowed THEN RETURN; END IF;

  RETURN QUERY
  WITH rows AS (
    SELECT 'submitted'::text     AS stage, 'Submitted'::text                 AS label, adv.created_at              AS occurred_at, adv.agent_id              AS actor_id, 'agent'::text         AS actor_role, NULL::text AS notes
    UNION ALL SELECT 'agent_ops',     'Reviewed by Agent Ops',     adv.agent_ops_reviewed_at,    adv.agent_ops_reviewed_by,    'agent_ops',     adv.agent_ops_notes
    UNION ALL SELECT 'tenant_ops',    'Reviewed by Tenant Ops',    adv.tenant_ops_reviewed_at,   adv.tenant_ops_reviewed_by,   'tenant_ops',    adv.tenant_ops_notes
    UNION ALL SELECT 'landlord_ops',  'Reviewed by Landlord Ops',  adv.landlord_ops_reviewed_at, adv.landlord_ops_reviewed_by, 'landlord_ops',  adv.landlord_ops_notes
    UNION ALL SELECT 'coo',           'Approved by COO',           adv.coo_approved_at,          adv.coo_approved_by,          'coo',           adv.coo_notes
    UNION ALL SELECT 'cfo_disbursed', 'Disbursed by CFO',          adv.cfo_disbursed_at,         adv.cfo_disbursed_by,         'cfo',           adv.cfo_notes
    UNION ALL SELECT 'rejected',      'Rejected',                  CASE WHEN adv.status = 'rejected' THEN COALESCE(adv.coo_approved_at, adv.landlord_ops_reviewed_at, adv.tenant_ops_reviewed_at, adv.agent_ops_reviewed_at) END, NULL::uuid, 'system', adv.rejection_reason
    UNION ALL SELECT 'completed',     'Fully repaid',              adv.completed_at,             NULL::uuid,                   'system',        NULL
  )
  SELECT r.stage, r.label, r.occurred_at, r.actor_id,
         COALESCE(p.full_name, CASE WHEN r.actor_id IS NULL THEN 'System' ELSE 'Welile staff' END) AS actor_name,
         r.actor_role,
         r.notes
  FROM rows r
  LEFT JOIN public.profiles p ON p.id = r.actor_id
  WHERE r.occurred_at IS NOT NULL
  ORDER BY r.occurred_at ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_business_advance_audit_log(uuid, text) TO anon, authenticated;