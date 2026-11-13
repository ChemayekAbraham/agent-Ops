import { describe, expect, it } from 'vitest';
import { signageGpsLocation } from '@/lib/signageGpsLocation';
import { mergeOfficialChain, normalizeAdminName, placeTokens, searchTokens, type OfficialChainRow } from '@/lib/signageOfficialLocation';

// Real OpenStreetMap answer for 0.095902, 32.505238 (Nkumba Primary School).
const nkumbaOsm = {
  country_code: 'ug', amenity: 'Nkumba Primary School', road: 'Nkumba Road', village: 'Bendegere A',
  city_district: 'Kasenyi', city: 'Entebbe City', state: 'Central Region',
};
const gps = signageGpsLocation({ address: 'Nkumba Road, Bendegere A, Entebbe City', raw: { address: nkumbaOsm } })!;
const ward = (village: string): OfficialChainRow => ({
  village, parish: 'NKUMBA WARD', subcounty: 'Katabi Town Council', county: 'Busiro County South', district: 'Wakiso',
});
// Real rows the dataset returns in Wakiso for the keywords bendegere / kasenyi / nkumba.
const nkumbaRows = ['ABAITA ABABIRI', 'BUFULU', 'KITINDA', 'NKUMBA BENDEGERE', 'NKUMBA BUKOLWA', 'NKUMBA CENTRAL'].map(ward);

describe('official Uganda chain for signage GPS (municipal structure)', () => {
  it('reduces place names to distinctive keywords', () => {
    expect(normalizeAdminName('Entebbe City')).toBe(normalizeAdminName('Entebbe Municipality'));
    expect(placeTokens('Nkumba Primary School')).toEqual(['nkumba']);
    expect(placeTokens('Katabi Town Council')).toEqual(['katabi']);
    expect(searchTokens(nkumbaOsm).sort()).toEqual(['bendegere', 'kasenyi', 'nkumba']);
  });

  it('places Nkumba in its official cell, ward, town council and county, not the city OSM named', () => {
    expect(mergeOfficialChain(gps, nkumbaOsm, { districts: ['Wakiso'], villages: nkumbaRows })).toMatchObject({
      district: 'Wakiso', county: 'Busiro County South', subcounty: 'Katabi Town Council',
      parish: 'NKUMBA WARD', village: 'NKUMBA BENDEGERE',
    });
  });

  it('fills ward and above but keeps the GPS village when only the ward matches', () => {
    const osm = { ...nkumbaOsm, village: 'Somewhere New' };
    const loc = signageGpsLocation({ address: 'x', raw: { address: osm } })!;
    expect(mergeOfficialChain(loc, osm, { districts: ['Wakiso'], villages: nkumbaRows.filter((r) => r.village !== 'NKUMBA BENDEGERE') }))
      .toMatchObject({ county: 'Busiro County South', subcounty: 'Katabi Town Council', parish: 'NKUMBA WARD', village: 'Somewhere New' });
  });

  it('maps a division and ward inside a municipality (Entebbe Division B, Kigungu)', () => {
    const osm = { country_code: 'ug', village: 'Kigungu', city: 'Entebbe City', road: 'Kigungu Road' };
    const loc = signageGpsLocation({ address: 'x', raw: { address: osm } })!;
    const rows: OfficialChainRow[] = [
      { village: 'KIGUNGU LANDING SITE', parish: 'KIGUNGU', subcounty: 'Division B', county: 'Entebbe Municipality', district: 'Wakiso' },
      { village: 'MAWALA', parish: 'KIGUNGU', subcounty: 'Division B', county: 'Entebbe Municipality', district: 'Wakiso' },
    ];
    expect(mergeOfficialChain(loc, osm, { districts: ['Wakiso'], villages: rows })).toMatchObject({
      district: 'Wakiso', county: 'Entebbe Municipality', subcounty: 'Division B', parish: 'KIGUNGU',
    });
  });

  it('never guesses County from the city name alone, and ignores rows from other districts', () => {
    const elsewhere: OfficialChainRow = { village: 'BENDEGERE', parish: 'Namusaale', subcounty: 'Kapeeka', county: 'Nakaseke South County', district: 'Nakaseke' };
    const loc = mergeOfficialChain(gps, nkumbaOsm, { districts: ['Wakiso'], villages: [elsewhere] });
    expect(loc).toMatchObject({ district: 'Wakiso', county: '', parish: '', village: 'Bendegere A' });
  });

  it('leaves a level blank when the best matches disagree, and changes nothing without data', () => {
    const tie: OfficialChainRow[] = [
      { ...ward('BENDEGERE I'), parish: 'P1' },
      { ...ward('BENDEGERE II'), parish: 'P2' },
    ];
    expect(mergeOfficialChain(gps, nkumbaOsm, { districts: ['Wakiso'], villages: tie }))
      .toMatchObject({ county: 'Busiro County South', subcounty: 'Katabi Town Council', parish: '' });
    expect(mergeOfficialChain(gps, nkumbaOsm, { districts: [], villages: [] })).toEqual(gps);
  });
});
