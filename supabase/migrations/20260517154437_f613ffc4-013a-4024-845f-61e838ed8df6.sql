CREATE OR REPLACE FUNCTION public.get_business_advance_public_status(p_phone text)
RETURNS TABLE (
  id uuid,
  status text,
  business_name text,
  principal numeric,
  outstanding_balance numeric,
  reason text,
  agent_name text,
  created_at timestamptz,
  agent_ops_reviewed_at timestamptz,
  tenant_ops_reviewed_at timestamptz,
  landlord_ops_reviewed_at timestamptz,
  coo_approved_at timestamptz,
  cfo_disbursed_at timestamptz,
  disbursed_at timestamptz,
  completed_at timestamptz,
  rejection_reason text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH cleaned AS (
    SELECT regexp_replace(coalesce(p_phone,''), '\s', '', 'g') AS phone
  ), match AS (
    SELECT p.id
    FROM public.profiles p, cleaned c
    WHERE c.phone <> '' AND p.phone = c.phone
    LIMIT 1
  )
  SELECT
    ba.id,
    ba.status::text,
    ba.business_name,
    ba.principal,
    ba.outstanding_balance,
    ba.reason,
    ap.full_name AS agent_name,
    ba.created_at,
    ba.agent_ops_reviewed_at,
    ba.tenant_ops_reviewed_at,
    ba.landlord_ops_reviewed_at,
    ba.coo_approved_at,
    ba.cfo_disbursed_at,
    ba.disbursed_at,
    ba.completed_at,
    ba.rejection_reason
  FROM public.business_advances ba
  JOIN match m ON m.id = ba.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = ba.agent_id
  ORDER BY ba.created_at DESC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_business_advance_public_status(text) TO anon, authenticated;