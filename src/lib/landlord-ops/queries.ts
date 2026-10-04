// Shared selectors and row shapes for the Landlord Ops dashboard.
// Kept as one constant so the four house_listings fetches in
// LandlordOpsDashboard.tsx (primary, pending, global search, date-range)
// stay identical — one place to add/remove a column.

/**
 * Superset of every field consumed by the four dashboard queries.
 * Includes the full nested landlord relationship.
 */
export const HOUSE_LISTING_SELECT = `
  id, title, house_category, monthly_rent, daily_rate, number_of_rooms, address, district, village, region,
  latitude, longitude, image_urls, lc1_chairperson_name, lc1_chairperson_phone, lc1_chairperson_village,
  agent_id, landlord_id, tenant_id, verified, listing_bonus_paid, created_at, status, is_hidden,
  service_center_status, service_center_comment, service_center_reviewed_at,
  landlords(
    id, name, phone, verified, mobile_money_name, mobile_money_number, has_smartphone,
    number_of_houses, bank_name, account_number, monthly_rent,
    caretaker_name, caretaker_phone, tin, electricity_meter_number, water_meter_number,
    village, district, region
  )
`;

export interface RawHouseListing {
  id: string;
  title: string | null;
  house_category: string | null;
  monthly_rent: number | null;
  daily_rate: number | null;
  number_of_rooms: number | null;
  address: string | null;
  district: string | null;
  village: string | null;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
  image_urls: string[] | null;
  lc1_chairperson_name: string | null;
  lc1_chairperson_phone: string | null;
  lc1_chairperson_village: string | null;
  agent_id: string | null;
  landlord_id: string | null;
  tenant_id: string | null;
  verified: boolean | null;
  listing_bonus_paid: boolean | null;
  created_at: string;
  status: string | null;
  is_hidden: boolean | null;
  /** Service Centre manager's mandatory vetting comment — shown to Ops on the card. */
  service_center_status?: string | null;
  service_center_comment?: string | null;
  service_center_reviewed_at?: string | null;
  landlords: {
    id: string;
    name: string | null;
    phone: string | null;
    verified: boolean | null;
    mobile_money_name: string | null;
    mobile_money_number: string | null;
    has_smartphone: boolean | null;
    number_of_houses: number | null;
    bank_name: string | null;
    account_number: string | null;
    monthly_rent: number | null;
    caretaker_name: string | null;
    caretaker_phone: string | null;
    tin: string | null;
    electricity_meter_number: string | null;
    water_meter_number: string | null;
    village: string | null;
    district: string | null;
    region: string | null;
  } | null;
}

export interface EnrichedHouseListing extends RawHouseListing {
  agent_name: string | null;
  agent_phone: string | null;
  agent_email: string | null;
  tenant_name: string | null;
  tenant_phone: string | null;
}
