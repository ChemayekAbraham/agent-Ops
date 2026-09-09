CREATE OR REPLACE FUNCTION public.bonus_restriction_config(p_category text)
 RETURNS TABLE(restricted boolean, condition text, hold_days integer)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT
    p_category = ANY(ARRAY[
      'agent_bonus','agent_listing_bonus','agent_listing_campaign_bonus',
      'tenant_placement_bonus','landlord_verification_bonus','landlord_referral_bonus',
      'lc1_verification_bonus','lc1_referral_bonus','recruiter_override'
    ]),
    CASE p_category
      WHEN 'agent_bonus'                    THEN 'listing_verified'
      WHEN 'agent_listing_bonus'            THEN 'listing_verified'
      WHEN 'agent_listing_campaign_bonus'   THEN 'listing_verified'
      WHEN 'tenant_placement_bonus'         THEN 'listing_verified_with_tenant'
      WHEN 'landlord_verification_bonus'    THEN 'landlord_verified'
      WHEN 'landlord_referral_bonus'        THEN 'landlord_verified'
      WHEN 'lc1_verification_bonus'         THEN 'lc1_verified'
      WHEN 'lc1_referral_bonus'             THEN 'lc1_verified'
      WHEN 'recruiter_override'             THEN 'subagent_productive'
      ELSE NULL
    END,
    3;
$function$;