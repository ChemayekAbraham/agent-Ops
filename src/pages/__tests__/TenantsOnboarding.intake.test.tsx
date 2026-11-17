import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  rpc: vi.fn(),
  gps: { latitude: 0.3136, longitude: 32.5811, accuracy: 8 } as { latitude: number; longitude: number; accuracy: number } | null,
  /** The picked landlord's phone; undefined means a different number from the tenant's. */
  landlordPhone: undefined as string | undefined,
  /** What the background photo check answers. */
  photoCheck: { is_face: true, verdict: 'pass', failures: [] } as Record<string, unknown>,
}));
vi.mock('@/integrations/supabase/client', () => {
  const builder = () => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'order', 'limit', 'ilike', 'or']) b[m] = () => b;
    b.maybeSingle = async () => ({ data: null, error: null });
    b.single = async () => ({ data: null, error: null });
    return b;
  };
  return { supabase: { functions: { invoke: mocks.invoke }, rpc: mocks.rpc, from: builder, auth: {
    getSession: async () => ({ data: { session: { user: { id: 'tenant-1' }, access_token: 'test-token' } }, error: null }),
  } } };
});
// One stable user object, as the real hook gives.
const auth = vi.hoisted(() => ({ user: { id: 'tenant-1', email: null, phone: null, user_metadata: {} }, loading: false }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));
vi.mock('@/hooks/useGpsCapture', () => ({
  useGpsCapture: () => ({
    location: mocks.gps && { lat: mocks.gps.latitude, lng: mocks.gps.longitude, accuracy: mocks.gps.accuracy, source: 'gps' },
    phase: mocks.gps ? 'done' : 'idle', failure: null, inAppBrowser: false, seconds: 0, capture: vi.fn(),
  }),
}));
vi.mock('@/lib/invokeEdgeFunction', () => ({
  invokeEdgeFunction: vi.fn(async () => ({ data: mocks.photoCheck, error: null })),
}));
vi.mock('@/lib/imageOptimizer', () => ({ optimizeImage: vi.fn(async (file: File) => ({ file, previewUrl: 'blob:preview' })) }));
vi.mock('@/components/shared/NationalIdConsentDialog', () => ({ NationalIdConsentDialog: () => null }));
vi.mock('@/components/location/UgLocationPicker', () => ({
  UgLocationPicker: ({ onChange }: { onChange: (v: unknown) => void }) => (
    <button type="button" onClick={() => onChange({ village: 'Kireka B', district: 'Wakiso', villageId: 7, region: 'Central', fullPath: 'Wakiso › Kira › Kireka B' })}>
      Pick village
    </button>
  ),
}));
vi.mock('@/components/agent/LandlordSearchSelect', () => ({
  LandlordSearchSelect: ({ onChange }: { onChange: (v: unknown) => void }) => (
    <button type="button" onClick={() => onChange({ id: 'll-1', name: 'Peter Okello', phone: mocks.landlordPhone ?? '0772000111', property_address: null, verified: true })}>
      Pick landlord
    </button>
  ),
}));
vi.mock('@/components/agent/Lc1ChairpersonPicker', () => ({
  Lc1ChairpersonPicker: ({ onChange }: { onChange: (v: unknown) => void }) => (
    <button type="button" onClick={() => onChange({ mode: 'new', name: 'Sarah Namuli', phone: '0701000222' })}>Pick LC1</button>
  ),
}));

import TenantsOnboarding from '@/pages/TenantsOnboarding';


beforeAll(() => {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});

beforeEach(() => {
  // The form keeps a draft (answers) on the device; each test starts fresh.
  localStorage.clear();
  vi.clearAllMocks();
  mocks.gps = { latitude: 0.3136, longitude: 32.5811, accuracy: 8 };
  mocks.landlordPhone = undefined;
  mocks.photoCheck = { is_face: true, verdict: 'pass', failures: [] };
  mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });
  mocks.invoke.mockImplementation(async (_fn: string, { body }: { body: { action: string } }) => {
    if (body.action === 'application_status') return { data: { blocked: false, stage: 'none' }, error: null };
    if (body.action === 'identity_check') return { data: { phone_known: false, nin_known: false }, error: null };
    if (body.action === 'submit') {
      return { data: { success: true, rent_request_id: 'req-1', lc_letter_bucket: null, lc_letter_path: null }, error: null };
    }
    return { data: null, error: null };
  });
});

const photo = (name = 'p.jpg') => new File(['x'], name, { type: 'image/jpeg' });
const pickFile = (input: Element) => fireEvent.change(input, { target: { files: [photo()] } });
const fileInputs = () => Array.from(document.querySelectorAll('input[type="file"]'));
const type = (placeholder: string, value: string) => fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
const continueBtn = () => screen.getByRole('button', { name: /^Continue/ });
const submitBtn = () => screen.getByRole('button', { name: /Submit rent request/ });
const counter = () => screen.getByTestId('intake-counter');
const leftBtn = () => screen.getByTestId('intake-left');
/** A step name in the header strip (tap = jump there). */
const stepChip = (n: number) => screen.getByLabelText(new RegExp(`^Step ${n}:`));
const next = async () => {
  await waitFor(() => expect(continueBtn()).toBeEnabled());
  fireEvent.click(continueBtn());
};
/** Adds the photo to the first empty photo box on the step and waits for it to show. */
async function addPhoto(alt: string, input = () => fileInputs()[0]) {
  pickFile(input());
  await waitFor(() => expect(screen.getByRole('img', { name: alt })).toBeInTheDocument());
}

function renderPage(path = '/tenants-onboarding') {
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={[path]}>
        <TenantsOnboarding />
      </MemoryRouter>
    </HelmetProvider>,
  );
}

interface FillOpts { housePhotos?: number; nin?: string; idFront?: boolean; idBack?: boolean; lcLetter?: boolean }

/** What each of the 8 steps needs, filled the way a tenant would. */
const FILL: Record<number, (o: FillOpts) => Promise<void>> = {
  1: async () => {
    type('0771 234 567', '0771234567');
    type('e.g. Robert', 'Robert');
    type('e.g. Mugisha', 'Mugisha');
  },
  2: async () => {
    fireEvent.click(screen.getByRole('button', { name: /Daily income earner/ }));
    type('500,000', '300000');
  },
  3: async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Pick landlord' }));
  },
  4: async ({ housePhotos = 3 }) => {
    type('e.g. Plot 14, behind Kabalagala market', 'Plot 14, behind Kabalagala market');
    fireEvent.click(screen.getByRole('button', { name: 'Pick village' }));
    for (let i = 0; i < housePhotos; i++) {
      await waitFor(() => expect(fileInputs().length).toBeGreaterThan(0));
      pickFile(fileInputs()[fileInputs().length - 1]);
      await waitFor(() => expect(screen.getAllByRole('img', { name: /^House \d/ })).toHaveLength(i + 1));
    }
  },
  5: async () => {
    type('e.g. 4', '4');
    type('e.g. Boda rider', 'Boda rider');
  },
  6: async () => {
    await addPhoto('Your photo');
  },
  7: async ({ nin = 'CM9001234567AB', idFront = true, idBack = true }) => {
    // Front box first, then back; a box's file input goes once it holds a photo.
    if (idFront) await addPhoto('National ID — front');
    if (idBack) await addPhoto('National ID — back', () => fileInputs()[fileInputs().length - 1]);
    if (nin) type('CM9001234567AB', nin);
  },
  8: async ({ lcLetter = true }) => {
    if (lcLetter) await addPhoto('LC1 introduction letter');
    fireEvent.click(screen.getByRole('button', { name: 'Pick LC1' }));
  },
};

/** Fills steps 1..last, pressing Continue between them; stays on step `last` (filled, not left). */
async function fillTo(last: number, opts: FillOpts & { path?: string } = {}) {
  renderPage(opts.path);
  await screen.findByTestId('intake-counter');
  for (let s = 1; s <= last; s++) {
    await FILL[s](opts);
    if (s < last) await next();
  }
}

/** Ticks the declaration on step 8 and sends. */
async function tickAndSubmit() {
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() => expect(submitBtn()).toBeEnabled());
  fireEvent.click(submitBtn());
}

describe('Tenant "Request rent here": the 8-step intake', () => {
  it('happy path: creates the request, saves the intake, and shows the end screen', async () => {
    await fillTo(8);

    // Step 8: only the declaration is left, so Submit is replaced by the "N left" button.
    expect(screen.queryByRole('button', { name: /Submit rent request/ })).toBeNull();
    expect(leftBtn()).toHaveTextContent('1 left: LC1 letter');
    const needed = screen.getByTestId('intake-needed');
    expect(within(needed).getByText('Tick the box to confirm your details').closest('li')).toHaveAttribute('data-done', 'no');
    expect(within(needed).getByText('A photo of the LC1 letter').closest('li')).toHaveAttribute('data-done', 'yes');
    await tickAndSubmit();

    expect(await screen.findByText('Sent to Welile. An agent near you will be assigned to visit and confirm your house.')).toBeInTheDocument();
    const submitCall = mocks.invoke.mock.calls.find(([, a]) => (a as { body: { action: string } }).body.action === 'submit');
    expect((submitCall![1] as { body: Record<string, unknown> }).body).toMatchObject({
      full_name: 'Robert Mugisha', national_id: 'CM9001234567AB', occupation: 'Boda rider',
      rent_amount: 300000, landlord_id: 'll-1', lc1_name: 'Sarah Namuli', lc1_phone: '0701000222',
      gps_lat: 0.3136, gps_lng: 32.5811,
    });
    expect(((submitCall![1] as { body: { house_photos: unknown[] } }).body.house_photos)).toHaveLength(3);
    // DOCS-1: both sides of the ID and the LC1 letter go to the server, with the tenant's photo.
    const sent = (submitCall![1] as { body: Record<string, unknown> }).body;
    expect(sent.tenant_photo).toEqual(expect.stringMatching(/^data:image\/jpeg/));
    expect(sent.id_photo).toEqual(expect.stringMatching(/^data:image\/jpeg/));
    expect(sent.id_photo_back).toEqual(expect.stringMatching(/^data:image\/jpeg/));
    expect(sent.lc_letter).toEqual(expect.stringMatching(/^data:image\/jpeg/));
    expect(mocks.rpc).toHaveBeenCalledWith('tenant_save_intake_details', {
      p_request_id: 'req-1', p_family_size: 4, p_work_business: 'Boda rider', p_work_location: null,
      p_lc1_contact: 'Sarah Namuli, 0701000222', p_lc_letter_bucket: null, p_lc_letter_path: null,
    });
  });

  it('the counter reads "Step N of 8 · X left" and updates from step to step', async () => {
    renderPage();
    await waitFor(() => expect(counter()).toHaveTextContent('Step 1 of 8 · 8 left'));
    await FILL[1]({});
    await waitFor(() => expect(counter()).toHaveTextContent('Step 1 of 8 · 7 left'));
    await next();
    expect(counter()).toHaveTextContent('Step 2 of 8 · 7 left');
    await FILL[2]({});
    await next();
    expect(counter()).toHaveTextContent('Step 3 of 8 · 6 left');
    await FILL[3]({});
    await next();
    expect(counter()).toHaveTextContent('Step 4 of 8 · 5 left');
    // Back keeps working; the count of steps left does not change.
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(counter()).toHaveTextContent('Step 3 of 8 · 5 left');
    // A step name in the strip jumps there.
    fireEvent.click(stepChip(6));
    expect(counter()).toHaveTextContent('Step 6 of 8 · 5 left');
    expect(screen.getByRole('heading', { name: 'A photo of you' })).toBeInTheDocument();
  });

  it('Submit is only on step 8; while steps are missing it is "N left: …" and jumps to the first incomplete step', async () => {
    renderPage();
    await screen.findByTestId('intake-counter');
    for (let s = 1; s <= 7; s++) {
      fireEvent.click(stepChip(s));
      expect(screen.queryByRole('button', { name: /Submit rent request/ })).toBeNull();
      expect(screen.queryByTestId('intake-left')).toBeNull();
    }
    fireEvent.click(stepChip(8));
    expect(leftBtn()).toHaveTextContent('8 left: Tenant, Rent plan, Landlord, House, Household, Photo, ID, LC1 letter');
    expect(screen.queryByRole('button', { name: /Submit rent request/ })).toBeNull();
    fireEvent.click(leftBtn());
    expect(counter()).toHaveTextContent('Step 1 of 8');

    // Steps 1-3 done: the button names what is left and opens House.
    await FILL[1]({}); await next();
    await FILL[2]({}); await next();
    await FILL[3]({});
    fireEvent.click(stepChip(8));
    await waitFor(() => expect(leftBtn()).toHaveTextContent('5 left: House, Household, Photo, ID, LC1 letter'));
    fireEvent.click(leftBtn());
    expect(counter()).toHaveTextContent('Step 4 of 8 · 5 left');
    expect(screen.getByRole('button', { name: 'Pick village' })).toBeInTheDocument();
  });

  it('a photo with no face found does not block: it is advice, and the step is done', async () => {
    mocks.photoCheck = { is_face: false, verdict: 'fail', failures: [] };
    renderPage();
    await screen.findByTestId('intake-counter');
    fireEvent.click(stepChip(6));
    expect(continueBtn()).toBeDisabled(); // a missing photo blocks
    await FILL[6]({});
    expect(await screen.findByText('We could not see a face clearly in this photo. You can retake it, or continue.')).toBeInTheDocument();
    expect(screen.queryByText(/No face was found/)).toBeNull();
    await waitFor(() => expect(continueBtn()).toBeEnabled());
    expect(within(screen.getByTestId('intake-needed')).getByText('A clear photo of you').closest('li')).toHaveAttribute('data-done', 'yes');
    expect(stepChip(6)).toHaveAccessibleName('Step 6: Tenant’s photo, done');
    await next();
    expect(counter()).toHaveTextContent('Step 7 of 8');
  });

  it('a saved draft reopens on the first incomplete step', async () => {
    localStorage.setItem('welile_tenant_onboarding_draft_tenant-1', JSON.stringify({
      earner: 'daily', rentInput: '300000', durationDays: 30, firstName: 'Robert', lastName: 'Mugisha', phone: '0771234567',
      landlord: { id: 'll-1', name: 'Peter Okello', phone: '0772000111', property_address: null, verified: true },
    }));
    renderPage();
    await waitFor(() => expect(counter()).toHaveTextContent('Step 4 of 8 · 5 left'));
    expect(screen.getByRole('button', { name: 'Pick village' })).toBeInTheDocument();
  });

  it('rent field: "Monthly rent (one month only)" with the Landlord Ops note', async () => {
    await fillTo(2);
    const rent = screen.getByLabelText(/Monthly rent \(one month only\)/);
    expect(rent).toHaveAttribute('placeholder', '500,000');
    expect(rent).toHaveAccessibleDescription('If the landlord wants several months together, enter ONE month. Landlord Ops will confirm the monthly rent with the landlord.');
  });

  it('fewer than 3 house photos: cannot move past the house step', async () => {
    await fillTo(4, { housePhotos: 2 });
    expect(continueBtn()).toBeDisabled();
    pickFile(fileInputs()[fileInputs().length - 1]);
    await waitFor(() => expect(continueBtn()).toBeEnabled());
  });

  it('no GPS pin: cannot move past the house step', async () => {
    mocks.gps = null;
    await fillTo(4);
    expect(continueBtn()).toBeDisabled();
  });

  it('DOCS-1: no LC1 letter photo: no Submit, even with the LC1 chairperson; the letter alone is enough', async () => {
    await fillTo(8, { lcLetter: false });
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(leftBtn()).toHaveTextContent('1 left: LC1 letter'));
    expect(screen.queryByRole('button', { name: /Submit rent request/ })).toBeNull();
    await addPhoto('LC1 introduction letter');
    await waitFor(() => expect(submitBtn()).toBeEnabled());
  });

  it('DOCS-1: no photo of the FRONT of the ID: cannot move past the ID step', async () => {
    await fillTo(7, { idFront: false });
    expect(continueBtn()).toBeDisabled();
  });

  it('DOCS-1: no photo of the BACK of the ID: cannot move past the ID step', async () => {
    await fillTo(7, { idBack: false });
    expect(continueBtn()).toBeDisabled();
  });

  it('the landlord’s phone cannot be the tenant’s', async () => {
    mocks.landlordPhone = '0771234567';
    await fillTo(3);
    expect(screen.getByText('Your landlord’s phone must be different from yours.')).toBeInTheDocument();
    expect(within(screen.getByTestId('intake-needed')).getByText('Your landlord’s phone must be different from yours')).toBeInTheDocument();
    expect(continueBtn()).toBeDisabled();
  });

  it('DOCS-1: the NIN is optional when both ID photos are in', async () => {
    await fillTo(7, { nin: '' });
    await next();
    // Reaching the last step with no NIN means it was not required.
    expect(counter()).toHaveTextContent('Step 8 of 8 · 1 left');
  });

  it('shows the intake server message as-is, and the request is still sent', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'INTAKE_FAMILY_SIZE_RANGE: 1-30' } });
    await fillTo(8);
    await tickAndSubmit();
    expect(await screen.findByText('INTAKE_FAMILY_SIZE_RANGE: 1-30')).toBeInTheDocument();
    expect(screen.getByText('Sent to Welile. An agent near you will be assigned to visit and confirm your house.')).toBeInTheDocument();
  });

  it('shows the server’s error as-is when the request is refused', async () => {
    mocks.invoke.mockImplementation(async (_fn: string, { body }: { body: { action: string } }) => {
      if (body.action === 'submit') return { data: { error: 'Add the LC1 chairperson\'s name and phone, or a photo of the LC1 letter' }, error: null };
      return { data: { blocked: false }, error: null };
    });
    await fillTo(8);
    await tickAndSubmit();
    expect(await screen.findByText(/Add the LC1 chairperson's name and phone, or a photo of the LC1 letter/)).toBeInTheDocument();
    expect(mocks.rpc).not.toHaveBeenCalledWith('tenant_save_intake_details', expect.anything());
  });
});

describe('E107: landlord referral code (Landlord step)', () => {
  // The page keeps a draft (with the code) in localStorage; each test starts clean.
  beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });

  it('?ref=L4K7Q2M9X fills the optional code field; an agent id in ?ref does not', async () => {
    await fillTo(3, { path: '/tenants-onboarding?ref=l4k7q2m9x' });
    expect(screen.getByLabelText('Landlord referral code')).toHaveValue('L4K7Q2M9X');
    // A landlord code is not an agent: it is never sent as the tenant's referrer.
    expect(mocks.rpc).not.toHaveBeenCalledWith('claim_tenant_referrer', expect.anything());
  });

  it('an agent invite link (?ref=<agent id>) leaves the code empty and still claims the agent', async () => {
    const agentId = '11111111-2222-4333-8444-555555555555';
    await fillTo(3, { path: `/tenants-onboarding?ref=${agentId}&become=tenant` });
    expect(screen.getByLabelText('Landlord referral code')).toHaveValue('');
    expect(mocks.rpc).toHaveBeenCalledWith('claim_tenant_referrer', { p_referrer_id: agentId });
  });

  it('an unknown code never blocks: the request is sent and "Code not recognised" is shown', async () => {
    mocks.rpc.mockImplementation(async (fn: string) => (
      fn === 'landlord_referral_record' ? { data: { ok: false, reason: 'unknown_code' }, error: null } : { data: { ok: true }, error: null }
    ));
    await fillTo(8, { path: '/tenants-onboarding?ref=LZZZZZZZZ' });
    await tickAndSubmit();

    expect(await screen.findByText('Sent to Welile. An agent near you will be assigned to visit and confirm your house.')).toBeInTheDocument();
    expect(mocks.rpc).toHaveBeenCalledWith('landlord_referral_record', { p_rent_request_id: 'req-1', p_code: 'LZZZZZZZZ' });
    expect(screen.getByTestId('landlord-referral-note')).toHaveTextContent('Landlord referral code LZZZZZZZZ: Code not recognised. Your request was still sent.');
  });

  it('a code typed by hand is recorded too; no code means no call', async () => {
    await fillTo(3);
    fireEvent.change(screen.getByLabelText('Landlord referral code'), { target: { value: 'l4k7-q2m9x' } });
    expect(screen.getByLabelText('Landlord referral code')).toHaveValue('L4K7Q2M9X');
    for (let s = 4; s <= 8; s++) {
      await next();
      await FILL[s]({});
    }
    await tickAndSubmit();
    expect(await screen.findByText(/Sent to Welile\. An agent near you/)).toBeInTheDocument();
    expect(mocks.rpc).toHaveBeenCalledWith('landlord_referral_record', { p_rent_request_id: 'req-1', p_code: 'L4K7Q2M9X' });
    expect(screen.queryByTestId('landlord-referral-note')).toBeNull();
  });
});

describe('E108 funnel: steps use the intake step keys; a blocked press sends the right item codes', () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });

  const funnelLogs = () => mocks.rpc.mock.calls.filter(([fn]) => fn === 'request_form_log').map(([, row]) => row as Record<string, unknown>);

  it('Continue with 2 house photos is a blocked press on "house_photos" in the tenant_self session', async () => {
    await fillTo(4, { housePhotos: 2 });
    expect(continueBtn()).toBeDisabled();
    // A tap on the disabled button lands on its wrapper.
    fireEvent.click(screen.getByTestId('continue-wrap'));
    await waitFor(() => expect(funnelLogs().at(-1)?.p_event).toBe('blocked'));
    const logs = funnelLogs();
    expect(logs[0]).toMatchObject({ p_event: 'open', p_form: 'tenant_self' });
    expect(logs.filter((r) => r.p_event === 'step').map((r) => r.p_step)).toEqual(['tenant', 'rent_plan', 'landlord', 'house']);
    expect(logs.at(-1)).toMatchObject({ p_event: 'blocked', p_items: ['house_photos'], p_step: 'house', p_form: 'tenant_self' });
    expect(new Set(logs.map((r) => r.p_session)).size).toBe(1);
  });

  it('the "N left" button on step 8 is a blocked press on what is missing', async () => {
    await fillTo(8, { lcLetter: false });
    fireEvent.click(leftBtn());
    await waitFor(() => expect(funnelLogs().at(-1)).toMatchObject({ p_event: 'blocked', p_items: ['lc1_letter', 'agreement'], p_step: 'lc1_post' }));
  });

  it('a successful submit logs submit_ok with the request id', async () => {
    await fillTo(8);
    await tickAndSubmit();
    expect(await screen.findByText(/Sent to Welile\. An agent near you/)).toBeInTheDocument();
    expect(mocks.rpc).toHaveBeenCalledWith('request_form_log', expect.objectContaining({ p_event: 'submit_ok', p_rent_request_id: 'req-1', p_form: 'tenant_self' }));
  });
});
