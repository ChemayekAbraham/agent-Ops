// Column list for house_listings queries that may run for anonymous
// (logged-out) visitors. Third-party PII columns — caretaker_name,
// caretaker_phone, lc1_chairperson_name, lc1_chairperson_phone — are NOT
// granted to the `anon` role at the database level, so `select('*')` is
// rejected for logged-out users. Use this explicit list on any public /
// marketplace query. Authenticated, role-gated dashboards may keep using
// `select('*')` since they retain full table access.
export const PUBLIC_HOUSE_LISTING_COLUMNS =
  'id, landlord_id, agent_id, title, description, house_category, number_of_rooms, monthly_rent, daily_rate, access_fee, platform_fee, total_monthly_cost, region, district, sub_county, village, ug_village_id, address, latitude, longitude, has_water, has_electricity, has_security, has_parking, is_furnished, amenities, image_urls, status, tenant_id, landlord_accepted, verified, verified_by, verified_at, created_at, updated_at, geo_point, caretaker_user_id, is_agent_caretaker, landlord_has_smartphone, lc1_chairperson_village, listing_bonus_paid, listing_bonus_paid_at, video_url, short_code, placement_bonus_paid_at, is_hidden, listed_bonus_paid, listed_bonus_paid_at, reserved_by, reserved_at, suspended_tenant_id';
