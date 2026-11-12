import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), upload: vi.fn(), captureGps: vi.fn(), updates: [] as [string, unknown][], updateResult: { data: [{ id: 'tenant-1' }], error: null } as { data: unknown; error: unknown } }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      b.update = (v: unknown) => { mocks.updates.push([table, v]); return b; };
      b.eq = () => b;
      b.select = () => b;
      b.maybeSingle = async () => ({ data: null, error: null });
      b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(mocks.updateResult).then(resolve);
      return b;
    },
    storage: { from: () => ({ upload: mocks.upload, getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn/${p}` } }) }) },
  },
}));
vi.mock('@/lib/imageOptimizer', () => ({ optimizeImage: vi.fn(async (file: File) => ({ file })) }));
vi.mock('@/lib/captureGps', () => ({
  captureGps: mocks.captureGps,
  isGpsRequiredError: (m: unknown) => /gps/i.test(String(m ?? '')),
}));

import { attachT4Documents, fetchAgentSideMissing, finishRenewalIntake, postRenewal, resubmitT4Request, saveProfileIdBack, SIDE_MISSING_LINES, sideMissingSteps, uploadNewRequestDocs } from '@/lib/t4RentRequestSubmit';

const calls = () => mocks.rpc.mock.calls.map(([fn, args]) => [fn, args]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updates = [];
  mocks.updateResult = { data: [{ id: 'tenant-1' }], error: null };
  mocks.upload.mockResolvedValue({ error: null });
  mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });
});

describe('resubmitT4Request: a resubmit goes back to the Service Centre', () => {
  it('saves family size and work first (E90), then sends the changed fields and the note', async () => {
    const res = await resubmitT4Request({
      agentId: 'agent-1',
      requestId: 'req-9',
      patch: { rent_amount: 350000 },
      note: '  Fixed the rent with the landlord  ',
      photos: ['https://cdn/a.jpg', 'https://cdn/b.jpg', 'https://cdn/c.jpg', 'https://cdn/d.jpg'],
      extraPhotoUrls: [],
      lcLetter: null,
      noLc1Reason: 'LC1 is away until Friday',
      details: { familySize: 5, workBusiness: 'Tailor', workLocation: 'Owino' },
    });
    expect(res).toMatchObject({ ok: true, requestId: 'req-9', intakeError: null, lc1NoteError: null });
    expect(calls()).toEqual([
      ['agent_save_intake_details', { p_request_id: 'req-9', p_family_size: 5, p_work_business: 'Tailor', p_work_location: 'Owino' }],
      ['agent_resubmit_rent_request', { p_request_id: 'req-9', p_patch: { rent_amount: 350000 }, p_agent_note: 'Fixed the rent with the landlord' }],
      ['agent_note_lc1_missing', { p_request_id: 'req-9', p_reason: 'LC1 is away until Friday' }],
    ]);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('uploads a replaced photo and a new LC letter into the same patch', async () => {
    const photo = new File(['p'], 'front.jpg', { type: 'image/jpeg' });
    const letter = new File(['l'], 'letter.png', { type: 'image/png' });
    await resubmitT4Request({
      agentId: 'agent-1', requestId: 'req-9', patch: {}, note: 'New front photo and LC letter',
      photos: [photo, 'https://cdn/b.jpg', 'https://cdn/c.jpg', 'https://cdn/d.jpg'], extraPhotoUrls: ['https://cdn/e.jpg'],
      lcLetter: letter, noLc1Reason: null, details: null,
    });
    const [fn, args] = mocks.rpc.mock.calls[0];
    expect(fn).toBe('agent_resubmit_rent_request');
    const patch = (args as { p_patch: Record<string, unknown> }).p_patch;
    expect(patch.house_image_urls).toEqual([
      expect.stringMatching(/^https:\/\/cdn\/agent-1\/req-9\/photo_0_\d+\.jpg$/),
      'https://cdn/b.jpg', 'https://cdn/c.jpg', 'https://cdn/d.jpg', 'https://cdn/e.jpg',
    ]);
    expect(patch.lc_letter_path).toMatch(/^agent-1\/req-9\/lc_letter_\d+\.png$/);
    expect(patch.lc_letter_bucket).toBe('lc-letters');
    // No details for a renewal-type request; no note when a letter came in.
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('returns the RESUBMIT_INCOMPLETE refusal word for word', async () => {
    const refusal = 'RESUBMIT_INCOMPLETE: add house photos, GPS before sending this request again';
    mocks.rpc.mockImplementation(async (fn: string) => (fn === 'agent_resubmit_rent_request'
      ? { data: null, error: { message: refusal } }
      : { data: { ok: true }, error: null }));
    const res = await resubmitT4Request({
      agentId: 'agent-1', requestId: 'req-9', patch: {}, note: 'Fixed the LC1 details',
      photos: [], extraPhotoUrls: [], lcLetter: null, noLc1Reason: null,
      details: { familySize: 3, workBusiness: 'Boda rider', workLocation: '' },
    });
    expect(res).toEqual({ ok: false, message: refusal });
    expect(calls().map(([fn]) => fn)).toEqual(['agent_save_intake_details', 'agent_resubmit_rent_request']);
  });

  it('does not resubmit when family size and work are refused, and shows that error as-is', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'FAMILY_SIZE_RANGE: 1-30' } });
    const res = await resubmitT4Request({
      agentId: 'agent-1', requestId: 'req-9', patch: {}, note: 'Added family size',
      photos: [], extraPhotoUrls: [], lcLetter: null, noLc1Reason: null,
      details: { familySize: 99, workBusiness: 'Tailor', workLocation: null },
    });
    expect(res).toEqual({ ok: false, message: 'FAMILY_SIZE_RANGE: 1-30' });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});

describe('E90: what the agent still has to add', () => {
  it('reads _agent_side_missing for the request', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: ['house photos', ' GPS ', ''], error: null });
    await expect(fetchAgentSideMissing('req-9')).resolves.toEqual(['house photos', 'GPS']);
    expect(mocks.rpc).toHaveBeenCalledWith('_agent_side_missing', { p_request_id: 'req-9' });
  });

  it('gives null when the list cannot be read', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'permission denied' } });
    await expect(fetchAgentSideMissing('req-9')).resolves.toBeNull();
    mocks.rpc.mockResolvedValueOnce({ data: { ok: true }, error: null });
    await expect(fetchAgentSideMissing('req-9')).resolves.toBeNull();
  });

  it.each([
    ['Photos of the house', 'photos'],
    ['Landlord details', 'landlord'],
    ['Rent amount needed', 'rent'],
    ['GPS of the house', 'gps'],
    ['family size', 'familySize'],
    ['work / business', 'work'],
    ['ID photo (front)', 'idFront'],
    ['ID photo (back)', 'idBack'],
    ['LC1 letter (photo)', 'lcLetter'],
  ] as const)('maps the server line "%s" to exactly one question: %s', (line, step) => {
    expect(SIDE_MISSING_LINES[line]).toBe(step);
    expect(sideMissingSteps(line)).toEqual([step]);
    // Case and surrounding spaces do not matter.
    expect(sideMissingSteps(`  ${line.toUpperCase()} `)).toEqual([step]);
  });

  it('covers every server line and nothing else', () => {
    expect(Object.keys(SIDE_MISSING_LINES)).toHaveLength(9);
  });

  it('falls back to keywords for a line it does not know, ID and LC1 before any generic photo', () => {
    expect(sideMissingSteps('house photos')).toEqual(['photos']);
    expect(sideMissingSteps('National ID photo, front side')).toEqual(['idFront']);
    expect(sideMissingSteps('Back of the ID photo')).toEqual(['idBack']);
    expect(sideMissingSteps('ID photos')).toEqual(['idFront', 'idBack']);
    expect(sideMissingSteps('Photo of the LC1 letter')).toEqual(['lcLetter']);
    expect(sideMissingSteps('Landlord phone')).toEqual(['landlord']);
    expect(sideMissingSteps('Monthly rent')).toEqual(['rent']);
    expect(sideMissingSteps('House location')).toEqual(['gps']);
    expect(sideMissingSteps('Household size')).toEqual(['familySize']);
    expect(sideMissingSteps('Occupation')).toEqual(['work']);
    expect(sideMissingSteps('something else')).toEqual([]);
  });
});

describe('renewal', () => {
  const choice = { newRent: 320000, newDays: 30, dailyRepayment: 14000, totalRepayment: 420000, changed: false, reasonCode: null, explanation: '', evidenceUrl: null };

  it('posts renew_rent_request and returns the new request id', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: 'new-req', error: null });
    await expect(postRenewal('prev-1', choice)).resolves.toBe('new-req');
    expect(mocks.rpc).toHaveBeenCalledWith('renew_rent_request', { p_prev_request_id: 'prev-1', p_new_rent_amount: 320000, p_new_days: 30 });
  });

  it('captures GPS at the house and retries once when the server asks for it', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'GPS required for this property' } });
    mocks.rpc.mockResolvedValueOnce({ data: 'new-req', error: null });
    mocks.captureGps.mockResolvedValue({ latitude: 0.31, longitude: 32.58 });
    const onGps = vi.fn();
    await expect(postRenewal('prev-1', choice, onGps)).resolves.toBe('new-req');
    expect(onGps).toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenLastCalledWith('renew_rent_request', expect.objectContaining({ p_latitude: 0.31, p_longitude: 32.58 }));
  });

  it('attaches the LC1 letter to the new request, or notes why there is none', async () => {
    const letter = new File(['l'], 'letter.jpg', { type: 'image/jpeg' });
    await finishRenewalIntake('agent-1', 'new-req', letter, null);
    expect(mocks.upload).toHaveBeenCalledWith('agent-1/new-req/lc_letter.jpg', letter, expect.objectContaining({ upsert: true }));
    expect(mocks.rpc).toHaveBeenCalledWith('agent_attach_lc1_letter', { p_request_id: 'new-req', p_path: 'agent-1/new-req/lc_letter.jpg' });

    mocks.rpc.mockClear();
    await finishRenewalIntake('agent-1', 'new-req', null, 'LC1 is away until Friday');
    expect(calls()).toEqual([['agent_note_lc1_missing', { p_request_id: 'new-req', p_reason: 'LC1 is away until Friday' }]]);
  });
});

describe('DOCS-1: attachT4Documents', () => {
  it('uploads new photos to tenant-ids / lc-letters, then attaches each with request_attach_document', async () => {
    const front = new File(['f'], 'front.jpg', { type: 'image/jpeg' });
    const letter = new File(['l'], 'letter.png', { type: 'image/png' });
    const problems = await attachT4Documents('agent-1', 'req-1', {
      id_front: front,
      id_back: { bucket: 'tenant-ids', path: 'tenant-1/old/national_id_back.jpg' },
      lc1_letter: letter,
    });
    expect(problems).toEqual([]);
    expect(mocks.upload).toHaveBeenCalledTimes(2);
    expect(calls()).toEqual([
      ['request_attach_document', { p_request_id: 'req-1', p_kind: 'id_front', p_bucket: 'tenant-ids', p_path: expect.stringMatching(/^agent-1\/req-1\/national_id_\d+\.jpg$/) }],
      // Already stored: attached as it is, no upload.
      ['request_attach_document', { p_request_id: 'req-1', p_kind: 'id_back', p_bucket: 'tenant-ids', p_path: 'tenant-1/old/national_id_back.jpg' }],
      ['request_attach_document', { p_request_id: 'req-1', p_kind: 'lc1_letter', p_bucket: 'lc-letters', p_path: expect.stringMatching(/^agent-1\/req-1\/lc_letter_\d+\.png$/) }],
    ]);
  });

  it('returns each failure with the server’s message as-is and keeps going', async () => {
    mocks.upload.mockResolvedValueOnce({ error: { message: 'new row violates row-level security policy' } });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'DOC_KIND_UNKNOWN: id_back' } });
    const problems = await attachT4Documents('agent-1', 'req-1', {
      id_front: new File(['f'], 'front.jpg', { type: 'image/jpeg' }),
      id_back: { bucket: 'tenant-ids', path: 'x/back.jpg' },
    });
    expect(problems).toEqual([
      'National ID front photo: new row violates row-level security policy',
      'National ID back photo: DOC_KIND_UNKNOWN: id_back',
    ]);
  });
});

describe('DOCS-1: before the insert / before the renewal', () => {
  const jpg = (n: string) => new File([n], `${n}.jpg`, { type: 'image/jpeg' });

  it('uploadNewRequestDocs stores the three photos under one new folder, before any request exists', async () => {
    const docs = await uploadNewRequestDocs('agent-1', { idFront: jpg('f'), idBack: jpg('b'), lcLetter: jpg('l') });
    expect(docs.idFront).toEqual({ bucket: 'tenant-ids', path: expect.stringMatching(/^agent-1\/new-[^/]+\/national_id_\d+\.jpg$/) });
    expect(docs.idBack).toEqual({ bucket: 'tenant-ids', path: expect.stringMatching(/^agent-1\/new-[^/]+\/national_id_back_\d+\.jpg$/) });
    expect(docs.lcLetter).toEqual({ bucket: 'lc-letters', path: expect.stringMatching(/^agent-1\/new-[^/]+\/lc_letter_\d+\.jpg$/) });
    const folder = (p: string) => p.split('/')[1];
    expect(folder(docs.idBack.path)).toBe(folder(docs.idFront.path));
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('uploadNewRequestDocs names the photo that failed, with the storage message as-is', async () => {
    mocks.upload.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: 'Payload too large' } });
    await expect(uploadNewRequestDocs('agent-1', { idFront: jpg('f'), idBack: jpg('b'), lcLetter: jpg('l') }))
      .rejects.toThrow('National ID back photo: Payload too large');
  });

  it('saveProfileIdBack uploads the back and puts it on the tenant’s profile', async () => {
    expect(await saveProfileIdBack('agent-1', 'tenant-1', jpg('b'))).toBeNull();
    expect(mocks.updates).toEqual([
      ['profiles', { national_id_photo_back_path: expect.stringMatching(/^agent-1\/profile-tenant-1\/national_id_back_\d+\.jpg$/) }],
    ]);
  });

  it('saveProfileIdBack returns the server error as-is', async () => {
    mocks.updateResult = { data: null, error: { message: 'permission denied for table profiles' } };
    expect(await saveProfileIdBack('agent-1', 'tenant-1', jpg('b'))).toBe('National ID back photo: permission denied for table profiles');
  });
});
