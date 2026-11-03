CREATE OR REPLACE FUNCTION public.public_support_plan(p_plan_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_plan public.v_partner_self_fundable_plans%ROWTYPE;
  v_monthly numeric;
BEGIN
  -- Read-only public lookup for shared Support Plan links. Returns ONLY
  -- whitelisted safe fields: house photo, city/area, tenant first name,
  -- support amount, 15% monthly earning, 12-month total, funding status.
  -- Never returns phones, full names, IDs, GPS, agent or wallet data.
  SELECT p.*
  INTO v_plan
  FROM public.v_partner_self_fundable_plans p
  WHERE p.rent_request_id = p_plan_id
    AND p.held_by IS NULL
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'unavailable');
  END IF;

  v_monthly := ROUND(COALESCE(v_plan.funding_amount, 0) * 0.15);

  RETURN jsonb_build_object(
    'status', 'available',
    'plan_id', v_plan.rent_request_id,
    'photo_url', CASE
      WHEN v_plan.house_image_urls IS NOT NULL AND array_length(v_plan.house_image_urls, 1) > 0
      THEN v_plan.house_image_urls[1]
      ELSE NULL
    END,
    'city', v_plan.request_city,
    'house_category', v_plan.house_category,
    'tenant_first_name', v_plan.tenant_first_name,
    'funding_amount', v_plan.funding_amount,
    'monthly_return', v_monthly,
    'twelve_month_total', v_monthly * 12
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.public_support_plan(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.public_support_plan(uuid) TO authenticated;