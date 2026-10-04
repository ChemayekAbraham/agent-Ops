export interface UgandaLocation {
  name: string;
  region: string;
  latitude: number;
  longitude: number;
}

// Major Ugandan cities, municipalities and towns with approximate centre coordinates.
// Used by the tenant location picker when GPS is denied or unavailable.
export const UGANDA_LOCATIONS: UgandaLocation[] = [
  { name: 'Kampala', region: 'Central', latitude: 0.3476, longitude: 32.5825 },
  { name: 'Wakiso', region: 'Central', latitude: 0.4044, longitude: 32.4594 },
  { name: 'Entebbe', region: 'Central', latitude: 0.0512, longitude: 32.4637 },
  { name: 'Mukono', region: 'Central', latitude: 0.3536, longitude: 32.7553 },
  { name: 'Nansana', region: 'Central', latitude: 0.3667, longitude: 32.5247 },
  { name: 'Kira', region: 'Central', latitude: 0.4007, longitude: 32.6450 },
  { name: 'Masaka', region: 'Central', latitude: -0.3340, longitude: 31.7340 },
  { name: 'Mityana', region: 'Central', latitude: 0.4175, longitude: 32.0426 },
  { name: 'Mubende', region: 'Central', latitude: 0.5570, longitude: 31.3955 },
  { name: 'Luwero', region: 'Central', latitude: 0.8490, longitude: 32.4990 },
  { name: 'Jinja', region: 'Eastern', latitude: 0.4244, longitude: 33.2041 },
  { name: 'Mbale', region: 'Eastern', latitude: 1.0820, longitude: 34.1750 },
  { name: 'Iganga', region: 'Eastern', latitude: 0.6093, longitude: 33.4686 },
  { name: 'Soroti', region: 'Eastern', latitude: 1.7146, longitude: 33.6111 },
  { name: 'Tororo', region: 'Eastern', latitude: 0.6928, longitude: 34.1810 },
  { name: 'Busia', region: 'Eastern', latitude: 0.4663, longitude: 34.0920 },
  { name: 'Kumi', region: 'Eastern', latitude: 1.4877, longitude: 33.9360 },
  { name: 'Mbarara', region: 'Western', latitude: -0.6072, longitude: 30.6545 },
  { name: 'Fort Portal', region: 'Western', latitude: 0.6710, longitude: 30.2750 },
  { name: 'Kabale', region: 'Western', latitude: -1.2410, longitude: 29.9856 },
  { name: 'Kasese', region: 'Western', latitude: 0.1833, longitude: 30.0833 },
  { name: 'Hoima', region: 'Western', latitude: 1.4350, longitude: 31.3520 },
  { name: 'Bushenyi', region: 'Western', latitude: -0.5417, longitude: 30.1869 },
  { name: 'Ntungamo', region: 'Western', latitude: -0.8794, longitude: 30.2641 },
  { name: 'Gulu', region: 'Northern', latitude: 2.7746, longitude: 32.2990 },
  { name: 'Lira', region: 'Northern', latitude: 2.2499, longitude: 32.8999 },
  { name: 'Arua', region: 'Northern', latitude: 3.0201, longitude: 30.9110 },
  { name: 'Kitgum', region: 'Northern', latitude: 3.2783, longitude: 32.8867 },
  { name: 'Moroto', region: 'Northern', latitude: 2.5347, longitude: 34.6667 },
];