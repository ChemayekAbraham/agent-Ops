/**
 * Approximate bounding boxes for African countries.
 *
 * Empty-house listings carry coordinates but no country column, so a country
 * filter is expressed as a geographic box: the map viewport is narrowed to the
 * box (so the database only aggregates houses inside it) and list cards are
 * filtered by the same box. Boxes are generous by design — a listing that sits
 * just inside a neighbour's border is a far smaller problem than a funder
 * seeing an empty country.
 */
export interface CountryBounds {
  code: string;
  name: string;
  /** [southLat, westLng, northLat, eastLng] */
  bbox: [number, number, number, number];
}

export const AFRICA_COUNTRIES: CountryBounds[] = [
  { code: 'DZ', name: 'Algeria', bbox: [18.9, -8.7, 37.1, 12.0] },
  { code: 'AO', name: 'Angola', bbox: [-18.1, 11.6, -4.3, 24.1] },
  { code: 'BJ', name: 'Benin', bbox: [6.2, 0.7, 12.4, 3.9] },
  { code: 'BW', name: 'Botswana', bbox: [-26.9, 19.9, -17.7, 29.4] },
  { code: 'BF', name: 'Burkina Faso', bbox: [9.4, -5.6, 15.1, 2.4] },
  { code: 'BI', name: 'Burundi', bbox: [-4.5, 28.9, -2.3, 30.9] },
  { code: 'CM', name: 'Cameroon', bbox: [1.6, 8.4, 13.1, 16.2] },
  { code: 'CF', name: 'Central African Republic', bbox: [2.2, 14.4, 11.0, 27.5] },
  { code: 'TD', name: 'Chad', bbox: [7.4, 13.4, 23.5, 24.0] },
  { code: 'CG', name: 'Congo (Brazzaville)', bbox: [-5.1, 11.1, 3.7, 18.7] },
  { code: 'CD', name: 'Congo (DRC)', bbox: [-13.5, 12.2, 5.4, 31.3] },
  { code: 'CI', name: "Côte d'Ivoire", bbox: [4.3, -8.6, 10.7, -2.5] },
  { code: 'DJ', name: 'Djibouti', bbox: [10.9, 41.7, 12.7, 43.4] },
  { code: 'EG', name: 'Egypt', bbox: [22.0, 24.7, 31.7, 36.9] },
  { code: 'ER', name: 'Eritrea', bbox: [12.4, 36.4, 18.0, 43.1] },
  { code: 'SZ', name: 'Eswatini', bbox: [-27.3, 30.8, -25.7, 32.1] },
  { code: 'ET', name: 'Ethiopia', bbox: [3.4, 32.9, 14.9, 48.0] },
  { code: 'GA', name: 'Gabon', bbox: [-4.0, 8.7, 2.3, 14.5] },
  { code: 'GM', name: 'Gambia', bbox: [13.0, -16.9, 13.9, -13.7] },
  { code: 'GH', name: 'Ghana', bbox: [4.7, -3.3, 11.2, 1.2] },
  { code: 'GN', name: 'Guinea', bbox: [7.1, -15.1, 12.7, -7.6] },
  { code: 'GW', name: 'Guinea-Bissau', bbox: [10.8, -16.8, 12.7, -13.6] },
  { code: 'KE', name: 'Kenya', bbox: [-4.7, 33.9, 5.1, 41.9] },
  { code: 'LS', name: 'Lesotho', bbox: [-30.7, 27.0, -28.5, 29.5] },
  { code: 'LR', name: 'Liberia', bbox: [4.3, -11.5, 8.6, -7.3] },
  { code: 'LY', name: 'Libya', bbox: [19.5, 9.3, 33.2, 25.2] },
  { code: 'MG', name: 'Madagascar', bbox: [-25.7, 43.2, -11.9, 50.5] },
  { code: 'MW', name: 'Malawi', bbox: [-17.2, 32.6, -9.3, 36.0] },
  { code: 'ML', name: 'Mali', bbox: [10.1, -12.3, 25.0, 4.3] },
  { code: 'MR', name: 'Mauritania', bbox: [14.7, -17.1, 27.3, -4.8] },
  { code: 'MA', name: 'Morocco', bbox: [27.6, -13.2, 35.9, -1.0] },
  { code: 'MZ', name: 'Mozambique', bbox: [-26.9, 30.2, -10.5, 40.9] },
  { code: 'NA', name: 'Namibia', bbox: [-28.9, 11.7, -16.9, 25.3] },
  { code: 'NE', name: 'Niger', bbox: [11.7, 0.2, 23.5, 16.0] },
  { code: 'NG', name: 'Nigeria', bbox: [4.2, 2.7, 13.9, 14.7] },
  { code: 'RW', name: 'Rwanda', bbox: [-2.9, 28.8, -1.0, 30.9] },
  { code: 'SN', name: 'Senegal', bbox: [12.3, -17.6, 16.7, -11.3] },
  { code: 'SL', name: 'Sierra Leone', bbox: [6.9, -13.4, 10.0, -10.2] },
  { code: 'SO', name: 'Somalia', bbox: [-1.7, 40.9, 12.0, 51.4] },
  { code: 'ZA', name: 'South Africa', bbox: [-35.0, 16.4, -22.1, 33.0] },
  { code: 'SS', name: 'South Sudan', bbox: [3.4, 23.4, 12.3, 36.0] },
  { code: 'SD', name: 'Sudan', bbox: [8.6, 21.8, 22.2, 38.6] },
  { code: 'TZ', name: 'Tanzania', bbox: [-11.8, 29.3, -0.9, 40.5] },
  { code: 'TG', name: 'Togo', bbox: [6.1, -0.2, 11.2, 1.8] },
  { code: 'TN', name: 'Tunisia', bbox: [30.2, 7.5, 37.6, 11.6] },
  { code: 'UG', name: 'Uganda', bbox: [-1.6, 29.4, 4.4, 35.1] },
  { code: 'ZM', name: 'Zambia', bbox: [-18.1, 21.9, -8.2, 33.7] },
  { code: 'ZW', name: 'Zimbabwe', bbox: [-22.5, 25.2, -15.5, 33.1] },
];

const BY_CODE = new Map(AFRICA_COUNTRIES.map((c) => [c.code, c]));

export const countryByCode = (code: string | null | undefined): CountryBounds | null =>
  code ? BY_CODE.get(code) ?? null : null;

export const pointInCountry = (
  country: CountryBounds,
  lat: number | null | undefined,
  lng: number | null | undefined,
): boolean => {
  const y = Number(lat);
  const x = Number(lng);
  if (!Number.isFinite(y) || !Number.isFinite(x)) return false;
  const [south, west, north, east] = country.bbox;
  return y >= south && y <= north && x >= west && x <= east;
};
