import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), upload: vi.fn(), invoke: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: mocks.from,
    auth: { getSession: vi.fn(async () => ({ data: { session: { user: { id: 'agent-1' } } }, error: null })), refreshSession: vi.fn() },
    functions: { invoke: mocks.invoke },
    storage: { from: () => ({ upload: mocks.upload, getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn/${p}` } }) }) },
  },
}));
vi.mock('@/lib/imageOptimizer', () => ({ optimizeImage: vi.fn(async (file: File) => ({ file })) }));
vi.mock('@/lib/archiveToDrive', () => ({ archiveToDrive: vi.fn() }));
vi.mock('@/lib/avatarSync', () => ({ publishAvatarUpdate: vi.fn() }));
vi.mock('@/lib/agentSignupTelemetry', () => ({ collectAgentSignupTelemetry: vi.fn(async () => ({})) }));
vi.mock('@/lib/getPublicOrigin', () => ({ getPublicOrigin: () => 'https://welile.test' }));

import { submitAssistantRentRequest, type AssistantSubmitInput } from '@/lib/rentRequestAssistantSubmit';

/** A chainable query builder: every filter returns itself; terminal calls resolve with `result`. */
function builder(result: { data: unknown; error: unknown }) {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'update', 'insert']) b[m] = vi.fn(() => b);
  b.single = vi.fn(async () => result);
  b.maybeSingle = vi.fn(async () => result);
  b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return b;
}

const input = (over: Partial<AssistantSubmitInput> = {}): AssistantSubmitInput => ({
  agentId: 'agent-1',
  incomeType: 'daily',
  earnerCycle: 'weekly',
  fees: { rentAmount: 300000, durationDays: 30, accessFee: 1, requestFee: 1, totalRepayment: 300002, dailyRepayment: 10000 },
  tenantName: 'John Mukasa',
  tenantPhone: '0783 123 456',
  tenantNationalId: 'CM12345678ABCD',
  preferredLanguage: 'English',
  noSmartphone: false,
  landlordId: 'landlord-1',
  landlordName: '',
  landlordPhone: '',
  house: null,
  houseCategory: 'single-room',
  propertyCity: '',
  propertyDistrict: '',
  location: null,
  gps: null,
  housePhotos: [],
  tenantPhoto: new File(['p'], 'p.jpg', { type: 'image/jpeg' }),
  lc1Name: 'Peter Okello',
  lc1Phone: '0772 000 111',
  lc1Village: 'Kireka B',
  lcLetter: null,
  landlordPayoutDay: '5',
  familySize: 4,
  workBusiness: 'Tailor',
  workLocation: 'Owino',
  noLc1Reason: 'LC1 is away until Friday',
  ...over,
});

/** Live RPC answers before the insert; `intake` overrides the three intake RPCs. */
function serveRpcs(intake: Record<string, { data: unknown; error: unknown }> = {}) {
  mocks.rpc.mockImplementation(async (fn: string) => {
    if (fn in intake) return intake[fn];
    switch (fn) {
      case 'get_landlord_verification_status': return { data: [{ exists_flag: true }], error: null };
      case 'find_lc1_by_phone': return { data: [{ id: 'lc1-1' }], error: null };
      case 'verify_landlord_registered': return { data: true, error: null };
      default: return { data: { ok: true }, error: null };
    }
  });
}

const intakeCalls = () => mocks.rpc.mock.calls.filter(([fn]) => String(fn).startsWith('agent_'));

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  mocks.upload.mockResolvedValue({ error: null });
  mocks.invoke.mockResolvedValue({ data: { user_id: 'tenant-1', existing: false }, error: null });
  mocks.from.mockImplementation((table: string) => builder(
    table === 'rent_requests' ? { data: { id: 'req-1' }, error: null } : { data: [], error: null },
  ));
});

describe('submitAssistantRentRequest: intake after the request is created', () => {
  it('saves the details and notes the missing LC1 letter with the right arguments', async () => {
    serveRpcs();
    const res = await submitAssistantRentRequest(input());
    expect(res).toMatchObject({ ok: true, rentRequestId: 'req-1', intakeError: null, lc1NoteError: null, lc1AttachError: null });
    expect(intakeCalls()).toEqual([
      ['agent_note_lc1_missing', { p_request_id: 'req-1', p_reason: 'LC1 is away until Friday' }],
      ['agent_save_intake_details', { p_request_id: 'req-1', p_family_size: 4, p_work_business: 'Tailor', p_work_location: 'Owino' }],
    ]);
  });

  it('attaches an uploaded LC1 letter instead of noting it missing', async () => {
    serveRpcs();
    const letter = new File(['l'], 'letter.jpg', { type: 'image/jpeg' });
    const res = await submitAssistantRentRequest(input({ lcLetter: letter, noLc1Reason: null }));
    expect(res.ok).toBe(true);
    expect(mocks.upload).toHaveBeenCalledWith('agent-1/req-1/lc_letter.jpg', letter, expect.objectContaining({ upsert: true }));
    expect(intakeCalls().map(([fn, args]) => [fn, args])).toEqual([
      ['agent_attach_lc1_letter', { p_request_id: 'req-1', p_path: 'agent-1/req-1/lc_letter.jpg' }],
      ['agent_save_intake_details', { p_request_id: 'req-1', p_family_size: 4, p_work_business: 'Tailor', p_work_location: 'Owino' }],
    ]);
  });

  it('keeps the request when saving details fails, returning the server errors as-is', async () => {
    serveRpcs({
      agent_save_intake_details: { data: null, error: { message: 'FAMILY_SIZE_RANGE: 1-30' } },
      agent_note_lc1_missing: { data: null, error: { message: 'REASON_TOO_SHORT' } },
    });
    const res = await submitAssistantRentRequest(input());
    expect(res).toMatchObject({ ok: true, rentRequestId: 'req-1', intakeError: 'FAMILY_SIZE_RANGE: 1-30', lc1NoteError: 'REASON_TOO_SHORT' });
  });
});

describe('DOCS-1: the three document photos go in the insert', () => {
  const docs = {
    idFront: { bucket: 'tenant-ids', path: 'agent-1/new-x/national_id_1.jpg' },
    idBack: { bucket: 'tenant-ids', path: 'agent-1/new-x/national_id_back_1.jpg' },
    lcLetter: { bucket: 'lc-letters', path: 'agent-1/new-x/lc_letter_1.jpg' },
  };

  it('puts nin_photo_*, nin_photo_back_* and lc_letter_* in the rent_requests insert', async () => {
    serveRpcs();
    const inserts: unknown[] = [];
    mocks.from.mockImplementation((table: string) => {
      const b = builder(table === 'rent_requests' ? { data: { id: 'req-1' }, error: null } : { data: [], error: null });
      if (table === 'rent_requests') b.insert = vi.fn((row: unknown) => { inserts.push(row); return b; });
      return b;
    });
    const res = await submitAssistantRentRequest(input({ docs, lcLetter: null, noLc1Reason: null }));
    expect(res.ok).toBe(true);
    expect(inserts[0]).toMatchObject({
      nin_photo_path: 'agent-1/new-x/national_id_1.jpg', nin_photo_bucket: 'tenant-ids',
      nin_photo_back_path: 'agent-1/new-x/national_id_back_1.jpg', nin_photo_back_bucket: 'tenant-ids',
      lc_letter_path: 'agent-1/new-x/lc_letter_1.jpg', lc_letter_bucket: 'lc-letters',
    });
  });

  it('shows the database’s DOCS_MISSING refusal exactly as it is', async () => {
    serveRpcs();
    const refusal = 'DOCS_MISSING: add the National ID back photo before posting this rent request';
    mocks.from.mockImplementation((table: string) => builder(
      table === 'rent_requests' ? { data: null, error: { message: refusal } } : { data: [], error: null },
    ));
    const res = await submitAssistantRentRequest(input({ docs, lcLetter: null, noLc1Reason: null }));
    expect(res).toMatchObject({ ok: false, message: refusal });
  });
});
