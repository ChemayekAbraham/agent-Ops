import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));

import {
  saveTenantIntake,
  samePhone,
  tenantRequestMissing,
  type TenantItemKey,
  type TenantRequestInput,
} from '@/lib/tenantSelfRequest';

/** A request with everything in. */
const COMPLETE: TenantRequestInput = {
  rentAmount: 300000, minRent: 50000, maxRent: 10000000, durationOk: true,
  firstName: 'Robert', lastName: 'Mugisha', phone: '0771234567', nin: 'CM9001234567AB',
  hasIdFront: true, hasIdBack: true, hasPassportPhoto: true,
  familySize: '4', work: 'Boda rider',
  address: 'Plot 14, behind Kabalagala market', hasVillage: true, hasGps: true, housePhotoCount: 3,
  landlordName: 'Peter Okello', landlordPhone: '0772000111',
  hasLcLetter: true,
  declared: true,
};
const keys = (over: Partial<TenantRequestInput>): TenantItemKey[] => tenantRequestMissing({ ...COMPLETE, ...over }).map((m) => m.key);

beforeEach(() => vi.clearAllMocks());

describe('tenantRequestMissing: Submit stays locked until every item is in', () => {
  it('happy path: a complete request is missing nothing', () => {
    expect(tenantRequestMissing(COMPLETE)).toEqual([]);
  });

  it('an empty form lists every item, each with the step that fixes it', () => {
    const empty = tenantRequestMissing({
      ...COMPLETE, rentAmount: 0, firstName: '', lastName: '', phone: '', nin: '', hasIdFront: false, hasIdBack: false,
      hasPassportPhoto: false, familySize: '', work: '', address: '', hasVillage: false, hasGps: false, housePhotoCount: 0,
      landlordName: '', landlordPhone: '', hasLcLetter: false, declared: false,
    });
    // An empty NIN is fine (optional); the three photos are not.
    expect(empty.map((m) => [m.key, m.step])).toEqual([
      ['rent', 2], ['fullName', 3], ['phone', 3], ['idFront', 3], ['idBack', 3], ['passportPhoto', 3], ['familySize', 3], ['work', 3],
      ['address', 4], ['village', 4], ['gps', 4], ['housePhotos', 4],
      ['landlord', 5], ['lcLetter', 5], ['declared', 6],
    ]);
  });

  it('full name: needs a first and a last name', () => {
    expect(keys({ lastName: '' })).toEqual(['fullName']);
    expect(keys({ firstName: 'R' })).toEqual(['fullName']);
  });

  it('DOCS-1: a photo of the FRONT of the National ID is required', () => {
    expect(keys({ hasIdFront: false })).toEqual(['idFront']);
  });

  it('DOCS-1: a photo of the BACK of the National ID is required', () => {
    expect(keys({ hasIdBack: false })).toEqual(['idBack']);
  });

  it('DOCS-1: the NIN is optional; a typed one must be valid', () => {
    expect(keys({ nin: '' })).toEqual([]);
    expect(keys({ nin: 'CM12' })).toEqual(['nationalId']);
    expect(keys({ nin: 'CM9001234567ABCD' })).toEqual(['nationalId']);
  });

  it('house photos: at least 3', () => {
    expect(keys({ housePhotoCount: 2 })).toEqual(['housePhotos']);
    expect(keys({ housePhotoCount: 4 })).toEqual([]);
  });

  it('GPS: a pin taken at the house', () => {
    expect(keys({ hasGps: false })).toEqual(['gps']);
  });

  it('landlord: a name and a valid phone', () => {
    expect(keys({ landlordName: '' })).toEqual(['landlord']);
    expect(keys({ landlordPhone: '0772' })).toEqual(['landlord']);
  });

  it('landlord phone: must not be the tenant’s, in any format', () => {
    const [item] = tenantRequestMissing({ ...COMPLETE, landlordPhone: '+256 771 234 567' });
    expect(item).toEqual({ key: 'landlordPhone', step: 5, label: 'Your landlord’s phone must be different from yours' });
    expect(samePhone('0771234567', '+256771234567')).toBe(true);
    expect(samePhone('0771234567', '0772000111')).toBe(false);
  });

  it('rent and duration: within the limits, on an accepted period', () => {
    expect(keys({ rentAmount: 40000 })).toEqual(['rent']);
    expect(keys({ rentAmount: 20000000 })).toEqual(['rent']);
    expect(keys({ durationOk: false })).toEqual(['rent']);
  });

  it('family size: a whole number from 1 to 30', () => {
    expect(keys({ familySize: '' })).toEqual(['familySize']);
    expect(keys({ familySize: '0' })).toEqual(['familySize']);
    expect(keys({ familySize: '31' })).toEqual(['familySize']);
    expect(keys({ familySize: '30' })).toEqual([]);
  });

  it('work / business: at least 3 letters', () => {
    expect(keys({ work: 'ab' })).toEqual(['work']);
    expect(keys({ work: '  ab  ' })).toEqual(['work']);
  });

  it('DOCS-1: a photo of the LC1 letter is required; the chairperson’s contact does not replace it', () => {
    expect(keys({ hasLcLetter: false })).toEqual(['lcLetter']);
  });

  it('the declaration box must be ticked', () => {
    expect(keys({ declared: false })).toEqual(['declared']);
  });
});

describe('saveTenantIntake', () => {
  it('calls tenant_save_intake_details with the request and the intake', async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });
    const res = await saveTenantIntake('req-1', {
      familySize: 4, workBusiness: ' Boda rider ', workLocation: ' ', lc1Contact: 'Sarah Namuli, 0701000222',
      lcLetterBucket: 'lc-letters', lcLetterPath: 't1/abc/lc_letter.jpg',
    });
    expect(res).toEqual({ ok: true, message: null });
    expect(mocks.rpc).toHaveBeenCalledWith('tenant_save_intake_details', {
      p_request_id: 'req-1', p_family_size: 4, p_work_business: 'Boda rider', p_work_location: null,
      p_lc1_contact: 'Sarah Namuli, 0701000222', p_lc_letter_bucket: 'lc-letters', p_lc_letter_path: 't1/abc/lc_letter.jpg',
    });
  });

  it('returns the server message as-is', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'NOT_YOUR_REQUEST: request req-1 belongs to another tenant' } });
    expect(await saveTenantIntake('req-1', { familySize: 4, workBusiness: 'Tailor', workLocation: '', lc1Contact: null, lcLetterBucket: null, lcLetterPath: null }))
      .toEqual({ ok: false, message: 'NOT_YOUR_REQUEST: request req-1 belongs to another tenant' });
  });
});
