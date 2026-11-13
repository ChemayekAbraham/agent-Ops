import { describe, expect, it } from 'vitest';
import { signageGpsLocation } from '@/lib/signageGpsLocation';
import { mergeOfficialChain, normalizeAdminName, type OfficialChainRow } from '@/lib/signageOfficialLocation';

const entebbeOsm = {
  country_code: 'ug', amenity: 'Nkumba Primary School', road: 'Nkumba Road', village: 'Bendegere A',
  city_district: 'Kasenyi', city: 'Entebbe City', state: 'Central Region',
};
const gps = signageGpsLocation({ address: 'Nkumba Road, Bendegere A, Entebbe City', raw: { address: entebbeOsm } })!;
const row = (r: Partial<OfficialChainRow>): OfficialChainRow =>
  ({ village: null, parish: null, subcounty: null, county: null, district: null, ...r });
const none = { villages: [], parishes: [], counties: [] };

describe('official Uganda chain for signage GPS', () => {
  it('treats City / Municipality / Division / Ward / Cell words as the same place', () => {
    expect(normalizeAdminName('Entebbe City')).toBe('entebbe');
    expect(normalizeAdminName('Entebbe Municipality')).toBe('entebbe');
    expect(normalizeAdminName("Bendegere 'A' Cell")).toBe('bendegere a');
  });

  it('fills county, sub-county and parish from a matching official village in the same municipality', () => {
    const loc = mergeOfficialChain(gps, entebbeOsm, { ...none, villages: [
      row({ village: "Bendegere 'A'", parish: 'Kigungu', subcounty: 'Division B', county: 'Entebbe Municipality', district: 'Wakiso' }),
      // Same village name in another district must be ignored.
      row({ village: 'Bendegere A', parish: 'X', subcounty: 'Y', county: 'Busiro', district: 'Mpigi' }),
    ] });
    expect(loc).toMatchObject({
      district: 'Wakiso', county: 'Entebbe Municipality', subcounty: 'Division B', parish: 'Kigungu',
      village: "Bendegere 'A'", villageFound: true,
    });
  });

  it('falls back to the ward (parish) the geocoder named as the city division', () => {
    const loc = mergeOfficialChain(gps, entebbeOsm, { ...none, parishes: [
      row({ parish: 'Kasenyi', subcounty: 'Division B', county: 'Entebbe Municipality', district: 'Wakiso' }),
    ] });
    expect(loc).toMatchObject({ district: 'Wakiso', county: 'Entebbe Municipality', subcounty: 'Division B', parish: 'Kasenyi', village: 'Bendegere A' });
  });

  it('uses the municipality as the county when only that level matches', () => {
    const loc = mergeOfficialChain(gps, entebbeOsm, { ...none, counties: [
      row({ county: 'Entebbe Municipality', district: 'Wakiso' }),
      row({ county: 'Busiro', district: 'Wakiso' }),
    ] });
    expect(loc).toMatchObject({ district: 'Wakiso', county: 'Entebbe Municipality', subcounty: 'Kasenyi', parish: '', village: 'Bendegere A' });
  });

  it('leaves a level blank when candidates disagree, and changes nothing without a match', () => {
    const loc = mergeOfficialChain(gps, entebbeOsm, { ...none, villages: [
      row({ village: 'Bendegere A', parish: 'P1', subcounty: 'Division A', county: 'Entebbe Municipality', district: 'Wakiso' }),
      row({ village: 'Bendegere A', parish: 'P2', subcounty: 'Division B', county: 'Entebbe Municipality', district: 'Wakiso' }),
    ] });
    expect(loc).toMatchObject({ county: 'Entebbe Municipality', parish: '', subcounty: 'Kasenyi' });
    expect(mergeOfficialChain(gps, entebbeOsm, none)).toEqual(gps);
  });
});
