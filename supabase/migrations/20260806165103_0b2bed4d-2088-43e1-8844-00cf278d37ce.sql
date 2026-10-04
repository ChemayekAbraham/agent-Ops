CREATE OR REPLACE FUNCTION public.funder_supported_tenants()
RETURNS TABLE (
  rent_request_id uuid,
  tenant_id uuid,
  tenant_name text,
  tenant_avatar_url text,
  tenant_phone text,
  tenant_address text,
  city text,
  house_category text,
  rent_amount numeric,
  duration_days integer,
  status text,
  funded_at timestamptz,
  created_at timestamptz,
  funding_mode text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT rr.id,
         rr.tenant_id,
         COALESCE(p.full_name, 'Tenant'),
         COALESCE(p.avatar_url, rr.tenant_photo_url),
         p.phone,
         NULLIF(btrim(concat_ws(', ',
           NULLIF(p.village,''), NULLIF(p.parish,''), NULLIF(p.sub_county,''),
           NULLIF(p.district,''), NULLIF(COALESCE(p.city, rr.request_city),'')
         )), ''),
         COALESCE(rr.request_city, p.city),
         rr.house_category,
         rr.rent_amount,
         rr.duration_days,
         rr.status,
         rr.funded_at,
         rr.created_at,
         CASE WHEN rr.self_funding_partner_id = auth.uid() THEN 'self_managed' ELSE 'managed' END
  FROM public.rent_requests rr
  LEFT JOIN public.profiles p ON p.id = rr.tenant_id
  WHERE auth.uid() IS NOT NULL
    AND (rr.supporter_id = auth.uid() OR rr.self_funding_partner_id = auth.uid())
  ORDER BY COALESCE(rr.funded_at, rr.created_at) DESC;
$$;

GRANT EXECUTE ON FUNCTION public.funder_supported_tenants() TO authenticated;