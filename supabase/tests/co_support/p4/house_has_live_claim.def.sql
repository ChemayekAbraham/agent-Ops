CREATE OR REPLACE FUNCTION public.house_has_live_claim(p_house_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    -- 1. A funder picked it through the promissory-note flow.
    SELECT 1 FROM public.promissory_note_house_intents i
     WHERE i.house_id = p_house_id AND i.status IN ('reserved','funded')
    UNION ALL
    -- 2. A partner is self-supporting it.
    SELECT 1 FROM public.partner_supported_houses psh
     WHERE psh.house_id = p_house_id AND psh.status IN ('pending','active')
    UNION ALL
    -- 3. A company-managed portfolio claimed it.
    SELECT 1 FROM public.portfolio_allocations a
     WHERE a.house_id = p_house_id AND a.status IN ('reserved','fulfilled')
  );
$function$
