DROP FUNCTION IF EXISTS public.funder_supported_tenants();

CREATE OR REPLACE FUNCTION public.funder_supported_tenants()
RETURNS TABLE(
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
  funded_at timestamp with time zone,
  created_at timestamp with time zone,
  funding_mode text,
  house_image_urls text[],
  landlord_name text,
  landlord_phone text,
  daily_repayment numeric,
  total_repayment numeric,
  amount_repaid numeric,
  village text,
  district text,
  listing_address text,
  agent_name text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
         CASE WHEN rr.self_funding_partner_id = auth.uid() THEN 'self_managed' ELSE 'managed' END,
         COALESCE(NULLIF(rr.house_image_urls, '{}'), hl.image_urls),
         lp.full_name,
         lp.phone,
         rr.daily_repayment,
         rr.total_repayment,
         rr.amount_repaid,
         COALESCE(NULLIF(hl.village,''), NULLIF(p.village,'')),
         COALESCE(NULLIF(hl.district,''), NULLIF(p.district,'')),
         NULLIF(hl.address,''),
         ap.full_name
  FROM public.rent_requests rr
  LEFT JOIN public.profiles p ON p.id = rr.tenant_id
  LEFT JOIN public.house_listings hl ON hl.id = rr.house_listing_id
  LEFT JOIN public.profiles lp ON lp.id = rr.landlord_id
  LEFT JOIN public.profiles ap ON ap.id = rr.agent_id
  WHERE auth.uid() IS NOT NULL
    AND (rr.supporter_id = auth.uid() OR rr.self_funding_partner_id = auth.uid())
  ORDER BY COALESCE(rr.funded_at, rr.created_at) DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.funder_supported_tenants() TO authenticated;