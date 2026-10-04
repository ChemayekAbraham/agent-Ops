-- Close public (anonymous) exposure of third-party PII columns on house_listings.
-- Anonymous visitors can still browse available listings, but no longer receive
-- caretaker / LC1 chairperson contact details. Authenticated (role-gated) staff
-- retain full access via their existing table-level grant.
REVOKE SELECT ON public.house_listings FROM anon;
GRANT SELECT (
  id, landlord_id, agent_id, title, description, house_category, number_of_rooms,
  monthly_rent, daily_rate, access_fee, platform_fee, total_monthly_cost, region,
  district, sub_county, village, address, latitude, longitude, has_water,
  has_electricity, has_security, has_parking, is_furnished, amenities, image_urls,
  status, tenant_id, landlord_accepted, verified, verified_by, verified_at,
  created_at, updated_at, geo_point, caretaker_user_id, is_agent_caretaker,
  landlord_has_smartphone, lc1_chairperson_village, listing_bonus_paid,
  listing_bonus_paid_at, video_url, short_code, placement_bonus_paid_at, is_hidden,
  listed_bonus_paid, listed_bonus_paid_at, reserved_by, reserved_at, suspended_tenant_id
) ON public.house_listings TO anon;