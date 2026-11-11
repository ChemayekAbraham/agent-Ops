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
}));
vi.mock('@/integrations/supabase/client', () => {
  const builder = () => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'order', 'limit', 'ilike', 'or']) b[m] = () => b;
    b.maybeSingle = async () => ({ data: null, error: null });
    b.single = async () => ({ data: null, error: null });
    return b;
  };
  return { supabase: { functions: { invoke: mocks.invoke }, rpc: mocks.rpc, from: builder } };
});
// One stable user object, as the real hook gives.
const auth = vi.hoisted(() => ({ user: { id: 'tenant-1', email: null, phone: null, user_metadata: {} }, loading: false }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));
vi.mock('@/hooks/useCaptureLocation', () => ({
  useCaptureLocation: () => ({ location: mocks.gps, loading: false, error: null, captureLocation: vi.fn() }),
}));
vi.mock('@/lib/invokeEdgeFunction', () => ({
  invokeEdgeFunction: vi.fn(async () => ({ data: { is_face: true, verdict: 'pass', failures: [] }, error: null })),
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
  vi.clearAllMocks();
  mocks.gps = { latitude: 0.3136, longitude: 32.5811, accuracy: 8 };
  mocks.landlordPhone = undefined;
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
const next = async () => {
  await waitFor(() => expect(continueBtn()).toBeEnabled());
  fireEvent.click(continueBtn());
};

function renderPage() {
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={['/tenants-onboarding']}>
        <TenantsOnboarding />
      </MemoryRouter>
    </HelmetProvider>,
  );
}

/** Walks steps 1-4; leaves the form on step 5 (landlord and LC1). */
async function fillToVerification({ housePhotos = 3, nin = 'CM9001234567AB', idFront = true, idBack = true } = {}) {
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: /Daily income earner/ }));
  await next();
  type('500,000', '300000');
  await next();
  type('e.g. Robert', 'Robert');
  type('e.g. Mugisha', 'Mugisha');
  type('0771 234 567', '0771234567');
  if (nin) type('CM9001234567AB', nin);
  type('e.g. Boda rider', 'Boda rider');
  type('e.g. 4', '4');
  // Step 3 photo boxes, in order: passport, ID front, ID back. Each box's input goes once it holds a photo.
  pickFile(fileInputs()[0]); // passport photo
  await waitFor(() => expect(screen.getByRole('img', { name: 'Passport photo' })).toBeInTheDocument());
  if (idFront) {
    pickFile(fileInputs()[0]);
    await waitFor(() => expect(screen.getByRole('img', { name: 'National ID — front' })).toBeInTheDocument());
  }
  if (idBack) {
    pickFile(fileInputs()[fileInputs().length - 1]);
    await waitFor(() => expect(screen.getByRole('img', { name: 'National ID — back' })).toBeInTheDocument());
  }
  if (!idFront || !idBack) return;
  await next();
  type('e.g. Plot 14, behind Kabalagala market', 'Plot 14, behind Kabalagala market');
  fireEvent.click(screen.getByRole('button', { name: 'Pick village' }));
  for (let i = 0; i < housePhotos; i++) {
    await waitFor(() => expect(fileInputs().length).toBeGreaterThan(0));
    pickFile(fileInputs()[fileInputs().length - 1]);
    await waitFor(() => expect(screen.getAllByRole('img', { name: /^House \d/ })).toHaveLength(i + 1));
  }
}

/** Step 5: the LC1 letter photo (the last photo box on the step). */
async function addLcLetter() {
  pickFile(fileInputs()[fileInputs().length - 1]);
  await waitFor(() => expect(screen.getByRole('img', { name: 'LC1 introduction letter' })).toBeInTheDocument());
}

describe('Tenant "Request rent here": Submit stays locked until everything is in', () => {
  it('happy path: creates the request, saves the intake, and shows the end screen', async () => {
    await fillToVerification();
    await next();
    fireEvent.click(screen.getByRole('button', { name: 'Pick landlord' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick LC1' }));
    await addLcLetter();
    await next();

    // Review: only the declaration is left, so Submit is still locked.
    const checklist = await screen.findByTestId('tenant-missing');
    expect(within(checklist).getAllByRole('listitem').map((li) => li.textContent?.replace('• ', ''))).toEqual(['Tick the box to confirm your details']);
    const submit = screen.getByRole('button', { name: /Submit rent request/ });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    await screen.findByTestId('tenant-ready');
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);

    expect(await screen.findByText('Sent to Welile. An agent near you will be assigned to visit and confirm your house.')).toBeInTheDocument();
    const submitCall = mocks.invoke.mock.calls.find(([, a]) => (a as { body: { action: string } }).body.action === 'submit');
    expect((submitCall![1] as { body: Record<string, unknown> }).body).toMatchObject({
      full_name: 'Robert Mugisha', national_id: 'CM9001234567AB', occupation: 'Boda rider',
      rent_amount: 300000, landlord_id: 'll-1', lc1_name: 'Sarah Namuli', lc1_phone: '0701000222',
      gps_lat: 0.3136, gps_lng: 32.5811,
    });
    expect(((submitCall![1] as { body: { house_photos: unknown[] } }).body.house_photos)).toHaveLength(3);
    // DOCS-1: both sides of the ID and the LC1 letter go to the server.
    const sent = (submitCall![1] as { body: Record<string, unknown> }).body;
    expect(sent.id_photo).toEqual(expect.stringMatching(/^data:image\/jpeg/));
    expect(sent.id_photo_back).toEqual(expect.stringMatching(/^data:image\/jpeg/));
    expect(sent.lc_letter).toEqual(expect.stringMatching(/^data:image\/jpeg/));
    expect(mocks.rpc).toHaveBeenCalledWith('tenant_save_intake_details', {
      p_request_id: 'req-1', p_family_size: 4, p_work_business: 'Boda rider', p_work_location: null,
      p_lc1_contact: 'Sarah Namuli, 0701000222', p_lc_letter_bucket: null, p_lc_letter_path: null,
    });
  });

  it('fewer than 3 house photos: cannot move past the house step', async () => {
    await fillToVerification({ housePhotos: 2 });
    expect(continueBtn()).toBeDisabled();
    pickFile(fileInputs()[fileInputs().length - 1]);
    await waitFor(() => expect(continueBtn()).toBeEnabled());
  });

  it('no GPS pin: cannot move past the house step', async () => {
    mocks.gps = null;
    await fillToVerification();
    expect(continueBtn()).toBeDisabled();
  });

  it('DOCS-1: no LC1 letter photo: cannot move on, even with the LC1 chairperson; the letter alone is enough', async () => {
    await fillToVerification();
    await next();
    fireEvent.click(screen.getByRole('button', { name: 'Pick landlord' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick LC1' }));
    expect(continueBtn()).toBeDisabled();
    await addLcLetter();
    await waitFor(() => expect(continueBtn()).toBeEnabled());
  });

  it('DOCS-1: no photo of the FRONT of the ID: cannot move past "About you"', async () => {
    await fillToVerification({ idFront: false });
    expect(continueBtn()).toBeDisabled();
  });

  it('DOCS-1: no photo of the BACK of the ID: cannot move past "About you"', async () => {
    await fillToVerification({ idBack: false });
    expect(continueBtn()).toBeDisabled();
  });

  it('the landlord’s phone cannot be the tenant’s', async () => {
    mocks.landlordPhone = '0771234567';
    await fillToVerification();
    await next();
    fireEvent.click(screen.getByRole('button', { name: 'Pick landlord' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick LC1' }));
    expect(screen.getByText('Your landlord’s phone must be different from yours.')).toBeInTheDocument();
    expect(continueBtn()).toBeDisabled();
  });

  it('DOCS-1: the NIN is optional when both ID photos are in', async () => {
    await fillToVerification({ nin: '' });
    // Reaching the house step with no NIN means it was not required.
    expect(screen.getByRole('button', { name: 'Pick village' })).toBeInTheDocument();
  });

  it('shows the intake server message as-is, and the request is still sent', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'INTAKE_FAMILY_SIZE_RANGE: 1-30' } });
    await fillToVerification();
    await next();
    fireEvent.click(screen.getByRole('button', { name: 'Pick landlord' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick LC1' }));
    await addLcLetter();
    await next();
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(screen.getByRole('button', { name: /Submit rent request/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Submit rent request/ }));
    expect(await screen.findByText('INTAKE_FAMILY_SIZE_RANGE: 1-30')).toBeInTheDocument();
    expect(screen.getByText('Sent to Welile. An agent near you will be assigned to visit and confirm your house.')).toBeInTheDocument();
  });

  it('shows the server’s error as-is when the request is refused', async () => {
    mocks.invoke.mockImplementation(async (_fn: string, { body }: { body: { action: string } }) => {
      if (body.action === 'submit') return { data: { error: 'Add the LC1 chairperson\'s name and phone, or a photo of the LC1 letter' }, error: null };
      return { data: { blocked: false }, error: null };
    });
    await fillToVerification();
    await next();
    fireEvent.click(screen.getByRole('button', { name: 'Pick landlord' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick LC1' }));
    await addLcLetter();
    await next();
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(screen.getByRole('button', { name: /Submit rent request/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Submit rent request/ }));
    expect(await screen.findByText(/Add the LC1 chairperson's name and phone, or a photo of the LC1 letter/)).toBeInTheDocument();
    expect(mocks.rpc).not.toHaveBeenCalledWith('tenant_save_intake_details', expect.anything());
  });
});
