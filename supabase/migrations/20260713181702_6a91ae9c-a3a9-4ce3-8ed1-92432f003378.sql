DROP VIEW IF EXISTS public.landlords_directory;
CREATE VIEW public.landlords_directory
WITH (security_invoker = off) AS
  SELECT
    id, name, phone, property_address, description,
    latitude, longitude, location_captured_at,
    monthly_rent, desired_rent_from_welile,
    number_of_rooms, number_of_houses, house_category, house_number,
    verified, verified_at, verification_status, verification_reason,
    ready_to_receive, has_smartphone, is_occupied, is_agent_managed,
    managed_by_agent_id, registered_by, tenant_id,
    electricity_meter_number, water_meter_number,
    caretaker_name, caretaker_phone,
    country, region, district, county, sub_county, town_council, village, cell,
    created_at, updated_at
  FROM public.landlords;

GRANT SELECT ON public.landlords_directory TO authenticated;