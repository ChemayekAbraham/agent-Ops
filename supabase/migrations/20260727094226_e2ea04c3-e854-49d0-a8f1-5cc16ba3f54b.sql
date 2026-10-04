CREATE OR REPLACE VIEW public.agent_advance_requests_privileged AS
SELECT aar.id,
    aar.agent_id,
    aar.principal,
    aar.cycle_days,
    aar.monthly_rate,
    aar.access_fee,
    aar.registration_fee,
    aar.total_payable,
    aar.daily_payment,
    aar.reason,
    aar.status,
    aar.reviewed_by_agent_ops,
    aar.agent_ops_reviewed_at,
    aar.agent_ops_notes,
    aar.reviewed_by_tenant_ops,
    aar.tenant_ops_reviewed_at,
    aar.tenant_ops_notes,
    aar.reviewed_by_landlord_ops,
    aar.landlord_ops_reviewed_at,
    aar.landlord_ops_notes,
    aar.approved_by_coo,
    aar.coo_approved_at,
    aar.coo_notes,
    aar.paid_by_cfo,
    aar.cfo_paid_at,
    aar.cfo_adjusted_rate,
    aar.cfo_notes,
    aar.rejection_reason,
    aar.created_at,
    aar.updated_at,
    aar.cfo_approved_by,
    aar.cfo_approved_at,
    p.full_name AS agent_full_name,
    p.phone AS agent_phone,
    p.region AS agent_region,
    p.district AS agent_district,
    p.sub_county AS agent_sub_county,
    p.parish AS agent_parish,
    p.village AS agent_village,
    p.city AS agent_city
FROM agent_advance_requests aar
LEFT JOIN profiles p ON p.id = aar.agent_id
WHERE has_role(auth.uid(), 'super_admin'::app_role)
   OR has_role(auth.uid(), 'manager'::app_role)
   OR has_role(auth.uid(), 'cfo'::app_role)
   OR has_role(auth.uid(), 'coo'::app_role)
   OR (EXISTS (
        SELECT 1 FROM staff_permissions sp
        WHERE sp.user_id = auth.uid()
          AND sp.permitted_dashboard = ANY (ARRAY['agent-ops','tenant-ops','landlord-ops','financial-ops','company-ops'])
   ));

GRANT SELECT ON public.agent_advance_requests_privileged TO authenticated;