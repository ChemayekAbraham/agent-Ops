import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AgentRejectedRequest } from '@/hooks/useAgentRejectedRequests';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  /** Table rows by name; 'rent_requests:open' answers the open-request look-up (the query that filters by status). */
  tables: {} as Record<string, unknown>,
  openQueries: [] as { tenantId: unknown; except: unknown; statuses: unknown }[],
  renewalStart: vi.fn(),
  update: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => {
  const builder = (table: string) => {
    const state: { filters: Record<string, unknown>; statuses: unknown; except: unknown } = { filters: {}, statuses: null, except: null };
    const rows = () => {
      if (table === 'rent_requests' && state.statuses) {
        mocks.openQueries.push({ tenantId: state.filters.tenant_id, except: state.except, statuses: state.statuses });
        return mocks.tables['rent_requests:open'] ?? [];
      }
      return mocks.tables[table] ?? null;
    };
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.order = () => b;
    b.is = () => b;
    b.eq = (col: string, v: unknown) => { state.filters[col] = v; return b; };
    b.in = (_col: string, v: unknown) => { state.statuses = v; return b; };
    b.neq = (_col: string, v: unknown) => { state.except = v; return b; };
    b.update = (v: unknown) => { mocks.update(table, v); return b; };
    b.insert = () => b;
    b.limit = async () => ({ data: rows(), error: null });
    b.maybeSingle = async () => ({ data: rows(), error: null });
    b.single = async () => ({ data: rows(), error: null });
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve);
    return b;
  };
  return {
    supabase: {
      rpc: mocks.rpc,
      from: builder,
      storage: { from: () => ({ upload: vi.fn(async () => ({ error: null })), getPublicUrl: (p: string) => ({ data: { publicUrl: p } }) }) },
    },
  };
});
// One stable user object, as the real hook gives.
const auth = vi.hoisted(() => ({ user: { id: 'agent-1', user_metadata: { full_name: 'Agent One' } } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));
vi.mock('@/hooks/useAgentCapacityMap', () => ({ useAgentCapacityMap: () => ({ data: undefined, isLoading: false }), DAILY_ELIGIBILITY_THRESHOLD: 0.5 }));
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
vi.mock('@/components/agent/RenewalDialog', () => ({ useRenewalFlow: () => ({ start: mocks.renewalStart, dialogs: null }) }));
// The shared setup's haptics stub has no hapticSuccess, which the "sent" screen calls.
vi.mock('@/lib/haptics', () => ({ hapticTap: () => {}, hapticSelection: () => {}, hapticSuccess: () => {} }));
vi.mock('@/lib/imageOptimizer', () => ({ optimizeImage: vi.fn(async (file: File) => ({ file, previewUrl: 'blob:preview' })) }));
vi.mock('@/components/agent/LandlordSearchSelect', () => ({ LandlordSearchSelect: () => null }));
vi.mock('@/components/agent/RegisterLandlordDialog', () => ({ default: () => null }));
vi.mock('@/components/location/UgLocationPicker', () => ({ UgLocationPicker: () => null, default: () => null }));
vi.mock('@/components/agent/GuarantorConsentCheckbox', () => ({ GuarantorConsentCheckbox: () => null }));
vi.mock('@/components/agent/rentRequestAssistant/Lc1SearchStep', () => ({ Lc1SearchStep: () => null }));

import RentRequestAssistant from '@/components/agent/rentRequestAssistant/RentRequestAssistant';

beforeAll(() => {
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});

const PHOTOS = ['https://cdn/1.jpg', 'https://cdn/2.jpg', 'https://cdn/3.jpg', 'https://cdn/4.jpg'];
const TENANT = {
  full_name: 'John Mukasa', phone: '0783123456', occupation: null,
  national_id: 'CM12345678ABCD', linked_national_id: null, national_id_photo_path: null, national_id_card_number: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.openQueries = [];
  mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });
  mocks.tables = {
    profiles: { ...TENANT },
    pipeline_intake_details: null,
    rent_requests: { tenant_id: 'tenant-1', landlord_id: 'll-1', rent_amount: 300000, house_image_urls: PHOTOS, request_latitude: 0.33, request_longitude: 32.58, lc_letter_path: 'agent-1/req-9/lc_letter.jpg' },
    'rent_requests:open': [],
  };
});

const rejectedRequest = (over: Partial<AgentRejectedRequest> = {}) => ({
  id: 'req-9', rent_amount: 300000, duration_days: 30, number_of_payments: 4, daily_repayment: 14000, total_repayment: 420000,
  access_fee: 1, request_fee: 1, status: 'rejected', created_at: '2026-11-01T08:00:00Z', rejected_at: '2026-11-02T08:00:00Z',
  rejected_at_stage: 'service_center', rejected_reason: 'Family size and work are missing', reopen_count: 1, tenant_id: 'tenant-1',
  landlord_id: 'll-1', tenant_water_meter: null, tenant_electricity_meter: null, request_latitude: 0.33, request_longitude: 32.58,
  lc1_id: 'lc1-1', house_category: 'single-room', preferred_language: 'English', tenant_no_smartphone: false,
  registration_type: 'agent_registered', initial_outstanding_balance: null, outstanding_grace_days: null,
  house_image_urls: PHOTOS, lc_letter_path: 'agent-1/req-9/lc_letter.jpg', lc_letter_bucket: 'lc-letters',
  tenant_ops_reviewed_by: null, tenant_ops_reviewed_at: null, agent_verified_by: null, agent_verified_at: null,
  landlord_ops_reviewed_by: null, landlord_ops_reviewed_at: null, coo_reviewed_by: null, coo_reviewed_at: null,
  cfo_reviewed_by: null, cfo_reviewed_at: null, tenant_name: 'John Mukasa', tenant_phone: '0783123456', landlord_name: 'Peter Okello',
  ...over,
}) as AgentRejectedRequest;

const answer = (text: string) => {
  fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
};
const group = (which: 'gate' | 'form') => screen.queryByTestId(`t4-missing-${which}`);
const listed = (which: 'gate' | 'form') => {
  const g = group(which);
  return g ? within(g).getAllByRole('listitem').map((li) => li.textContent?.replace('• ', '')) : [];
};
const fix = (label: RegExp) => fireEvent.click(within(screen.getByTestId('t4-missing')).getByRole('button', { name: label }));
const sendButton = () => screen.getByRole('button', { name: /Resubmit rent request|Renew Rent Plan/ });

describe('T4 resubmit', () => {
  it('keeps Resubmit off until every gate item is in, then lands the request at the Service Centre', async () => {
    const onSuccess = vi.fn();
    const onDone = vi.fn();
    render(<RentRequestAssistant open onOpenChange={vi.fn()} onSuccess={onSuccess} request={{ mode: 'resubmit', rejected: rejectedRequest(), onDone }} />);

    expect(await screen.findByText(/Family size and work are missing/)).toBeInTheDocument();
    await waitFor(() => expect(listed('gate')).toEqual(['Family size', 'Work / business']));
    expect(listed('form')).toEqual(['What you changed (at least 10 characters)']);
    expect(sendButton()).toBeDisabled();
    // The open-request look-up leaves out the request being resubmitted.
    expect(mocks.openQueries[0]).toMatchObject({ tenantId: 'tenant-1', except: 'req-9' });

    fix(/Family size/);
    answer('5');
    await waitFor(() => expect(listed('gate')).toEqual(['Work / business']));
    fix(/Work \/ business/);
    answer('Tailor');
    await waitFor(() => expect(group('gate')).toBeNull());
    fix(/What you changed/);
    answer('short');
    expect(await screen.findByText(/at least 10 characters ✍️/)).toBeInTheDocument();
    answer('Added family size and work');

    await screen.findByTestId('t4-ready');
    await waitFor(() => expect(sendButton()).toBeEnabled());
    fireEvent.click(sendButton());

    expect(await screen.findAllByText('Sent to the Service Centre')).not.toHaveLength(0);
    const calls = mocks.rpc.mock.calls.filter(([fn]) => String(fn).startsWith('agent_'));
    expect(calls).toEqual([
      ['agent_resubmit_rent_request', { p_request_id: 'req-9', p_patch: {}, p_agent_note: 'Added family size and work' }],
      ['agent_save_intake_details', { p_request_id: 'req-9', p_family_size: 5, p_work_business: 'Tailor', p_work_location: null }],
    ]);
    expect(onSuccess).toHaveBeenCalledWith('req-9');
    expect(onDone).toHaveBeenCalledWith('req-9');
  });

  it('work counts as in when the tenant’s profile has an occupation', async () => {
    mocks.tables.profiles = { ...TENANT, occupation: 'Boda rider' };
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest() }} />);
    await waitFor(() => expect(listed('gate')).toEqual(['Family size']));
  });

  it('shows the server error as-is and stays on the review', async () => {
    mocks.tables.pipeline_intake_details = { family_size: 4, work_business: 'Tailor', work_location: null, lc1_phone_confirmation: null };
    mocks.rpc.mockImplementation(async (fn: string) => (fn === 'agent_resubmit_rent_request'
      ? { data: null, error: { message: 'RESUBMIT_CAP_REACHED: 5/5' } }
      : { data: { ok: true }, error: null }));
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest() }} />);
    await waitFor(() => expect(group('gate')).toBeNull());
    fix(/What you changed/);
    answer('Fixed the landlord details');
    await waitFor(() => expect(sendButton()).toBeEnabled());
    fireEvent.click(sendButton());
    expect(await screen.findByText('RESUBMIT_CAP_REACHED: 5/5')).toBeInTheDocument();
    expect(screen.queryByText('Sent to the Service Centre')).toBeNull();
  });
});

describe('the three new gate items', () => {
  const ready = { family_size: 4, work_business: 'Tailor', work_location: null, lc1_phone_confirmation: null };

  it('fewer than 3 house photos: listed, Send stays off', async () => {
    mocks.tables.pipeline_intake_details = ready;
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest({ house_image_urls: PHOTOS.slice(0, 2) }) }} />);
    await waitFor(() => expect(listed('gate')).toEqual(['At least 3 house photos']));
    fix(/What you changed/);
    answer('Fixed the landlord details');
    await waitFor(() => expect(listed('form')).toEqual([]));
    expect(sendButton()).toBeDisabled();
  });

  it('3 house photos are enough for the gate', async () => {
    mocks.tables.pipeline_intake_details = ready;
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest({ house_image_urls: PHOTOS.slice(0, 3) }) }} />);
    await waitFor(() => expect(group('gate')).toBeNull());
  });

  it('no tenant ID on file: asks for the NIN, and the item clears once it is typed', async () => {
    mocks.tables.pipeline_intake_details = ready;
    mocks.tables.profiles = { ...TENANT, national_id: null };
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest() }} />);
    await waitFor(() => expect(listed('gate')).toEqual(['Tenant’s ID: type the NIN']));
    fix(/Tenant’s ID/);
    expect(await screen.findAllByText(/Now the NIN from John’s National ID card/)).not.toHaveLength(0);
    answer('CM12345678ABCD');
    await waitFor(() => expect(group('gate')).toBeNull());
  });

  it('another ID field on the profile counts (linked ID, ID photo or card number)', async () => {
    mocks.tables.pipeline_intake_details = ready;
    mocks.tables.profiles = { ...TENANT, national_id: null, national_id_photo_path: 'ids/tenant-1/front.jpg' };
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest() }} />);
    await waitFor(() => expect(group('gate')).toBeNull());
  });

  it('another open request for the tenant: names its status and blocks Send', async () => {
    mocks.tables.pipeline_intake_details = ready;
    mocks.tables['rent_requests:open'] = [{ id: 'req-other', status: 'agent_ops_approved' }];
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest() }} />);
    await waitFor(() => expect(listed('gate')).toEqual(['This tenant already has an open request (status agent_ops_approved)']));
    fix(/What you changed/);
    answer('Fixed the landlord details');
    await waitFor(() => expect(listed('form')).toEqual([]));
    expect(sendButton()).toBeDisabled();
    expect(mocks.openQueries[0].statuses).toEqual([
      'service_center_review', 'pending', 'agent_ops_approved', 'agent_verified',
      'tenant_ops_approved', 'landlord_ops_approved', 'partner_ops_approved', 'coo_approved',
    ]);
  });

  it('a "no LC1 letter yet" reason does not pass the gate; the LC1 confirmed by phone does', async () => {
    mocks.tables.pipeline_intake_details = { ...ready, lc1_phone_confirmation: 'Called Mr Okello on 7 Nov, he knows the tenant' };
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest({ lc_letter_path: null }) }} />);
    await waitFor(() => expect(group('gate')).toBeNull());
    expect(screen.getAllByText('LC1 confirmed by phone').length).toBeGreaterThan(0);
  });
});

describe('T4 renewal', () => {
  const renewal = { prevId: 'prev-1', tenantId: 'tenant-1', tenantName: 'John Mukasa', tenantPhone: '0783123456', currentRent: 300000, currentDays: 30, landlordName: 'Peter Okello' };

  it('needs the LC1 letter, then renews through the tenant’s code and attaches the letter', async () => {
    mocks.tables.rent_requests = { ...(mocks.tables.rent_requests as object), lc_letter_path: null };
    mocks.renewalStart.mockResolvedValue({ newRent: 320000, newDays: 30, dailyRepayment: 14000, totalRepayment: 420000, changed: false, reasonCode: null, explanation: '', evidenceUrl: null });
    mocks.rpc.mockImplementation(async (fn: string) => (fn === 'renew_rent_request' ? { data: 'new-req', error: null } : { data: { ok: true }, error: null }));
    const onDone = vi.fn();
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'renewal', onDone, renewal }} />);

    // Opens at the review: photos, GPS, name and ID are on file; only the LC1 letter is missing.
    await waitFor(() => expect(listed('gate')).toEqual(['LC1 letter photo (or the LC1 confirmed by phone)']));
    expect(sendButton()).toBeDisabled();
    fix(/LC1 letter/);
    const letter = new File(['l'], 'letter.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByLabelText('LC1 letter photo'), { target: { files: [letter] } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByTestId('t4-ready');
    fireEvent.click(sendButton());

    expect(await screen.findAllByText('Sent to the Service Centre')).not.toHaveLength(0);
    expect(mocks.renewalStart).toHaveBeenCalledWith({ prevId: 'prev-1', tenantName: 'John Mukasa', currentRent: 300000, currentDays: 30 });
    // GPS is on file, so the renewal sends none of its own.
    expect(mocks.rpc).toHaveBeenCalledWith('renew_rent_request', { p_prev_request_id: 'prev-1', p_new_rent_amount: 320000, p_new_days: 30 });
    expect(mocks.rpc).toHaveBeenCalledWith('agent_attach_lc1_letter', { p_request_id: 'new-req', p_path: 'agent-1/new-req/lc_letter.jpg' });
    expect(onDone).toHaveBeenCalledWith('new-req');
  });

  it('a "no LC1 letter yet" reason keeps Renew off', async () => {
    mocks.tables.rent_requests = { ...(mocks.tables.rent_requests as object), lc_letter_path: null };
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'renewal', renewal }} />);
    await waitFor(() => expect(listed('gate')).toHaveLength(1));
    fix(/LC1 letter/);
    fireEvent.click(screen.getByLabelText(/No LC1 letter yet/));
    fireEvent.change(screen.getByLabelText('Why there is no LC1 letter yet'), { target: { value: 'LC1 is away until Friday' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(listed('gate')).toEqual(['LC1 letter photo (or the LC1 confirmed by phone)']));
    expect(sendButton()).toBeDisabled();
  });

  it('does nothing when the agent or tenant backs out of the renewal', async () => {
    mocks.renewalStart.mockResolvedValue(null);
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'renewal', renewal }} />);
    await screen.findByTestId('t4-ready');
    fireEvent.click(sendButton());
    await waitFor(() => expect(mocks.renewalStart).toHaveBeenCalled());
    expect(mocks.rpc).not.toHaveBeenCalledWith('renew_rent_request', expect.anything());
    expect(screen.queryByText('Sent to the Service Centre')).toBeNull();
  });
});
