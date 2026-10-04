
-- Tenant transfer audit table
CREATE TABLE public.tenant_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.profiles(id),
  from_agent_id uuid NOT NULL REFERENCES public.profiles(id),
  to_agent_id uuid NOT NULL REFERENCES public.profiles(id),
  transferred_by uuid NOT NULL REFERENCES public.profiles(id),
  reason text NOT NULL,
  flag_type text, -- 'no_visits', 'missed_payments', 'manual'
  rent_requests_updated int DEFAULT 0,
  subscriptions_updated int DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tenant_transfers ENABLE ROW LEVEL SECURITY;

-- Only managers/admins can view transfers
CREATE POLICY "Managers can view transfers"
  ON public.tenant_transfers FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'manager') OR
    public.has_role(auth.uid(), 'super_admin') OR
    public.has_role(auth.uid(), 'coo') OR
    public.has_role(auth.uid(), 'operations')
  );

-- RPC: get tenants flagged for transfer (no visits 14+ days OR 3+ consecutive failures)
CREATE OR REPLACE FUNCTION public.get_flagged_tenants_for_transfer()
RETURNS TABLE (
  tenant_id uuid,
  tenant_name text,
  tenant_phone text,
  agent_id uuid,
  agent_name text,
  flag_type text,
  last_visit_at timestamptz,
  accumulated_debt numeric,
  active_rent_requests bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH no_visits AS (
    SELECT DISTINCT ON (rr.tenant_id)
      rr.tenant_id,
      rr.agent_id,
      'no_visits' AS flag_type,
      av.last_visit,
      0::numeric AS debt
    FROM rent_requests rr
    LEFT JOIN LATERAL (
      SELECT MAX(checked_in_at) AS last_visit
      FROM agent_visits v
      WHERE v.agent_id = rr.agent_id AND v.tenant_id = rr.tenant_id
    ) av ON true
    WHERE rr.status IN ('approved', 'funded', 'active')
      AND rr.agent_id IS NOT NULL
      AND (av.last_visit IS NULL OR av.last_visit < now() - interval '14 days')
    ORDER BY rr.tenant_id, rr.created_at DESC
  ),
  missed_payments AS (
    SELECT DISTINCT ON (sc.tenant_id)
      sc.tenant_id,
      sc.agent_id,
      'missed_payments' AS flag_type,
      NULL::timestamptz AS last_visit,
      sc.accumulated_debt AS debt
    FROM subscription_charges sc
    WHERE sc.status = 'active'
      AND sc.agent_id IS NOT NULL
      AND sc.accumulated_debt >= (sc.charge_amount * 3)
    ORDER BY sc.tenant_id, sc.accumulated_debt DESC
  ),
  combined AS (
    SELECT * FROM no_visits
    UNION ALL
    SELECT * FROM missed_payments
  ),
  deduped AS (
    SELECT DISTINCT ON (tenant_id)
      tenant_id, agent_id, flag_type, last_visit, debt
    FROM combined
    ORDER BY tenant_id, debt DESC
  )
  SELECT
    d.tenant_id,
    tp.full_name AS tenant_name,
    tp.phone AS tenant_phone,
    d.agent_id,
    ap.full_name AS agent_name,
    d.flag_type,
    d.last_visit AS last_visit_at,
    d.debt AS accumulated_debt,
    (SELECT count(*) FROM rent_requests rr2 WHERE rr2.tenant_id = d.tenant_id AND rr2.agent_id = d.agent_id AND rr2.status IN ('approved','funded','active','pending')) AS active_rent_requests
  FROM deduped d
  JOIN profiles tp ON tp.id = d.tenant_id
  JOIN profiles ap ON ap.id = d.agent_id
  -- Exclude tenants already transferred in last 30 days
  WHERE NOT EXISTS (
    SELECT 1 FROM tenant_transfers tt
    WHERE tt.tenant_id = d.tenant_id AND tt.created_at > now() - interval '30 days'
  );
$$;
