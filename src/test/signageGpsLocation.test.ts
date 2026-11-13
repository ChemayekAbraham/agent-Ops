import { describe, expect, it } from 'vitest';
import { signageGpsLocation, bigDataCloudToReverse, resolvedSignageVillage } from '@/lib/signageGpsLocation';

describe('signage GPS address mapping', () => {
  it('uses only returned Uganda address components without inventing optional levels', () => {
    expect(signageGpsLocation({ address: 'Jinja Road, Naguru', raw: { address: {
      country_code: 'ug', county: 'Kampala', suburb: 'Naguru', road: 'Jinja Road', state: 'Central Region',
    } } })).toEqual({ district: 'Kampala', county: '', subcounty: '', parish: '', village: 'Naguru', address: 'Jinja Road, Naguru', villageFound: true, landmarkFound: true });
  });
  it('blocks missing district and failed lookups but keeps a district-only result for typing', () => {
    expect(signageGpsLocation(null)).toBeNull();
    expect(signageGpsLocation({ address: 'Uganda', raw: { address: { country_code: 'ug', state: 'Central Region' } } })).toBeNull();
    expect(signageGpsLocation({ address: 'Kampala', raw: { address: { country_code: 'ug', county: 'Kampala' } } }))
      .toMatchObject({ district: 'Kampala', village: '', villageFound: false, landmarkFound: false });
  });
  it('does not treat a location outside Uganda as a signage address', () => {
    expect(signageGpsLocation({ address: 'Nairobi', raw: { address: { country_code: 'ke', county: 'Nairobi', suburb: 'Westlands' } } })).toBeNull();
  });
  it('fills village from road when no locality is returned, but still asks the agent to confirm it', () => {
    const loc = signageGpsLocation({ address: 'x', raw: { address: { country_code: 'ug', county: 'Wakiso', road: 'Entebbe Road' } } });
    expect(loc?.village).toBe('Entebbe Road');
    expect(loc?.villageFound).toBe(false);
    expect(loc?.landmarkFound).toBe(true);
  });
  it('maps backup geocoder district and locality', () => {
    const r = bigDataCloudToReverse({ countryCode: 'UG', locality: 'Kireka', localityInfo: { administrative: [{ name: 'Uganda' }, { name: 'Wakiso District' }] } });
    expect(signageGpsLocation(r)).toMatchObject({ district: 'Wakiso', village: 'Kireka', villageFound: true });
  });
  it('treats a Ugandan city as the district when OpenStreetMap returns no district (Entebbe)', () => {
    expect(signageGpsLocation({ address: 'Nkumba Road, Bendegere A, Entebbe City', raw: { address: {
      country_code: 'ug', amenity: 'Nkumba Primary School', road: 'Nkumba Road', village: 'Bendegere A',
      city_district: 'Kasenyi', city: 'Entebbe City', state: 'Central Region',
    } } })).toMatchObject({ district: 'Entebbe City', subcounty: 'Kasenyi', village: 'Bendegere A', villageFound: true });
  });
  it('maps the backup geocoder city response without using the region (Entebbe)', () => {
    const r = bigDataCloudToReverse({
      countryCode: 'UG', principalSubdivision: 'Central', city: 'Entebbe', locality: 'Entebbe',
      localityInfo: { administrative: [
        { name: 'Uganda', description: 'country in East Africa', adminLevel: 2 },
        { name: 'Central', description: 'region of Uganda', adminLevel: 3 },
        { name: 'Entebbe', description: 'city in Uganda', adminLevel: 4 },
        { name: 'Kasenyi', adminLevel: 9 },
      ] },
    });
    expect(signageGpsLocation(r)).toMatchObject({ district: 'Entebbe', subcounty: 'Kasenyi', village: 'Kasenyi', villageFound: true });
  });
});

describe('village actually saved', () => {
  const found = signageGpsLocation({ address: 'Jinja Road, Naguru', raw: { address: { country_code: 'ug', county: 'Kampala', suburb: 'Naguru', road: 'Jinja Road' } } });
  const notFound = signageGpsLocation({ address: 'Kampala', raw: { address: { country_code: 'ug', county: 'Kampala' } } });

  it('keeps the GPS village when the lookup found one, ignoring typed text', () => {
    expect(resolvedSignageVillage(found, 'Something Else')).toBe('Naguru');
  });
  it('saves the typed village when the lookup found none', () => {
    expect(resolvedSignageVillage(notFound, '  Kireka  ')).toBe('Kireka');
  });
  it('stays empty until the agent types a village the lookup could not find', () => {
    expect(resolvedSignageVillage(notFound, '   ')).toBe('');
    expect(resolvedSignageVillage(null, 'Kireka')).toBe('');
  });
});
