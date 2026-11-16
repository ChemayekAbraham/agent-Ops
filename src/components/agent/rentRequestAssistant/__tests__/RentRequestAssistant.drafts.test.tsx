/**
 * E109 "Save and finish later" in the agent rent request chat: save, the Saved list,
 * Continue at the first missing item, and the post closing the draft.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  submit: vi.fn(),
  open: vi.fn(),
  drafts: { data: [] as unknown, error: null as unknown },
  gate: { blocked: false, vetted: true, funding_frozen: false, notice: null } as Record<string, unknown>,
  faceCheck: vi.fn(),
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
import { PostingDraftsList } from '@/components/agent/PostingDraftsList';
import { resetDraftsAvailability, MAX_DRAFT_BYTES, type PostingDraftPayload } from '@/lib/postingDrafts';

beforeAll(() => {
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});

const PGRST202 = { code: 'PGRST202', message: 'Could not find the function public.posting_drafts_mine in the schema cache' };

beforeEach(() => {
  vi.clearAllMocks();
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

describe('E109: save and finish later', () => {
  it('a blocked Next offers it; saving sends the payload and missing codes, says when we remind, and logs close', async () => {
    render(<RentRequestAssistant open onOpenChange={vi.fn()} />);
    answer('0783 123 456'); // the first screen is the tenant's phone number
    fireEvent.click(await screen.findByRole('button', { name: /Weekly earner/ }));
    answer('about three hundred'); // the rent question refuses it: a blocked Next
    const save = await screen.findByRole('button', { name: 'Save and finish later' });
    fireEvent.click(save);
    expect(await screen.findByText("Saved. We'll remind you tomorrow at 8am.")).toBeInTheDocument();

    const call = mocks.rpc.mock.calls.find(([fn]) => fn === 'posting_draft_save');
    const args = call![1] as { p_payload: PostingDraftPayload; p_missing: string[]; p_draft_id: string | null; p_session: string };
    expect(args.p_draft_id).toBeNull();
    expect(args.p_missing).toEqual(expect.arrayContaining(['rent', 'house_photos', 'landlord', 'gps', 'id_front', 'id_back', 'lc1_letter', 'tenant_photo']));
    expect(args.p_payload.fields.planType).toBe('weekly');
    // Never saved: the face-check result and guarantor consent.
    expect(args.p_payload.fields).not.toHaveProperty('faceCheck');
    expect(args.p_payload.fields).not.toHaveProperty('consent');
    expect(new Blob([JSON.stringify(args.p_payload)]).size).toBeLessThan(MAX_DRAFT_BYTES);
    expect(args.p_session).toBe(logs('open')[0].p_session);
    expect(logs('close').at(-1)).toMatchObject({ p_meta: expect.objectContaining({ saved_draft: true }) });

    // A second save updates the same draft.
    fireEvent.click(screen.getByRole('button', { name: 'Save changes for later' }));
    await waitFor(() => expect(mocks.rpc.mock.calls.filter(([fn]) => fn === 'posting_draft_save')).toHaveLength(2));
    expect((mocks.rpc.mock.calls.filter(([fn]) => fn === 'posting_draft_save')[1][1] as { p_draft_id: string }).p_draft_id).toBe('d1');
  });

  it('is hidden while the draft RPCs are not on the database', async () => {
    mocks.drafts = { data: null, error: PGRST202 };
    render(<RentRequestAssistant open onOpenChange={vi.fn()} />);
    answer('0783 123 456'); // the first screen is the tenant's phone number
    fireEvent.click(await screen.findByRole('button', { name: /Weekly earner/ }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('posting_drafts_mine', {}));
    answer('about three hundred');
    expect(await screen.findByText(/didn’t catch an amount/)).toBeInTheDocument();
    expect(screen.queryByTestId('save-draft')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save and finish later' })).toBeNull();
  });

  it('save → Saved list → Continue at the first missing item → post closes the draft', async () => {
    const payload = fullPayload();
    expect(new Blob([JSON.stringify(payload)]).size).toBeLessThan(MAX_DRAFT_BYTES);
    mocks.drafts = { data: [{ id: 'd1', tenant_name: 'John Mukasa', tenant_phone: '0783123456', missing: 'Family size', expires_at: '2026-11-23T08:00:00Z', payload }], error: null };

    // The Saved list: Continue opens the chat with the saved request.
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <PostingDraftsList />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Missing: Family size')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const request = mocks.open.mock.calls[0][0];
    expect(request).toMatchObject({ mode: 'new', draft: { id: 'd1' } });

    // The chat opens at the first missing item, everything else filled in.
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={request} />);
    await finishAndPost();
    const sent = mocks.submit.mock.calls[0][0] as { familySize: number; housePhotos: File[]; tenantName: string; faceCheckSha256: string | null };
    // The face photo was checked again on Continue; the stored result ('abc') was not used.
    expect(mocks.faceCheck).toHaveBeenCalledWith(expect.any(File), { source: 'agent_rent_request' });
    expect(sent.faceCheckSha256).toBe('fresh');
    expect(sent.familySize).toBe(4);
    expect(sent.housePhotos).toHaveLength(4);
    expect(sent.tenantName).toBe('John Mukasa');
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('posting_draft_close', { p_draft_id: 'd1', p_status: 'posted', p_rent_request_id: 'req-1' }));
  });
});

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

describe('Saved drafts: the face check runs again on Continue', () => {
  it('a draft whose stored check says "passed" but whose photo fails now is caught: it opens at the face photo', async () => {
    mocks.faceCheck.mockResolvedValue({ status: 'no_face', verdict: 'fail', isFace: false, isPassportPhoto: false, sha256: 'bad' });
    // The saved payload claims a passed check (older drafts carried one).
    const payload = fullPayload();
    expect(payload.fields.faceCheck).toMatchObject({ status: 'ok', verdict: 'pass' });
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'new', draft: { id: 'd2', payload } }} />);
    expect((await screen.findAllByText(/Now the tenant’s face photo \(head and shoulders\) of John/, {}, { timeout: 3000 })).length).toBeGreaterThan(0);
    expect(mocks.faceCheck).toHaveBeenCalledWith(expect.any(File), { source: 'agent_rent_request' });
    // The photo comes first (ahead of the missing family size), with the reason, and nothing is posted.
    expect(await screen.findByText('No face found. Tap the photo to retake it.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Post rent request/ })).toBeNull();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});

const NOTICE = 'You can post rent requests. They wait at the COO until you complete your agent verification.';

describe('E111: agents always post', () => {
  it('an unverified agent opens the form, sees the notice, posts, and sees it again on the sent screen', async () => {
    mocks.gate = { blocked: false, vetted: false, funding_frozen: true, notice: NOTICE };
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'new', draft: { id: 'd9', payload: fullPayload() } }} />);
    const top = await screen.findByTestId('vetting-notice');
    expect(top).toHaveTextContent(NOTICE);
    expect(within(top).getByRole('link', { name: 'Complete verification' })).toHaveAttribute('href', '/dashboard/agent/verification');
    expect(mocks.rpc).toHaveBeenCalledWith('agent_vetting_gate_status', { p_agent_id: 'agent-1' });
    await finishAndPost();
    expect((await screen.findAllByText('Sent to the Service Centre')).length).toBeGreaterThan(0);
    expect(screen.getByTestId('vetting-notice')).toHaveTextContent(NOTICE);
    expect(screen.queryByTestId('vetting-blocked')).toBeNull();
  });

  it('only blocked = true stops posting, with the old block', async () => {
    mocks.gate = { blocked: true, vetted: false, funding_frozen: true, notice: NOTICE, reason: 'Agent Ops must verify you first.' };
    const seen = vi.fn();
    window.addEventListener('agent-not-vetted', seen);
    render(<RentRequestAssistant open onOpenChange={vi.fn()} />);
    expect(await screen.findByTestId('vetting-blocked')).toHaveTextContent('Complete your agent verification to post rent requests. Agent Ops must verify you first.');
    await waitFor(() => expect(seen).toHaveBeenCalled());
    expect(screen.queryByLabelText('Your answer')).toBeNull();
    expect(screen.queryByRole('button', { name: /Weekly earner/ })).toBeNull();
    expect(screen.queryByTestId('vetting-notice')).toBeNull();
    window.removeEventListener('agent-not-vetted', seen);
  });
});

describe('Agent chat fixes (16 Nov): first screen, face check timeout, photo refusal', () => {
  it('the first screen is the tenant’s phone number, the greeting a small line above it; "start" is logged only after the first answer', async () => {
    render(<RentRequestAssistant open onOpenChange={vi.fn()} />);
    expect(await screen.findAllByText('What’s the tenant’s phone number? 📱')).not.toHaveLength(0);
    expect(screen.getByLabelText('Your answer')).toBeInTheDocument();
    expect(screen.getByTestId('greeting')).toHaveTextContent(/Good (morning|afternoon|evening), Agent/);
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    // No greeting step and no extra Continue before the first question.
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Weekly earner/ })).toBeNull();
    await waitFor(() => expect(logs('open').length).toBeGreaterThan(0));
    expect(logs('step')).toHaveLength(0);
    answer('0783 123 456');
    expect(await screen.findByRole('button', { name: /Weekly earner/ })).toBeInTheDocument();
    await waitFor(() => expect(logs('step').map((r) => r.p_step)).toEqual(['start', 'repayment']));
  });

  it('face check timeout: after 15 s the agent can continue, the post sends face_check skipped_timeout, and the funnel logs it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // The checker never answers (a slow network).
      mocks.faceCheck.mockImplementation(() => new Promise(() => {}));
      render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'new', draft: { id: 'd3', payload: fullPayload() } }} />);
      await waitFor(() => expect(mocks.faceCheck).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(15_000);
      // Not stuck on the photo: the chat moves on to what is really missing.
      expect((await screen.findAllByText(/How many people live in John’s household/, {}, { timeout: 3000 })).length).toBeGreaterThan(0);
      answer('4');
      // The face photo step says why it was not checked, and Continue goes on.
      fireEvent.click(await screen.findByRole('button', { name: 'Change answer: Face photo taken' }));
      expect(await screen.findByTestId('face-check-status')).toHaveTextContent(
        'Couldn’t check the face — slow network. You can continue; the office will check it.',
      );
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      fireEvent.click(await screen.findByLabelText('Guarantor consent'));
      const post = await screen.findByRole('button', { name: /Post rent request/ });
      await waitFor(() => expect(post).toBeEnabled());
      fireEvent.click(post);
      await waitFor(() => expect(mocks.submit).toHaveBeenCalled());
      expect(mocks.submit.mock.calls[0][0]).toMatchObject({ faceCheck: 'skipped_timeout', faceCheckSha256: null });
      expect(logs('blocked')).toContainEqual(expect.objectContaining({ p_items: ['tenant_photo'], p_error: 'face_check_timeout' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('a server refusal about the face photo is said in plain words and reopens the face photo step', async () => {
    mocks.submit.mockResolvedValueOnce({ ok: false, reason: 'other', message: 'enforce_rent_request_tenant_photo: tenant_photo_url is required' });
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'new', draft: { id: 'd4', payload: fullPayload() } }} />);
    await finishAndPost();
    expect(await screen.findByText('The tenant’s face photo is missing. Take it now: head and shoulders, face clear.')).toBeInTheDocument();
    expect(screen.getByTestId('face-check-status')).toBeInTheDocument();
    expect(screen.queryByText(/enforce_rent_request_tenant_photo/)).toBeNull();
  });
});
