CREATE OR REPLACE FUNCTION public.agent_product_category(p_item_name text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_name text := coalesce(trim(p_item_name), '');
BEGIN
  IF v_name = '' THEN RETURN 'boutique'; END IF;
  IF v_name ~* '(bike|boda|motor|spiro|cycle)' THEN RETURN 'motor_bike'; END IF;
  IF v_name ~* '(phone|smartphone|tablet|handset)' THEN RETURN 'smart_phone'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.smartphone_catalog c
    WHERE v_name ILIKE '%' || c.brand || '%' || c.model_name || '%'
       OR v_name ILIKE '%' || c.brand || ' ' || c.model_name || '%'
       OR v_name ILIKE c.brand || '%'
  ) THEN
    RETURN 'smart_phone';
  END IF;
  IF v_name ~* '(signage|sign board|shop board|board|banner|poster|sticker|billboard|branding)' THEN RETURN 'signage'; END IF;
  RETURN 'boutique';
END
$function$;