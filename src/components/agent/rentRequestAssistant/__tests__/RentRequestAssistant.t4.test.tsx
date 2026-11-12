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
      storage: {
        from: () => ({
          upload: vi.fn(async () => ({ error: null })),
          getPublicUrl: (p: string) => ({ data: { publicUrl: p } }),
          createSignedUrl: async (p: string) => ({ data: { signedUrl: `https://signed/${p}` }, error: null }),
        }),
      },
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
    rent_requests: {
      tenant_id: 'tenant-1', landlord_id: 'll-1', rent_amount: 300000, house_image_urls: PHOTOS, request_latitude: 0.33, request_longitude: 32.58,
      lc_letter_path: 'agent-1/req-9/lc_letter.jpg', lc_letter_bucket: 'lc-letters',
      // DOCS-1 documents already on the request.
      nin_photo_path: 'tenant-1/old/national_id.jpg', nin_photo_bucket: 'tenant-ids',
      nin_photo_back_path: 'tenant-1/old/national_id_back.jpg', nin_photo_back_bucket: 'tenant-ids',
    },
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
    // E90: family size and work go in before the resubmit.
    expect(calls).toEqual([
      ['agent_save_intake_details', { p_request_id: 'req-9', p_family_size: 5, p_work_business: 'Tailor', p_work_location: null }],
      ['agent_resubmit_rent_request', { p_request_id: 'req-9', p_patch: {}, p_agent_note: 'Added family size and work' }],
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

describe('E90: ask only for what _agent_side_missing lists', () => {
  const ready = { family_size: 4, work_business: 'Tailor', work_location: null, lc1_phone_confirmation: null };
  const sideMissing = (...lists: string[][]) => {
    let n = 0;
    return (fn: string) => (fn === '_agent_side_missing' ? lists[Math.min(n++, lists.length - 1)] : undefined);
  };

  it('shows the reviewer’s reason and the server list at the top', async () => {
    const side = sideMissing(['family size', 'work / business']);
    mocks.rpc.mockImplementation(async (fn: string) => ({ data: side(fn) ?? { ok: true }, error: null }));
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest({ rejected_reason: 'Missing: family size, work / business' }) }} />);
    const top = await screen.findByTestId('resubmit-reason');
    expect(within(top).getByText('Missing: family size, work / business')).toBeInTheDocument();
    const list = await within(top).findByTestId('resubmit-side-missing');
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['family size', 'work / business']);
    expect(mocks.rpc).toHaveBeenCalledWith('_agent_side_missing', { p_request_id: 'req-9' });
    // A listed line opens its question.
    fireEvent.click(within(list).getByRole('button', { name: 'family size' }));
    answer('5');
    // The next question is the other listed one; nothing that is not listed is asked in between.
    expect(await screen.findByText(/What work or business does John do\?/)).toBeInTheDocument();
    expect(screen.queryByText(/Monthly rent \(one month only\)/)).toBeNull();
  });

  it('a listed document is asked again even when one is on file, then attached before the resubmit', async () => {
    mocks.tables.pipeline_intake_details = ready;
    const side = sideMissing(['ID front']);
    mocks.rpc.mockImplementation(async (fn: string) => ({ data: side(fn) ?? { ok: true }, error: null }));
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest() }} />);
    await waitFor(() => expect(listed('gate')).toEqual(['National ID photo — front']));
    fix(/National ID photo — front/);
    fireEvent.change(await screen.findByLabelText('National ID front photo'), { target: { files: [new File(['f'], 'front.jpg', { type: 'image/jpeg' })] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(group('gate')).toBeNull());
    fix(/What you changed/);
    answer('Took the ID front again');
    await waitFor(() => expect(sendButton()).toBeEnabled());
    fireEvent.click(sendButton());
    expect(await screen.findAllByText('Sent to the Service Centre')).not.toHaveLength(0);
    const order = mocks.rpc.mock.calls.map(([fn]) => fn).filter((fn) => fn !== '_agent_side_missing');
    expect(order.indexOf('request_attach_document')).toBeLessThan(order.indexOf('agent_resubmit_rent_request'));
    expect(mocks.rpc).toHaveBeenCalledWith('request_attach_document', expect.objectContaining({ p_request_id: 'req-9', p_kind: 'id_front' }));
  });

  it('shows RESUBMIT_INCOMPLETE word for word and reads the list again', async () => {
    mocks.tables.pipeline_intake_details = ready;
    const refusal = 'RESUBMIT_INCOMPLETE: add house photos before sending this request again';
    const side = sideMissing([], ['house photos']);
    mocks.rpc.mockImplementation(async (fn: string) => {
      if (fn === 'agent_resubmit_rent_request') return { data: null, error: { message: refusal } };
      return { data: side(fn) ?? { ok: true }, error: null };
    });
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest({ rejected_reason: null }) }} />);
    await waitFor(() => expect(group('gate')).toBeNull());
    fix(/What you changed/);
    answer('Fixed the landlord details');
    await waitFor(() => expect(sendButton()).toBeEnabled());
    fireEvent.click(sendButton());
    expect(await screen.findByText(refusal)).toBeInTheDocument();
    expect(screen.queryByText('Sent to the Service Centre')).toBeNull();
    const list = await screen.findByTestId('resubmit-side-missing');
    expect(within(list).getByRole('button', { name: 'house photos' })).toBeInTheDocument();
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

  it('DOCS-1: no photo of the BACK of the ID on file: listed; taking it clears the item, and the resubmit attaches it', async () => {
    mocks.tables.pipeline_intake_details = ready;
    mocks.tables.rent_requests = { ...(mocks.tables.rent_requests as object), nin_photo_back_path: null };
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest() }} />);
    await waitFor(() => expect(listed('gate')).toEqual(['National ID photo — back']));
    fix(/National ID photo — back/);
    fireEvent.change(await screen.findByLabelText('National ID back photo'), { target: { files: [new File(['b'], 'back.jpg', { type: 'image/jpeg' })] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(group('gate')).toBeNull());
    fix(/What you changed/);
    answer('Added the back of the ID');
    await waitFor(() => expect(sendButton()).toBeEnabled());
    fireEvent.click(sendButton());
    expect(await screen.findAllByText('Sent to the Service Centre')).not.toHaveLength(0);
    // Only the new photo is attached: the front and the letter are already on this request.
    const attaches = mocks.rpc.mock.calls.filter(([fn]) => fn === 'request_attach_document');
    expect(attaches).toEqual([
      ['request_attach_document', { p_request_id: 'req-9', p_kind: 'id_back', p_bucket: 'tenant-ids', p_path: expect.stringMatching(/^agent-1\/req-9\/national_id_back_\d+\.jpg$/) }],
    ]);
  });

  it('DOCS-1: no photo of the FRONT of the ID on file: listed, Send stays off', async () => {
    mocks.tables.pipeline_intake_details = ready;
    mocks.tables.rent_requests = { ...(mocks.tables.rent_requests as object), nin_photo_path: null };
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest() }} />);
    await waitFor(() => expect(listed('gate')).toEqual(['National ID photo — front']));
    fix(/What you changed/);
    answer('Fixed the landlord details');
    await waitFor(() => expect(listed('form')).toEqual([]));
    expect(sendButton()).toBeDisabled();
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

  it('DOCS-1: no LC1 letter photo: listed, even when the LC1 was confirmed by phone', async () => {
    mocks.tables.pipeline_intake_details = { ...ready, lc1_phone_confirmation: 'Called Mr Okello on 7 Nov, he knows the tenant' };
    mocks.tables.rent_requests = { ...(mocks.tables.rent_requests as object), lc_letter_path: null };
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest({ lc_letter_path: null }) }} />);
    await waitFor(() => expect(listed('gate')).toEqual(['LC1 letter photo']));
    expect(sendButton()).toBeDisabled();
  });
});

describe('DOCS-1: documents already on file are not asked for again', () => {
  const ready = { family_size: 4, work_business: 'Tailor', work_location: null, lc1_phone_confirmation: null };

  it('resubmit: ID front, ID back and LC1 letter on file show "On file ✓" with a preview and are never asked', async () => {
    mocks.tables.pipeline_intake_details = ready;
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest() }} />);
    await waitFor(() => expect(group('gate')).toBeNull());
    expect(screen.queryByText(/photo of the FRONT of/)).toBeNull();
    expect(screen.queryByText(/And the BACK of/)).toBeNull();
    expect(screen.queryByText(/photo of the stamped LC1 letter/)).toBeNull();
    expect(screen.getAllByText('On file ✓')).toHaveLength(3);
    await waitFor(() => expect(screen.getByRole('img', { name: 'ID front photo on file' })).toHaveAttribute('src', 'https://signed/tenant-1/old/national_id.jpg'));
    expect(screen.getByRole('img', { name: 'ID back photo on file' })).toHaveAttribute('src', 'https://signed/tenant-1/old/national_id_back.jpg');
    expect(screen.getByRole('img', { name: 'LC1 letter on file' })).toHaveAttribute('src', 'https://signed/agent-1/req-9/lc_letter.jpg');
  });

  it('renewal: the last plan’s letter and ID photos are on file; Renew is ready without uploads', async () => {
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'renewal', renewal: { prevId: 'prev-1', tenantId: 'tenant-1', tenantName: 'John Mukasa', currentRent: 300000, currentDays: 30 } }} />);
    await screen.findByTestId('t4-ready');
    expect(screen.getAllByText('On file ✓')).toHaveLength(3);
    expect(screen.queryByLabelText('National ID front photo')).toBeNull();
    expect(screen.queryByLabelText('LC1 letter photo')).toBeNull();
  });
});

describe('rent field', () => {
  it('asks for the monthly rent, one month only, with the Landlord Ops note', async () => {
    render(<RentRequestAssistant open onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Weekly earner/ }));
    expect(await screen.findAllByText('Monthly rent (one month only) 🏠')).not.toHaveLength(0);
    expect(screen.getByText('If the landlord wants several months together, enter ONE month. Landlord Ops will confirm the monthly rent with the landlord.')).toBeInTheDocument();
  });
});

describe('T4 renewal', () => {
  const renewal = { prevId: 'prev-1', tenantId: 'tenant-1', tenantName: 'John Mukasa', tenantPhone: '0783123456', currentRent: 300000, currentDays: 30, landlordName: 'Peter Okello' };

  it('needs the LC1 letter; attaches it to the previous plan BEFORE renewing, so the renewal reuses it', async () => {
    mocks.tables.rent_requests = { ...(mocks.tables.rent_requests as object), lc_letter_path: null };
    mocks.renewalStart.mockResolvedValue({ newRent: 320000, newDays: 30, dailyRepayment: 14000, totalRepayment: 420000, changed: false, reasonCode: null, explanation: '', evidenceUrl: null });
    mocks.rpc.mockImplementation(async (fn: string) => (fn === 'renew_rent_request' ? { data: 'new-req', error: null } : { data: { ok: true }, error: null }));
    const onDone = vi.fn();
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'renewal', onDone, renewal }} />);

    // Opens at the review: photos, GPS, name and ID are on file; only the LC1 letter is missing.
    await waitFor(() => expect(listed('gate')).toEqual(['LC1 letter photo']));
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
    // DOCS-1: only the new letter, on the previous plan, and before renew_rent_request (which reuses it).
    // The ID photos are already on the previous plan, so nothing else is attached; nothing goes on the new request.
    const calls = mocks.rpc.mock.calls.map(([fn, a]) => [fn, a]);
    const attachAt = calls.findIndex(([fn]) => fn === 'request_attach_document');
    const renewAt = calls.findIndex(([fn]) => fn === 'renew_rent_request');
    expect(calls.filter(([fn]) => fn === 'request_attach_document')).toEqual([
      ['request_attach_document', { p_request_id: 'prev-1', p_kind: 'lc1_letter', p_bucket: 'lc-letters', p_path: expect.stringMatching(/^agent-1\/prev-1\/lc_letter_\d+\.jpg$/) }],
    ]);
    expect(attachAt).toBeLessThan(renewAt);
    expect(mocks.rpc).not.toHaveBeenCalledWith('agent_attach_lc1_letter', expect.anything());
    expect(onDone).toHaveBeenCalledWith('new-req');
  });

  it('DOCS-1: a "no LC1 letter yet" reason does not get past the letter step; Renew stays out of reach', async () => {
    mocks.tables.rent_requests = { ...(mocks.tables.rent_requests as object), lc_letter_path: null };
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'renewal', renewal }} />);
    await waitFor(() => expect(listed('gate')).toEqual(['LC1 letter photo']));
    expect(sendButton()).toBeDisabled();
    fix(/LC1 letter/);
    fireEvent.click(screen.getByLabelText(/No LC1 letter yet/));
    fireEvent.change(screen.getByLabelText('Why there is no LC1 letter yet'), { target: { value: 'LC1 is away until Friday' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/Add a photo of the stamped LC1 letter/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Renew Rent Plan/ })).toBeNull();
    expect(mocks.renewalStart).not.toHaveBeenCalled();
  });

  it('DOCS-1: no ID back photo on the plan or the profile: listed; once taken it goes on the profile BEFORE renewing', async () => {
    mocks.tables.rent_requests = { ...(mocks.tables.rent_requests as object), nin_photo_back_path: null };
    mocks.renewalStart.mockResolvedValue({ newRent: 300000, newDays: 30, dailyRepayment: 14000, totalRepayment: 420000, changed: false, reasonCode: null, explanation: '', evidenceUrl: null });
    mocks.rpc.mockImplementation(async (fn: string) => (fn === 'renew_rent_request' ? { data: 'new-req', error: null } : { data: { ok: true }, error: null }));
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'renewal', renewal }} />);
    await waitFor(() => expect(listed('gate')).toEqual(['National ID photo — back']));
    fix(/National ID photo — back/);
    fireEvent.change(await screen.findByLabelText('National ID back photo'), { target: { files: [new File(['b'], 'back.jpg', { type: 'image/jpeg' })] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByTestId('t4-ready');
    fireEvent.click(sendButton());
    expect(await screen.findAllByText('Sent to the Service Centre')).not.toHaveLength(0);
    const profileUpdate = mocks.update.mock.calls.findIndex(([table]) => table === 'profiles');
    expect(mocks.update.mock.calls[profileUpdate]).toEqual(['profiles', { national_id_photo_back_path: expect.stringMatching(/^agent-1\/profile-tenant-1\/national_id_back_\d+\.jpg$/) }]);
    const renewOrder = mocks.rpc.mock.invocationCallOrder[mocks.rpc.mock.calls.findIndex(([fn]) => fn === 'renew_rent_request')];
    expect(mocks.update.mock.invocationCallOrder[profileUpdate]).toBeLessThan(renewOrder);
  });

  it('DOCS-1: an ID back photo on the tenant’s profile counts for a renewal and shows "On file ✓"', async () => {
    mocks.tables.rent_requests = { ...(mocks.tables.rent_requests as object), nin_photo_back_path: null };
    mocks.tables.profiles = { ...TENANT, national_id_photo_back_path: 'tenant-1/profile/national_id_back.jpg' };
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'renewal', renewal }} />);
    await screen.findByTestId('t4-ready');
    await waitFor(() => expect(screen.getByRole('img', { name: 'ID back photo on file' })).toHaveAttribute('src', 'https://signed/tenant-1/profile/national_id_back.jpg'));
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
