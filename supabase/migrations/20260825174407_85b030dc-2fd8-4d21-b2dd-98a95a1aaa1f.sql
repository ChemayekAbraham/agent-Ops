CREATE VIEW public.v_landlord_calling_base
WITH (security_invoker = true) AS
SELECT
  l.id AS landlord_id,
  l.name,
  l.phone,
  l.verified,
  l.has_smartphone,
  l.mobile_money_name,
  l.mobile_money_number,
  l.bank_name,
  l.account_number,
  l.caretaker_name,
  l.caretaker_phone,
  l.number_of_houses,
  l.monthly_rent,
  l.village,
  l.district,
  l.region,
  l.property_address,
  l.house_category,
  l.registered_by,
  l.managed_by_agent_id,
  l.created_at,
  COALESCE(h.houses, 0)::integer AS houses,
  COALESCE(h.occupied_houses, 0)::integer AS occupied_houses,
  COALESCE(h.empty_houses, 0)::integer AS empty_houses,
  COALESCE(h.verified_houses, 0)::integer AS verified_houses,
  COALESCE(h.houses_monthly_rent, 0)::numeric AS houses_monthly_rent,
  COALESCE(r.plans, 0)::integer AS plans,
  COALESCE(r.funded_plans, 0)::integer AS funded_plans,
  COALESCE(r.plan_rent_total, 0)::numeric AS plan_rent_total,
  r.last_plan_at,
  COALESCE(p.payout_count, 0)::integer AS payout_count,
  COALESCE(p.paid_total, 0)::numeric AS paid_total,
  p.last_paid_at
FROM public.landlords l
LEFT JOIN (
  SELECT
    landlord_id,
    count(*) AS houses,
    count(*) FILTER (WHERE tenant_id IS NOT NULL) AS occupied_houses,
    count(*) FILTER (WHERE tenant_id IS NULL) AS empty_houses,
    count(*) FILTER (WHERE verified) AS verified_houses,
    sum(COALESCE(monthly_rent, 0)) AS houses_monthly_rent
  FROM public.house_listings
  WHERE landlord_id IS NOT NULL
  GROUP BY landlord_id
) h ON h.landlord_id = l.id
LEFT JOIN (
  SELECT
    landlord_id,
    count(*) AS plans,
    count(*) FILTER (WHERE status IN ('funded', 'repaying', 'active')) AS funded_plans,
    sum(COALESCE(rent_amount, 0)) AS plan_rent_total,
    max(created_at) AS last_plan_at
  FROM public.rent_requests
  WHERE landlord_id IS NOT NULL
  GROUP BY landlord_id
) r ON r.landlord_id = l.id
LEFT JOIN (
  SELECT
    landlord_id,
    count(*) AS payout_count,
    sum(COALESCE(amount, 0)) AS paid_total,
    max(created_at) AS last_paid_at
  FROM public.agent_landlord_payouts
  WHERE landlord_id IS NOT NULL
  GROUP BY landlord_id
) p ON p.landlord_id = l.id;

GRANT SELECT ON public.v_landlord_calling_base TO authenticated;
GRANT SELECT ON public.v_landlord_calling_base TO service_role;