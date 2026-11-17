/**
 * Agents on old builds: before a Post / Resubmit / Renew the chat moves to the newest build,
 * keeping every answer and photo, and carries on there (appUpdate.ts, t4Resume.ts).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  submit: vi.fn(),
  open: vi.fn(),
  drafts: { data: [] as unknown, error: null as unknown },
  gate: { blocked: false, vetted: true, funding_frozen: false, notice: null } as Record<string, unknown>,
  faceCheck: vi.fn(),
  findNewer: vi.fn(),
  reloadTo: vi.fn(),
}));
const photoStore = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/lib/formPhotoDraft', async (orig) => ({
  ...(await orig<typeof import('@/lib/formPhotoDraft')>()),
  saveFormPhotos: async (k: string, v: unknown) => { photoStore.set(k, v); },
  loadFormPhotos: async (k: string) => photoStore.get(k) ?? null,
  clearFormPhotos: async (k: string) => { photoStore.delete(k); },
}));
vi.mock('@/lib/appUpdate', async (orig) => ({
  ...(await orig<typeof import('@/lib/appUpdate')>()),
  findNewerBuild: mocks.findNewer,
  reloadToBuild: mocks.reloadTo,
}));
vi.mock('@/lib/passportFaceCheck', async (orig) => ({
  ...(await orig<typeof import('@/lib/passportFaceCheck')>()),
  runPassportFaceCheck: mocks.faceCheck,
}));
vi.mock('@/integrations/supabase/client', () => {
  const builder = () => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'order', 'is', 'eq', 'in', 'neq', 'update', 'insert']) b[m] = () => b;
    b.limit = async () => ({ data: [], error: null });
    b.maybeSingle = async () => ({ data: null, error: null });
    b.single = async () => ({ data: null, error: null });
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
    return b;
  };
  return {
    supabase: {
      rpc: mocks.rpc,
      auth: { getSession: async () => ({ data: { session: { user: { id: 'agent-1' }, access_token: 'test-token' } }, error: null }) },
      from: builder,
      storage: {
        from: () => ({
          upload: vi.fn(async () => ({ error: null })),
          download: vi.fn(async () => ({ data: new Blob(['x'], { type: 'image/jpeg' }), error: null })),
          getPublicUrl: (p: string) => ({ data: { publicUrl: p } }),
          createSignedUrl: async (p: string) => ({ data: { signedUrl: `https://signed/${p}` }, error: null }),
        }),
      },
    },
  };
});
const auth = vi.hoisted(() => ({ user: { id: 'agent-1', user_metadata: { full_name: 'Agent One' } } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));
vi.mock('@/components/agent/rentRequestAssistant/useAssistantSpeech', () => ({
  useAssistantSpeech: () => ({ supported: false, enabled: false, speaking: false, failed: false, toggle: vi.fn(), stop: vi.fn(), replay: vi.fn() }),
}));
vi.mock('@/lib/rentAssistantRecordChecks', () => ({
  checkTenantPhone: vi.fn(async () => ({ status: 'free' })),
  checkNationalId: vi.fn(async () => ({ status: 'free' })),
  checkNewLc1Phone: vi.fn(async () => ({ status: 'free' })),
  loadAgentSelf: vi.fn(async () => ({ phone: null, nationalId: null })),
  maskPhone: (v: string) => v,
  maskNationalId: (v: string) => v,
}));
vi.mock('@/components/agent/RenewalDialog', () => ({ useRenewalFlow: () => ({ start: vi.fn(), dialogs: null }) }));
vi.mock('@/lib/haptics', () => ({ hapticTap: () => {}, hapticSelection: () => {}, hapticSuccess: () => {} }));
vi.mock('@/lib/imageOptimizer', () => ({ optimizeImage: vi.fn(async (file: File) => ({ file, previewUrl: 'blob:preview' })) }));
vi.mock('@/components/agent/LandlordSearchSelect', () => ({ LandlordSearchSelect: () => null }));
vi.mock('@/components/agent/RegisterLandlordDialog', () => ({ default: () => null }));
vi.mock('@/components/location/UgLocationPicker', () => ({ UgLocationPicker: () => null, default: () => null }));
vi.mock('@/components/agent/rentRequestAssistant/Lc1SearchStep', () => ({ Lc1SearchStep: () => null }));
vi.mock('@/components/agent/GuarantorConsentCheckbox', () => ({
  GuarantorConsentCheckbox: ({ checked, onCheckedChange }: { checked: boolean; onCheckedChange: (c: boolean) => void }) => (
    <input type="checkbox" aria-label="Guarantor consent" checked={checked} onChange={(e) => onCheckedChange(e.target.checked)} />
  ),
}));
vi.mock('@/lib/rentRequestAssistantSubmit', async (orig) => ({
  ...(await orig<typeof import('@/lib/rentRequestAssistantSubmit')>()),
  submitAssistantRentRequest: mocks.submit,
}));
vi.mock('@/lib/t4RentRequestSubmit', async (orig) => ({
  ...(await orig<typeof import('@/lib/t4RentRequestSubmit')>()),
  uploadNewRequestDocs: vi.fn(async () => ({
    idFront: { bucket: 'tenant-ids', path: 'agent-1/new/f.jpg' }, idBack: { bucket: 'tenant-ids', path: 'agent-1/new/b.jpg' },
    lcLetter: { bucket: 'lc-letters', path: 'agent-1/new/l.jpg' },
  })),
}));
vi.mock('@/lib/t4RentRequest', async (orig) => ({ ...(await orig<typeof import('@/lib/t4RentRequest')>()), openT4RentRequest: mocks.open }));

import RentRequestAssistant from '@/components/agent/rentRequestAssistant/RentRequestAssistant';
import { resetDraftsAvailability, type PostingDraftPayload } from '@/lib/postingDrafts';
import { T4_RESUME_KEY, readT4Resume, resumeRequestFor } from '@/lib/t4Resume';

beforeAll(() => {
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  photoStore.clear();
  mocks.findNewer.mockResolvedValue(null);
  resetDraftsAvailability();
  mocks.drafts = { data: [], error: null };
  mocks.gate = { blocked: false, vetted: true, funding_frozen: false, notice: null };
  mocks.faceCheck.mockResolvedValue({ status: 'ok', verdict: 'pass', isFace: true, isPassportPhoto: true, sha256: 'fresh' });
  mocks.rpc.mockImplementation(async (fn: string) => {
    switch (fn) {
      case 'agent_vetting_gate_status': return { data: mocks.gate, error: null };
      case 'posting_drafts_mine': return mocks.drafts;
      case 'posting_draft_save': return { data: { id: 'd1' }, error: null };
      case 'posting_draft_close': return { data: { ok: true }, error: null };
      case 'get_landlord_verification_status': return { data: [{ exists_flag: true, verified: true }], error: null };
      case 'agent_eligibility_of': return { data: null, error: null };
      default: return { data: { ok: true }, error: null };
    }
  });
  mocks.submit.mockResolvedValue({
    ok: true, rentRequestId: 'req-1', tenantExisting: false, activationLink: null,
    lcLetterFailed: false, intakeError: null, lc1AttachError: null, lc1NoteError: null,
  });
});

const answer = (text: string) => {
  fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
};
const logs = (event: string) => mocks.rpc.mock.calls
  .filter(([fn, row]) => fn === 'request_form_log' && (row as { p_event: string }).p_event === event)
  .map(([, row]) => row as Record<string, unknown>);

/** A saved request with everything but the family size. */
function fullPayload(): PostingDraftPayload {
    const path = (b: string, n: string) => ({ bucket: b, path: `agent-1/draft-x/${n}.jpg` });
    const payload: PostingDraftPayload = {
      v: 1,
      fields: {
        planType: 'daily', rentText: '300000', duration: '30', repaymentPeriod: '7', tenantPhone: '0783 123 456',
        tenantNameParts: { firstName: 'John', otherNames: '', lastName: 'Mukasa' }, nationalId: 'CM12345678ABCD', language: 'English',
        noSmartphone: false, familySize: '', work: 'Tailor', workLocation: '',
        landlord: { id: 'll-1', name: 'Peter Okello', phone: '0772000111', property_address: null },
        house: null, houseChoiceMade: true, location: null, address: 'Plot 14, Kireka', district: 'Wakiso', category: 'single-room',
        faceCheck: { status: 'ok', verdict: 'pass', isFace: true, isPassportPhoto: true, sha256: 'abc' },
        gps: { lat: 0.33, lng: 32.6, accuracy: 8 }, lc1Phone: '0772000999', lc1Match: null, lc1Mode: 'new',
        lc1NameParts: { firstName: 'Sarah', otherNames: '', lastName: 'Namuli' }, lc1Village: 'Kireka B', city: 'Kampala',
        noLc1Letter: false, noLc1Reason: '', payoutDay: '5', landlordCode: '',
      },
      photos: {
        house: [0, 1, 2, 3].map((i) => path('house-images', `house_${i}`)),
        tenantPhoto: path('house-images', 'tenant_photo'), idFront: path('tenant-ids', 'id_front'),
        idBack: path('tenant-ids', 'id_back'), lcLetter: path('lc-letters', 'lc1_letter'),
      },
    };
    return payload;
}

/** From the family size question to a posted request. */
async function finishAndPost() {
    expect((await screen.findAllByText(/How many people live in John’s household/, {}, { timeout: 3000 })).length).toBeGreaterThan(0);
    answer('4');
    fireEvent.click(await screen.findByLabelText('Guarantor consent'));
    const post = await screen.findByRole('button', { name: /Post rent request/ });
    await waitFor(() => expect(post).toBeEnabled());
    fireEvent.click(post);
    await waitFor(() => expect(mocks.submit).toHaveBeenCalled());
}


const LIVE = { source: 'new-src', builtAt: '2026-11-17T09:00:00.000Z' };

describe('an old build updates before the send, and the chat carries on', () => {
  it('with a newer build, Post saves the chat, reloads, and the new build reopens the same step and posts it', async () => {
    mocks.findNewer.mockResolvedValue(LIVE);
    const first = render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'new', draft: { id: 'd1', payload: fullPayload() } }} />);
    expect((await screen.findAllByText(/How many people live in John’s household/, {}, { timeout: 3000 })).length).toBeGreaterThan(0);
    answer('4');
    fireEvent.click(await screen.findByLabelText('Guarantor consent'));
    const post = await screen.findByRole('button', { name: /Post rent request/ });
    await waitFor(() => expect(post).toBeEnabled());
    fireEvent.click(post);

    // "Updating Welile… your answers are kept"; the chat is kept, then the page reloads. Nothing is sent.
    expect(await screen.findByTestId('app-updating')).toHaveTextContent('Updating Welile… your answers are kept');
    await waitFor(() => expect(mocks.reloadTo).toHaveBeenCalledWith(LIVE, expect.objectContaining({ reason: 'send', form: 'agent_post', session: expect.any(String) })));
    expect(mocks.submit).not.toHaveBeenCalled();
    const kept = readT4Resume('agent-1')!;
    expect(kept.request).toEqual({ mode: 'new', entry: 'app_update' });
    expect(kept.state).toMatchObject({ familySize: '4', consent: true, draftId: 'd1', tenantPhone: '0783 123 456' });
    const step = kept.state.current;
    expect(step).toBe('lcLetter'); // step 8, where Post is
    const counterBefore = screen.getByTestId('intake-counter').textContent;
    expect(counterBefore).toMatch(/^Step 8 of 8/);
    expect(kept.session).toBe(mocks.reloadTo.mock.calls[0][1].session);

    // The reload: the new build (no newer one now) opens what the host opens.
    first.unmount();
    mocks.findNewer.mockResolvedValue(null);
    let release: (v: unknown) => void = () => {};
    mocks.submit.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const reopened = resumeRequestFor('agent-1')!;
    expect(reopened).toMatchObject({ mode: 'new', resume: true });
    const opens = () => mocks.rpc.mock.calls.filter(([fn, row]) => fn === 'request_form_log' && (row as { p_event: string }).p_event === 'open').length;
    const opensBefore = opens();
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={reopened} />);

    // The same step, every answer and photo back, and the post goes on by itself.
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(screen.getByTestId('send-button')).toBeInTheDocument();
    expect(screen.getByTestId('intake-counter').textContent).toBe(counterBefore);
    const sent = mocks.submit.mock.calls[0][0] as { familySize: number; tenantName: string; tenantPhone: string; housePhotos: File[]; tenantPhoto: File; faceCheckSha256: string | null; draftId?: string };
    expect(sent).toMatchObject({ familySize: 4, tenantName: 'John Mukasa', faceCheckSha256: 'fresh' });
    expect(sent.housePhotos).toHaveLength(4);
    expect(sent.tenantPhoto).toBeInstanceOf(File);
    // The same funnel session goes on: no second 'open'.
    expect(opens()).toBe(opensBefore);
    release({ ok: true, rentRequestId: 'req-1', tenantExisting: false, activationLink: null, lcLetterFailed: false, intakeError: null, lc1AttachError: null, lc1NoteError: null });
    expect((await screen.findAllByText('Sent to the Service Centre')).length).toBeGreaterThan(0);
    // The kept chat is used up; the saved draft (E109) is closed as posted.
    expect(localStorage.getItem(T4_RESUME_KEY)).toBeNull();
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('posting_draft_close', expect.objectContaining({ p_draft_id: 'd1' })));
  });

  it('no newer build: Post sends at once, nothing kept, no reload', async () => {
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'new', draft: { id: 'd2', payload: fullPayload() } }} />);
    await finishAndPost();
    expect(mocks.findNewer).toHaveBeenCalled();
    expect(mocks.reloadTo).not.toHaveBeenCalled();
    expect(screen.queryByTestId('app-updating')).toBeNull();
    expect(localStorage.getItem(T4_RESUME_KEY)).toBeNull();
  });
});
