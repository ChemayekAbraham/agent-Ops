CREATE OR REPLACE FUNCTION public.agent_product_category(p_item_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN coalesce(p_item_name,'') = '' THEN 'boutique'
    WHEN p_item_name ~* '(bike|boda|motor|spiro|cycle)' THEN 'motor_bike'
    WHEN p_item_name ~* '(phone|smartphone|tablet|handset)' THEN 'smart_phone'
    WHEN p_item_name ~* '(signage|sign board|shop board|board|banner|poster|sticker|billboard|branding)' THEN 'signage'
    ELSE 'boutique'
  END
$$;

GRANT EXECUTE ON FUNCTION public.agent_product_category(text) TO authenticated, service_role;