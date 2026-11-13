import { describe, expect, it } from 'vitest';
import { signageGpsLocation, bigDataCloudToReverse } from '@/lib/signageGpsLocation';

describe('signage GPS address mapping', () => {
  it('uses only returned Uganda address components without inventing optional levels', () => {
    expect(signageGpsLocation({ address: 'Jinja Road, Naguru', raw: { address: {
      country_code: 'ug', county: 'Kampala', suburb: 'Naguru', road: 'Jinja Road', state: 'Central Region',
    } } })).toEqual({ district: 'Kampala', county: '', subcounty: '', parish: '', village: 'Naguru', address: 'Jinja Road, Naguru' });
  });
  it('blocks missing district or locality and failed lookups', () => {
    expect(signageGpsLocation(null)).toBeNull();
    expect(signageGpsLocation({ address: 'Uganda', raw: { address: { country_code: 'ug', state: 'Central Region' } } })).toBeNull();
    expect(signageGpsLocation({ address: 'Kampala', raw: { address: { country_code: 'ug', county: 'Kampala' } } })).toBeNull();
  });
  it('does not treat a location outside Uganda as a signage address', () => {
    expect(signageGpsLocation({ address: 'Nairobi', raw: { address: { country_code: 'ke', county: 'Nairobi', suburb: 'Westlands' } } })).toBeNull();
  });
  it('fills village from road when no locality is returned', () => {
    expect(signageGpsLocation({ address: 'x', raw: { address: { country_code: 'ug', county: 'Wakiso', road: 'Entebbe Road' } } })?.village).toBe('Entebbe Road');
  });
  it('maps backup geocoder district and locality', () => {
    const r = bigDataCloudToReverse({ countryCode: 'UG', locality: 'Kireka', localityInfo: { administrative: [{ name: 'Uganda' }, { name: 'Wakiso District' }] } });
    expect(signageGpsLocation(r)).toMatchObject({ district: 'Wakiso', village: 'Kireka' });
  });
});
