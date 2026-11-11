import { describe, expect, it, vi } from 'vitest';
import {
  closeT4RentRequest,
  getT4Request,
  GATE_ITEMS,
  hasTenantId,
  MIN_HOUSE_PHOTOS,
  OPEN_REQUEST_STATUSES,
  openT4RentRequest,
  resubmitPatch,
  subscribeT4Request,
  t4Missing,
  type ResubmitValues,
  type T4Facts,
} from '@/lib/t4RentRequest';

const ALL_TRUE: T4Facts = {
  photos: true, landlord: true, rent: true, gps: true, familySize: true, work: true, lcLetter: true,
  tenantName: true, idFront: true, idBack: true, openRequest: true,
  plan: true, tenantPhone: true, house: true, tenantPhoto: true, lc1: true, payoutDay: true, consent: true,
  note: true, resubmitsLeft: true,
};
const gateKeys = (m: ReturnType<typeof t4Missing>) => m.filter((i) => i.group === 'gate').map((i) => i.key);
const formKeys = (m: ReturnType<typeof t4Missing>) => m.filter((i) => i.group === 'form').map((i) => i.key);

describe('t4Missing: the Agent Ops gate, the same in every mode', () => {
  it('lists the gate items in order: SC basics, SC-2, LC1 letter, full name, ID front and back photos (DOCS-1), open request', () => {
    expect(GATE_ITEMS).toEqual([
      'photos', 'landlord', 'rent', 'gps', 'familySize', 'work', 'lcLetter', 'tenantName', 'idFront', 'idBack', 'openRequest',
    ]);
    for (const mode of ['new', 'resubmit'] as const) {
      expect(gateKeys(t4Missing(mode, {}))).toEqual([...GATE_ITEMS]);
    }
  });

  it('a renewal skips family size and work, as SC-2 does, and so does a resubmitted renewal', () => {
    const expected = ['photos', 'landlord', 'rent', 'gps', 'lcLetter', 'tenantName', 'idFront', 'idBack', 'openRequest'];
    expect(gateKeys(t4Missing('renewal', {}))).toEqual(expected);
    expect(gateKeys(t4Missing('resubmit', {}, 'renewal'))).toEqual(expected);
  });

  it('keeps the form’s own needs in a separate group', () => {
    expect(formKeys(t4Missing('new', {}))).toEqual(['plan', 'tenantPhone', 'house', 'tenantPhoto', 'lc1', 'payoutDay', 'consent']);
    expect(formKeys(t4Missing('resubmit', {}))).toEqual(['note', 'resubmitsLeft']);
    expect(formKeys(t4Missing('renewal', {}))).toEqual([]);
    for (const mode of ['new', 'resubmit', 'renewal'] as const) expect(t4Missing(mode, ALL_TRUE)).toEqual([]);
  });

  it('names the items in plain words', () => {
    const labels = t4Missing('resubmit', { ...ALL_TRUE, photos: false, lcLetter: false, tenantName: false, idFront: false, idBack: false }).map((i) => i.label);
    expect(labels).toEqual([
      'At least 3 house photos',
      'LC1 letter photo',
      'Tenant’s full name (2 or more names)',
      'National ID photo — front',
      'National ID photo — back',
    ]);
  });
});

describe('DOCS-1: ID front, ID back and LC1 letter photos in every mode', () => {
  for (const mode of ['new', 'resubmit', 'renewal'] as const) {
    it(`${mode}: each missing photo is listed on its own`, () => {
      expect(t4Missing(mode, { ...ALL_TRUE, idFront: false }).map((i) => i.key)).toEqual(['idFront']);
      expect(t4Missing(mode, { ...ALL_TRUE, idBack: false }).map((i) => i.key)).toEqual(['idBack']);
      expect(t4Missing(mode, { ...ALL_TRUE, lcLetter: false }).map((i) => i.key)).toEqual(['lcLetter']);
    });
  }
});

describe('the three new gate items', () => {
  it('tenant ID: any one of national_id, linked_national_id, national_id_photo_path, national_id_card_number', () => {
    expect(hasTenantId(null)).toBe(false);
    expect(hasTenantId({ national_id: '  ', linked_national_id: null, national_id_photo_path: '', national_id_card_number: null })).toBe(false);
    expect(hasTenantId({ national_id: 'CM12345678ABCD' })).toBe(true);
    expect(hasTenantId({ linked_national_id: 'CF98765432ZYXW' })).toBe(true);
    expect(hasTenantId({ national_id_photo_path: 'ids/tenant-1/front.jpg' })).toBe(true);
    expect(hasTenantId({ national_id_card_number: '012345678' })).toBe(true);
  });

  it('open request: names the other request’s status', () => {
    const [item] = t4Missing('new', { ...ALL_TRUE, openRequest: false }, null, 'agent_ops_approved');
    expect(item).toEqual({ key: 'openRequest', group: 'gate', label: 'This tenant already has an open request (status agent_ops_approved)' });
    expect(OPEN_REQUEST_STATUSES[0]).toBe('service_center_review');
    expect(OPEN_REQUEST_STATUSES[OPEN_REQUEST_STATUSES.length - 1]).toBe('coo_approved');
    expect(OPEN_REQUEST_STATUSES).toContain('pending');
  });

  it('house photos: Agent Ops approves 3 and picks a main one, so 3 is the floor', () => {
    expect(MIN_HOUSE_PHOTOS).toBe(3);
    expect(t4Missing('renewal', { ...ALL_TRUE, photos: false })).toEqual([
      { key: 'photos', group: 'gate', label: 'At least 3 house photos' },
    ]);
  });
});

describe('resubmitPatch: only what the agent changed', () => {
  const before: ResubmitValues = {
    rentAmount: 300000, durationDays: 30, preferredLanguage: 'English', noSmartphone: false,
    landlordId: 'll-1', landlordName: 'Peter Okello', landlordPhone: '0772000111', houseCategory: 'single-room',
    tenantName: 'John Mukasa', tenantPhone: '0783 123 456', nationalId: 'CM12345678ABCD',
  };

  it('sends nothing when nothing changed', () => {
    expect(resubmitPatch(before, { ...before, tenantPhone: '0783123456', nationalId: 'cm12345678abcd' })).toEqual({});
  });

  it('sends the changed fields with the server’s column names', () => {
    const patch = resubmitPatch(before, {
      ...before, rentAmount: 350000, durationDays: 60, houseCategory: 'double-room',
      landlordId: 'll-2', landlordName: 'Sarah Nansubuga', landlordPhone: '0701000222', tenantName: 'John Paul Mukasa',
    });
    expect(patch).toEqual({
      rent_amount: 350000,
      duration_days: 60,
      house_category: 'double-room',
      landlord_id: 'll-2',
      landlord_name: 'Sarah Nansubuga',
      landlord_phone: '0701000222',
      tenant_name: 'John Paul Mukasa',
    });
  });
});

describe('openT4RentRequest: one form for every entry point', () => {
  it('opens with a fresh key each time and closes', () => {
    const seen = vi.fn();
    const off = subscribeT4Request(seen);
    openT4RentRequest({ mode: 'new', entry: 'a' });
    const first = getT4Request();
    openT4RentRequest({ mode: 'new', entry: 'b' });
    expect(getT4Request()?.entry).toBe('b');
    expect(getT4Request()?.key).not.toBe(first?.key);
    closeT4RentRequest();
    expect(getT4Request()).toBeNull();
    expect(seen).toHaveBeenCalledTimes(3);
    off();
  });

  it('opens a new, empty request when called with nothing', () => {
    openT4RentRequest();
    expect(getT4Request()).toMatchObject({ mode: 'new' });
    closeT4RentRequest();
  });
});
