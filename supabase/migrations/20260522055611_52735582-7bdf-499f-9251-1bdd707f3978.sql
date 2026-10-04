UPDATE public.profiles
SET city = 'Kampala', country = COALESCE(country, 'Uganda')
WHERE id IN (
  SELECT DISTINCT r.tenant_id
  FROM public.rent_requests r
  WHERE r.agent_id = 'e3cf4d3a-d021-49e4-b815-7e1938166eeb'
);