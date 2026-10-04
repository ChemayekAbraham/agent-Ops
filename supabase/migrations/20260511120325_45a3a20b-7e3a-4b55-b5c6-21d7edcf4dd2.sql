CREATE OR REPLACE FUNCTION public.search_supporters(search_term text, result_limit integer DEFAULT 20)
RETURNS TABLE(id uuid, full_name text, phone text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT p.id, p.full_name, p.phone
  FROM public.profiles p
  WHERE (p.full_name ILIKE '%' || search_term || '%'
      OR p.phone ILIKE '%' || search_term || '%')
    -- Must have supporter role AND no other role
    AND EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = p.id AND ur.role = 'supporter'
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.user_roles ur2
      WHERE ur2.user_id = p.id AND ur2.role <> 'supporter'
    )
    -- Must own at least one portfolio
    AND EXISTS (
      SELECT 1 FROM public.investor_portfolios ip
      WHERE ip.investor_id = p.id
    )
  LIMIT result_limit;
$function$;