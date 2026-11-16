import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AgentRejectedRequest } from '@/hooks/useAgentRejectedRequests';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  /** Table rows by name; 'rent_requests:open' answers the open-request look-up (the query that filters by status). */
  tables: {} as Record<string, unknown>,
  openQueries: [] as { tenantId: unknown; except: unknown; statuses: unknown }[],
  renewalStart: vi.fn(),
  renewalConfirm: vi.fn(),
  update: vi.fn(),
  faceCheck: vi.fn(),
  openT4: vi.fn(),
  fetchRejected: vi.fn(),
}));
vi.mock('@/lib/t4RentRequest', async (orig) => ({ ...(await orig<typeof import('@/lib/t4RentRequest')>()), openT4RentRequest: mocks.openT4 }));
vi.mock('@/hooks/useAgentRejectedRequests', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useAgentRejectedRequests')>()),
  fetchAgentRejectedRequests: mocks.fetchRejected,
}));
vi.mock('@/lib/passportFaceCheck', async (orig) => ({
  ...(await orig<typeof import('@/lib/passportFaceCheck')>()),
  runPassportFaceCheck: mocks.faceCheck,
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
const auth = vi.hoisted(() => ({ user: { id: 'agent-1', user_metadata: { full_name: 'Agent One' } }, enabledRoles: [] as string[], rolesResolved: undefined as boolean | undefined }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));
const cap = vi.hoisted(() => ({ data: undefined as undefined | Map<string, unknown> }));
vi.mock('@/hooks/useAgentCapacityMap', () => ({ useAgentCapacityMap: () => ({ data: cap.data, isLoading: false }), DAILY_ELIGIBILITY_THRESHOLD: 0.5 }));
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
// E128: step 1 chooses the rent and days (choose), step 3 is the tenant's code (confirm).
vi.mock('@/components/agent/RenewalDialog', () => ({ useRenewalFlow: () => ({ start: mocks.renewalStart, choose: mocks.renewalStart, confirm: mocks.renewalConfirm, dialogs: null }) }));
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
  cap.data = undefined;
  mocks.openQueries = [];
  mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });
  mocks.renewalConfirm.mockResolvedValue(true);
  mocks.faceCheck.mockResolvedValue({ status: 'ok', verdict: 'pass', isFace: true, isPassportPhoto: true, sha256: 'face-1' });
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
  rejected_at_stage: 'service_center', rejected_reason: 'Please check the details and send it again', reopen_count: 1, tenant_id: 'tenant-1',
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
/** Step 1 (the tenant: phone, names, language, smartphone), then the earner type of step 2. */
const startNew = async (earner: RegExp = /Weekly earner/) => {
  answer('0783 123 456');
  fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'John' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Mukasa' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.click(await screen.findByRole('button', { name: 'English' }));
  fireEvent.click(await screen.findByRole('button', { name: /Yes, a smartphone/ }));
  fireEvent.click(await screen.findByRole('button', { name: earner }));
};
const fix = (label: RegExp) => fireEvent.click(within(screen.getByTestId('t4-missing')).getByRole('button', { name: label }));
const sendButton = () => screen.getByRole('button', { name: /Resubmit rent request|Send the tenant’s code and renew/ });
/** E128 renewal: the header's step 3 (the tenant's code and Post). */
const toRenewalStep3 = async () => fireEvent.click(await screen.findByRole('button', { name: /^Step 3: Tenant code \+ Post/ }));

describe('T4 resubmit', () => {
  it('keeps Resubmit off until every gate item is in, then lands the request at the Service Centre', async () => {
    const onSuccess = vi.fn();
    const onDone = vi.fn();
    render(<RentRequestAssistant open onOpenChange={vi.fn()} onSuccess={onSuccess} request={{ mode: 'resubmit', rejected: rejectedRequest(), onDone }} />);

    expect(await screen.findByText(/Please check the details and send it again/)).toBeInTheDocument();
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
    // agent_eligibility_of only reads the collection line (E100).
    const calls = mocks.rpc.mock.calls.filter(([fn]) => String(fn).startsWith('agent_') && fn !== 'agent_eligibility_of');
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
      ? { data: null, error: { message: 'NOT_YOUR_REQUEST: this tenant is handled by another agent' } }
      : { data: { ok: true }, error: null }));
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest() }} />);
    await waitFor(() => expect(group('gate')).toBeNull());
    fix(/What you changed/);
    answer('Fixed the landlord details');
    await waitFor(() => expect(sendButton()).toBeEnabled());
    fireEvent.click(sendButton());
    expect(await screen.findByText('NOT_YOUR_REQUEST: this tenant is handled by another agent')).toBeInTheDocument();
    expect(screen.queryByText('Sent to the Service Centre')).toBeNull();
  });
});

describe('E118: no resubmit limit', () => {
  it('a returned request with reopen_count = 6 and every item in can be resubmitted, and the server takes it', async () => {
    mocks.tables.pipeline_intake_details = { family_size: 4, work_business: 'Tailor', work_location: null, lc1_phone_confirmation: null };
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest({ reopen_count: 6, rejected_reason: 'Wrong landlord phone' }) }} />);
    // The reason names the landlord, so that question opens first.
    expect(await screen.findAllByText(/Who’s the landlord\?/)).not.toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(group('gate')).toBeNull());
    // Only the note is left: no "Resubmits left" item, no manager reopen.
    expect(listed('form')).toEqual(['What you changed (at least 10 characters)']);
    expect(screen.queryByText(/Resubmits left|manager must reopen/i)).toBeNull();
    expect(sendButton()).toBeDisabled();
    fix(/What you changed/);
    answer('Fixed the landlord phone number');
    await waitFor(() => expect(sendButton()).toBeEnabled());
    fireEvent.click(sendButton());
    expect(await screen.findAllByText('Sent to the Service Centre')).not.toHaveLength(0);
    expect(mocks.rpc).toHaveBeenCalledWith('agent_resubmit_rent_request', expect.objectContaining({
      p_request_id: 'req-9', p_agent_note: 'Fixed the landlord phone number',
    }));
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
    const side = sideMissing(['ID photo (front)']);
    mocks.rpc.mockImplementation(async (fn: string) => ({ data: side(fn) ?? { ok: true }, error: null }));
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest() }} />);
    // The server lists the ID front, so it opens first even though one is on file.
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
    const refusal = 'RESUBMIT_INCOMPLETE: add Photos of the house before sending this request again';
    const side = sideMissing([], ['Photos of the house']);
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
    expect(within(list).getByRole('button', { name: 'Photos of the house' })).toBeInTheDocument();
  });
});

describe('E100: no posting gate', () => {
  // E119: an ordinary agent reads their own figure (agent_eligibility_of with their own id).
  beforeEach(() => { auth.enabledRoles = ['agent']; });
  afterEach(() => { auth.enabledRoles = []; });
  // VERON OWARUHANGA: 52.8% collected across all plans, 0 tenants paid today. Even a capacity
  // record from before E100 that still says "can't post" must not stop her.
  const veron = {
    can_post_rent_today: false, unlimited_posting: false, posting_rule: 'weekly', per_tenant_max: 1_000_000,
    tenants_due: 12, tenants_paid_today: 0, tenants_paid_yesterday: 0,
    weekly_posting: { passes: false, reason: 'Last week you collected 9.2% of what your current Rent Plans were due.' },
  };

  it.each([[52.8, '52.8'], [31, '31']])('opens with the collection line only (%s%%) and lets the agent post', async (pct, shown) => {
    cap.data = new Map([['agent-1', veron]]);
    mocks.rpc.mockImplementation(async (fn: string) => (fn === 'agent_eligibility_of' ? { data: { eligible: pct >= 50, pct }, error: null } : { data: { ok: true }, error: null }));
    const { container } = render(<RentRequestAssistant open onOpenChange={vi.fn()} />);
    expect(await screen.findByTestId('collection-info')).toHaveTextContent(
      `Your collection: ${shown}% of what is due across all your plans. Below 50%, your requests still move but wait at the COO desk and can't be funded.`,
    );
    expect(mocks.rpc).toHaveBeenCalledWith('agent_eligibility_of', { p_agent: 'agent-1' });
    expect(screen.queryByText(/can’t post|cannot post|Collect from|Checking whether you can post|Good news/)).toBeNull();
    // The conversation is open: the composer is there for the first answer.
    expect(container.querySelector('footer')).not.toBeNull();
  });

  it('E119: a plain agent sees their own % and the reason text the server gives', async () => {
    cap.data = new Map([['agent-1', veron]]);
    const reason = 'Collected 31% across all 4 rent plans (needs 50%). You are not verified yet.';
    mocks.rpc.mockImplementation(async (fn: string, args?: { p_agent?: string }) => (fn === 'agent_eligibility_of'
      ? (args?.p_agent === 'agent-1' ? { data: { eligible: false, pct: 31, reason }, error: null } : { data: null, error: { message: 'NOT_ALLOWED' } })
      : { data: { ok: true }, error: null }));
    render(<RentRequestAssistant open onOpenChange={vi.fn()} />);
    expect(await screen.findByTestId('collection-info')).toHaveTextContent('Your collection: 31% of what is due across all your plans.');
    expect(screen.getByTestId('collection-reason')).toHaveTextContent(reason);
    // Only the signed-in agent's own id is ever asked for.
    const asked = mocks.rpc.mock.calls.filter(([fn]) => fn === 'agent_eligibility_of').map(([, a]) => (a as { p_agent: string }).p_agent);
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set(['agent-1']));
  });

  it('E119: when the server refuses the figure (another agent\'s id), nothing renders', async () => {
    cap.data = new Map([['agent-1', veron]]);
    mocks.rpc.mockImplementation(async (fn: string) => (fn === 'agent_eligibility_of'
      ? { data: null, error: { message: 'NOT_ALLOWED: you can only read your own figure' } }
      : { data: { ok: true }, error: null }));
    const { container } = render(<RentRequestAssistant open onOpenChange={vi.fn()} />);
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('agent_eligibility_of', { p_agent: 'agent-1' }));
    expect(screen.queryByTestId('collection-info')).toBeNull();
    expect(screen.queryByTestId('collection-reason')).toBeNull();
    expect(screen.queryByText(/NOT_ALLOWED/)).toBeNull();
    expect(container.querySelector('footer')).not.toBeNull();
  });

  it('with no collection figure, says nothing about it and still lets the agent post', async () => {
    cap.data = new Map([['agent-1', veron]]);
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'permission denied' } });
    const { container } = render(<RentRequestAssistant open onOpenChange={vi.fn()} />);
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('agent_eligibility_of', { p_agent: 'agent-1' }));
    expect(screen.queryByTestId('collection-info')).toBeNull();
    expect(container.querySelector('footer')).not.toBeNull();
  });
});

describe('E63: no rent cap in the form', () => {
  // 0% collected today, and a capacity record from before E63 that still says 200,000 per tenant.
  const zeroPct = { can_post_rent_today: true, unlimited_posting: false, per_tenant_max: 200_000, tier: 'Very Bad', tenants_due: 10, tenants_paid_today: 0 };
  const askedLast = (re: RegExp) => screen.findAllByText(re).then((els) => els[els.length - 1]);

  it.each([[300000, 'UGX 300,000'], [400000, 'UGX 400,000']])('new request: %s is taken as it is, with no cap message', async (rent, shown) => {
    cap.data = new Map([['agent-1', zeroPct]]);
    mocks.rpc.mockImplementation(async (fn: string) => (fn === 'agent_eligibility_of' ? { data: { pct: 0 }, error: null } : { data: { ok: true }, error: null }));
    render(<RentRequestAssistant open onOpenChange={vi.fn()} />);
    await startNew();
    expect(await askedLast(/Monthly rent \(one month only\)/)).toBeInTheDocument();
    // The numbers-only tip still comes on the third answer it can't read.
    answer('about three hundred');
    answer('about three hundred');
    answer('about three hundred');
    expect(await screen.findByText(/type the numbers only, like 450000/)).toBeInTheDocument();
    answer(String(rent));
    // Past the rent question: the next step's Continue is there, the amount shows with commas.
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await askedLast(/Who’s the landlord/)).toBeInTheDocument();
    expect(screen.getAllByText(new RegExp(shown.replace(/[,]/g, ',')))).not.toHaveLength(0);
    expect(screen.queryByText(/more than your cap|per tenant|within your cap/)).toBeNull();
  });

  it.each([300000, 400000])('resubmit: %s reaches Resubmit and goes in the patch', async (rent) => {
    cap.data = new Map([['agent-1', zeroPct]]);
    mocks.tables.pipeline_intake_details = { family_size: 4, work_business: 'Tailor', work_location: null, lc1_phone_confirmation: null };
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest({ rent_amount: 250000, rejected_reason: null }) }} />);
    await waitFor(() => expect(group('gate')).toBeNull());
    // The request on file loads first.
    fireEvent.click(await screen.findByRole('button', { name: 'Redo: Monthly rent' }, { timeout: 5000 }));
    answer(String(rent));
    expect(screen.queryByText(/more than your cap|within your cap/)).toBeNull();
    // A new rent asks the days again, then goes back to where the agent was.
    await screen.findAllByText(/How many days/);
    answer('30');
    await screen.findByTestId('t4-missing');
    fix(/What you changed/);
    answer('Corrected the monthly rent with the landlord');
    await waitFor(() => expect(sendButton()).toBeEnabled());
    fireEvent.click(sendButton());
    expect(await screen.findAllByText('Sent to the Service Centre')).not.toHaveLength(0);
    expect(mocks.rpc).toHaveBeenCalledWith('agent_resubmit_rent_request', expect.objectContaining({
      p_request_id: 'req-9', p_patch: expect.objectContaining({ rent_amount: rent }),
    }));
  });
});

describe('send progress on the button', () => {
  it('says Saving… while the request is being saved, then shows it sent', async () => {
    mocks.tables.pipeline_intake_details = { family_size: 4, work_business: 'Tailor', work_location: null, lc1_phone_confirmation: null };
    let release: (v: unknown) => void = () => {};
    mocks.rpc.mockImplementation(async (fn: string) => {
      if (fn === '_agent_side_missing') return { data: [], error: null };
      if (fn === 'agent_resubmit_rent_request') return new Promise((r) => { release = r; });
      return { data: { ok: true }, error: null };
    });
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest({ rejected_reason: null }) }} />);
    await waitFor(() => expect(group('gate')).toBeNull());
    fix(/What you changed/);
    answer('Fixed the landlord details');
    await waitFor(() => expect(sendButton()).toBeEnabled());
    fireEvent.click(sendButton());
    expect(await screen.findByTestId('send-button')).toHaveTextContent('Saving…');
    release({ data: { ok: true }, error: null });
    expect(await screen.findAllByText('Sent to the Service Centre')).not.toHaveLength(0);
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
    await toRenewalStep3();
    await screen.findByTestId('t4-ready');
    expect(screen.getAllByText('On file ✓')).toHaveLength(3);
    expect(screen.queryByLabelText('National ID front photo')).toBeNull();
    expect(screen.queryByLabelText('LC1 letter photo')).toBeNull();
  });
});

describe('rent field', () => {
  it('asks for the monthly rent, one month only, with the Landlord Ops note', async () => {
    render(<RentRequestAssistant open onOpenChange={vi.fn()} />);
    await startNew();
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

    // Step 3: photos, GPS, name and ID are on file; only the LC1 letter is missing.
    await toRenewalStep3();
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
    await toRenewalStep3();
    await waitFor(() => expect(listed('gate')).toEqual(['LC1 letter photo']));
    expect(sendButton()).toBeDisabled();
    fix(/LC1 letter/);
    fireEvent.click(screen.getByLabelText(/No LC1 letter yet/));
    fireEvent.change(screen.getByLabelText('Why there is no LC1 letter yet'), { target: { value: 'LC1 is away until Friday' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/Add a photo of the stamped LC1 letter/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Send the tenant’s code and renew/ })).toBeNull();
    expect(mocks.renewalStart).not.toHaveBeenCalled();
  });

  it('DOCS-1: no ID back photo on the plan or the profile: listed; once taken it goes on the profile BEFORE renewing', async () => {
    mocks.tables.rent_requests = { ...(mocks.tables.rent_requests as object), nin_photo_back_path: null };
    mocks.renewalStart.mockResolvedValue({ newRent: 300000, newDays: 30, dailyRepayment: 14000, totalRepayment: 420000, changed: false, reasonCode: null, explanation: '', evidenceUrl: null });
    mocks.rpc.mockImplementation(async (fn: string) => (fn === 'renew_rent_request' ? { data: 'new-req', error: null } : { data: { ok: true }, error: null }));
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'renewal', renewal }} />);
    await toRenewalStep3();
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
    await toRenewalStep3();
    await screen.findByTestId('t4-ready');
    await waitFor(() => expect(screen.getByRole('img', { name: 'ID back photo on file' })).toHaveAttribute('src', 'https://signed/tenant-1/profile/national_id_back.jpg'));
  });

  it('does nothing when the agent or tenant backs out of the renewal', async () => {
    mocks.renewalStart.mockResolvedValue(null);
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'renewal', renewal }} />);
    await toRenewalStep3();
    await screen.findByTestId('t4-ready');
    fireEvent.click(sendButton());
    await waitFor(() => expect(mocks.renewalStart).toHaveBeenCalled());
    expect(mocks.rpc).not.toHaveBeenCalledWith('renew_rent_request', expect.anything());
    expect(screen.queryByText('Sent to the Service Centre')).toBeNull();
  });
});

describe('Agent chat fixes (16 Nov): resubmit', () => {
  const ready = { family_size: 4, work_business: 'Tailor', work_location: null, lc1_phone_confirmation: null };

  it('"photo" in the return reason opens the face photo step first, even though one is on file; a retake is checked and sent', async () => {
    mocks.tables.pipeline_intake_details = ready;
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest({ rejected_reason: 'The photo is blurry, take it again', tenant_photo_url: 'https://cdn/face.jpg' }) }} />);
    // The whole request at once, every line tappable, the face photo included.
    const summary = await screen.findByTestId('resubmit-summary');
    expect(within(summary).getByRole('button', { name: 'Redo: Tenant’s face photo (head and shoulders)' })).toHaveTextContent('On file ✓');
    expect(within(summary).getByRole('button', { name: 'Redo: House GPS' })).toBeInTheDocument();
    // The face photo opens first although it is on file.
    expect(await screen.findAllByText(/Now the tenant’s face photo \(head and shoulders\) of John/)).not.toHaveLength(0);
    expect(screen.getByTestId('face-check-status')).toHaveTextContent('On file ✓ Tap the photo to retake it.');
    expect(screen.queryByText(/passport photo/i)).toBeNull();
    // A retaken photo runs the face check again.
    fireEvent.change(screen.getByLabelText('Tenant’s face photo (head and shoulders)'), { target: { files: [new File(['f'], 'face.jpg', { type: 'image/jpeg' })] } });
    await waitFor(() => expect(mocks.faceCheck).toHaveBeenCalledWith(expect.any(File), { source: 'agent_rent_request' }));
    expect(await screen.findByText('Face found. Looks good.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // Back at the summary: only the note is left.
    await waitFor(() => expect(listed('form')).toEqual(['What you changed (at least 10 characters)']));
    fix(/What you changed/);
    answer('Retook the tenant face photo');
    await waitFor(() => expect(sendButton()).toBeEnabled());
    fireEvent.click(sendButton());
    expect(await screen.findAllByText('Sent to the Service Centre')).not.toHaveLength(0);
    expect(mocks.update).toHaveBeenCalledWith('rent_requests', expect.objectContaining({ tenant_photo_url: expect.stringContaining('tenant_passport') }));
    expect(mocks.rpc).toHaveBeenCalledWith('agent_resubmit_rent_request', expect.objectContaining({
      p_request_id: 'req-9', p_patch: expect.objectContaining({ tenant_photo_url: expect.any(String) }),
    }));
    expect(mocks.rpc).toHaveBeenCalledWith('link_identity_photo_fingerprint', expect.objectContaining({ p_sha256: 'face-1', p_rent_request_id: 'req-9' }));
  });

  it('a reason naming nothing opens the summary and the review, as before', async () => {
    mocks.tables.pipeline_intake_details = ready;
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest({ rejected_reason: 'Please call the Service Centre first' }) }} />);
    expect(await screen.findByTestId('resubmit-summary')).toBeInTheDocument();
    await waitFor(() => expect(listed('form')).toEqual(['What you changed (at least 10 characters)']));
    // Any line opens its question.
    fireEvent.click(within(screen.getByTestId('resubmit-summary')).getByRole('button', { name: 'Redo: House GPS' }));
    expect(await screen.findAllByText(/capture its GPS location/)).not.toHaveLength(0);
  });
});

describe('E124: the 8-step intake', () => {
  const counter = () => screen.getByTestId('intake-counter').textContent;
  const rpcWith = (answers: Record<string, unknown>) => mocks.rpc.mockImplementation(async (fn: string) => (
    fn in answers ? { data: answers[fn], error: null } : { data: { ok: true }, error: null }
  ));
  const walkStep1 = async () => {
    answer('0783 123 456');
    fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'John' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Mukasa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'English' }));
    fireEvent.click(await screen.findByRole('button', { name: /Yes, a smartphone/ }));
  };

  it('the counter on top updates per step; the step strip ticks a done step', async () => {
    render(<RentRequestAssistant open onOpenChange={vi.fn()} />);
    await waitFor(() => expect(counter()).toBe('Step 1 of 8 · 8 left'));
    const needed = screen.getByTestId('intake-needed');
    expect(within(needed).getByText('Tenant’s phone number').closest('li')).toHaveAttribute('data-done', 'no');
    await walkStep1();
    await waitFor(() => expect(counter()).toBe('Step 2 of 8 · 7 left'));
    expect(screen.getByRole('button', { name: 'Step 1: Tenant, done' })).toBeInTheDocument();
    expect(screen.getAllByRole('progressbar')[0].querySelector('[data-state="done"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Step 4: House/ }));
    await waitFor(() => expect(counter()).toBe('Step 4 of 8 · 7 left'));
  });

  it('Post is only on step 8; while steps are incomplete it reads "N left: …" and jumps there', async () => {
    render(<RentRequestAssistant open onOpenChange={vi.fn()} />);
    await walkStep1();
    expect(screen.queryByTestId('send-button')).toBeNull();
    expect(screen.queryByRole('button', { name: /Post rent request/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Step 8: LC1 letter \+ Post/ }));
    const left = await screen.findByTestId('send-button');
    expect(left).toHaveTextContent('7 left: Rent plan, Landlord, House, Household, Photo, ID, LC1 letter');
    expect(screen.queryByRole('button', { name: /Post rent request/ })).toBeNull();
    fireEvent.click(left);
    await waitFor(() => expect(counter()).toBe('Step 2 of 8 · 7 left'));
    expect(screen.queryByTestId('send-button')).toBeNull();
  });

  // E127: the exact intake_tenant_check reply, one test per status.
  const reply = (over: Record<string, unknown>) => ({ ok: false, own_phone: false, open_request: null, returned_request: null, message: null, ...over });

  it('step 1, status ok: the phone is accepted and step 1 goes on', async () => {
    rpcWith({ intake_tenant_check: reply({ status: 'ok', ok: true }) });
    render(<RentRequestAssistant open onOpenChange={vi.fn()} />);
    answer('0783 123 456');
    expect(await screen.findByLabelText('First name')).toBeInTheDocument();
    expect(screen.queryByTestId('tenant-check')).toBeNull();
  });

  it('step 1, status phone_incomplete: the server’s words, and it stops', async () => {
    rpcWith({ intake_tenant_check: { ok: false, reason: 'phone_incomplete', message: 'That number is missing digits.' } });
    render(<RentRequestAssistant open onOpenChange={vi.fn()} />);
    answer('0783 123 456');
    expect(await screen.findByTestId('tenant-check')).toHaveTextContent('That number is missing digits.');
    expect(screen.queryByLabelText('First name')).toBeNull();
  });

  it('step 1, status own_phone: the agent’s own phone stops here', async () => {
    rpcWith({ intake_tenant_check: reply({ status: 'own_phone', own_phone: true }) });
    render(<RentRequestAssistant open onOpenChange={vi.fn()} />);
    answer('0783 123 456');
    expect(await screen.findByTestId('tenant-check')).toHaveTextContent('This is your own phone number');
    expect(mocks.rpc).toHaveBeenCalledWith('intake_tenant_check', { p_tenant_phone: '0783123456' });
    expect(screen.queryByLabelText('First name')).toBeNull();
    expect(counter()).toBe('Step 1 of 8 · 8 left');
  });

  it('step 1, status open_request: says where it is (open_request.where); mine links to it, and it does not continue', async () => {
    rpcWith({ intake_tenant_check: reply({ status: 'open_request', open_request: { id: 'req-5', mine: true, where: 'Tenant Ops' } }) });
    const onOpenChange = vi.fn();
    const seen = vi.fn();
    window.addEventListener('open-submissions', seen);
    render(<RentRequestAssistant open onOpenChange={onOpenChange} />);
    answer('0783 123 456');
    expect(await screen.findByTestId('tenant-check')).toHaveTextContent('This tenant already has a request at Tenant Ops.');
    expect(screen.queryByLabelText('First name')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open my request' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect((seen.mock.calls[0][0] as CustomEvent).detail).toEqual({ tab: 'submitted', recordId: 'req-5' });
    window.removeEventListener('open-submissions', seen);
  });

  it('step 1, status returned_mine: opens that request’s resubmit', async () => {
    rpcWith({ intake_tenant_check: reply({ status: 'returned_mine', returned_request: { id: 'req-9', mine: true, reason: 'Blurry photo' } }) });
    mocks.fetchRejected.mockResolvedValue([rejectedRequest()]);
    render(<RentRequestAssistant open onOpenChange={vi.fn()} />);
    answer('0783 123 456');
    await waitFor(() => expect(mocks.openT4).toHaveBeenCalledWith(expect.objectContaining({ mode: 'resubmit', rejected: expect.objectContaining({ id: 'req-9' }) })));
    expect(mocks.fetchRejected).toHaveBeenCalledWith('agent-1');
    expect(screen.queryByLabelText('First name')).toBeNull();
  });

  it('step 1, status returned_other: shows the message and stops', async () => {
    rpcWith({ intake_tenant_check: reply({ status: 'returned_other', returned_request: { id: 'req-7', mine: false, reason: 'Wrong LC1' }, message: 'Sent back to another agent' }) });
    render(<RentRequestAssistant open onOpenChange={vi.fn()} />);
    answer('0783 123 456');
    expect(await screen.findByTestId('tenant-check')).toHaveTextContent('Sent back to another agent');
    expect(mocks.openT4).not.toHaveBeenCalled();
  });

  it('who is posting: a user who is not an agent picks "Someone else", which calls become_agent; then the intake opens', async () => {
    auth.rolesResolved = true;
    try {
      render(<RentRequestAssistant open onOpenChange={vi.fn()} />);
      expect(await screen.findByText('Who is this rent request for?')).toBeInTheDocument();
      expect(screen.queryByTestId('intake-header')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /Someone else/ }));
      await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('become_agent', {}));
      expect(await screen.findAllByText('What’s the tenant’s phone number? 📱')).not.toHaveLength(0);
      expect(screen.getByTestId('intake-counter')).toHaveTextContent('Step 1 of 8');
    } finally {
      auth.rolesResolved = undefined;
    }
  });

  it('who is posting: PHONE_REQUIRED asks to confirm the phone by SMS; AGENT_ROLE_DISABLED shows the message', async () => {
    auth.rolesResolved = true;
    try {
      mocks.rpc.mockImplementation(async (fn: string) => (fn === 'become_agent' ? { data: null, error: { message: 'PHONE_REQUIRED: confirm your phone by SMS first' } } : { data: { ok: true }, error: null }));
      const { unmount } = render(<RentRequestAssistant open onOpenChange={vi.fn()} />);
      fireEvent.click(await screen.findByRole('button', { name: /Someone else/ }));
      expect(await screen.findByTestId('confirm-phone')).toHaveTextContent('Confirm your phone number first');
      unmount();
      mocks.rpc.mockImplementation(async (fn: string) => (fn === 'become_agent' ? { data: null, error: { message: 'AGENT_ROLE_DISABLED: Your agent role was switched off by Agent Ops.' } } : { data: { ok: true }, error: null }));
      render(<RentRequestAssistant open onOpenChange={vi.fn()} />);
      fireEvent.click(await screen.findByRole('button', { name: /Someone else/ }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Your agent role was switched off by Agent Ops.');
      expect(screen.queryByRole('button', { name: /Someone else/ })).toBeNull();
    } finally {
      auth.rolesResolved = undefined;
    }
  });

  it('agents skip the who-is-posting screen', async () => {
    auth.rolesResolved = true;
    auth.enabledRoles = ['agent'];
    try {
      render(<RentRequestAssistant open onOpenChange={vi.fn()} />);
      expect(await screen.findAllByText('What’s the tenant’s phone number? 📱')).not.toHaveLength(0);
      expect(screen.queryByText('Who is this rent request for?')).toBeNull();
    } finally {
      auth.rolesResolved = undefined;
      auth.enabledRoles = [];
    }
  });

  it('resubmit: the counter reads "N to fix" and only the returned items open, in order (tenant_photo = step 6)', async () => {
    mocks.tables.pipeline_intake_details = { family_size: 4, work_business: 'Tailor', work_location: null, lc1_phone_confirmation: null };
    rpcWith({ resubmit_needs: {
      items: [{ code: 'tenant_photo', label: 'Tenant’s face photo', why: 'desk' }, { code: 'id_front', label: 'ID photo (front)', why: 'desk' }],
      count: 2, desk: 'Tenant Ops', desk_note: 'Blurry face photo', auto_note: 'Fixed: face photo, ID front',
    } });
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest({ tenant_photo_url: 'https://cdn/face.jpg' }) }} />);
    await waitFor(() => expect(screen.getByTestId('intake-counter')).toHaveTextContent('2 to fix'));
    expect(mocks.rpc).toHaveBeenCalledWith('resubmit_needs', { p_request_id: 'req-9' });
    expect(mocks.rpc).not.toHaveBeenCalledWith('return_items_for', expect.anything());
    // The photo (step 6) opens first.
    expect(await screen.findAllByText(/Now the tenant’s face photo/)).not.toHaveLength(0);
    expect(screen.getByRole('button', { name: /^Step 6: Tenant’s photo/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^Step 2: Rent plan/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Tenant’s face photo (head and shoulders)'), { target: { files: [new File(['f'], 'face.jpg', { type: 'image/jpeg' })] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByTestId('intake-counter')).toHaveTextContent('1 to fix'));
    // Then the ID front (step 7), even though one is on file.
    expect(await screen.findByLabelText('National ID front photo')).toBeInTheDocument();
  });
});

describe('E128: the renewal in 3 steps', () => {
  const renewal = { prevId: 'prev-1', tenantId: 'tenant-1', tenantName: 'John Mukasa', tenantPhone: '0783123456', currentRent: 300000, currentDays: 30, landlordName: 'Peter Okello' };
  const choice = { newRent: 320000, newDays: 60, dailyRepayment: 7000, totalRepayment: 420000, changed: true, reasonCode: 'landlord_raised', explanation: 'Landlord raised the rent', evidenceUrl: null };
  const counter = () => screen.getByTestId('intake-counter').textContent;

  it('the counter reads Step 1 of 3; Plan, What changed, then the tenant’s code and Post', async () => {
    mocks.renewalStart.mockResolvedValue(choice);
    mocks.rpc.mockImplementation(async (fn: string) => (fn === 'renew_rent_request' ? { data: 'new-req', error: null } : { data: { ok: true }, error: null }));
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'renewal', renewal }} />);
    await waitFor(() => expect(counter()).toBe('Step 1 of 3 · 3 left'));
    expect(screen.getByTestId('renew-plan')).toHaveTextContent('Completed ✓');
    fireEvent.click(screen.getByRole('button', { name: 'Choose the new rent and days' }));
    expect(await screen.findByTestId('renew-choice')).toHaveTextContent('Landlord raised the rent');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(counter()).toBe('Step 2 of 3 · 2 left'));
    fireEvent.click(await screen.findByRole('button', { name: 'Same house and landlord' }));
    await waitFor(() => expect(counter()).toBe('Step 3 of 3 · 1 left'));
    await screen.findByTestId('t4-ready');
    fireEvent.click(sendButton());
    expect(await screen.findAllByText('Sent to the Service Centre')).not.toHaveLength(0);
    // The rent and days were chosen once (step 1); step 3 only asked for the code.
    expect(mocks.renewalStart).toHaveBeenCalledTimes(1);
    expect(mocks.renewalConfirm).toHaveBeenCalledWith(expect.objectContaining({ prevId: 'prev-1' }), choice);
    expect(mocks.rpc).toHaveBeenCalledWith('renew_rent_request', expect.objectContaining({ p_prev_request_id: 'prev-1', p_new_rent_amount: 320000, p_new_days: 60 }));
  });

  it('another agent may renew this tenant: Agent Ops will confirm them as the agent', async () => {
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'renewal', renewal: { ...renewal, agentId: 'agent-2', tenantAsked: true } }} />);
    expect(await screen.findByTestId('renew-other-agent')).toHaveTextContent('Agent Ops will confirm you as this tenant’s agent.');
    expect(screen.getByText('Tenant asked to renew')).toBeInTheDocument();
  });

  it('moved house asks for new house photos and the GPS; a new landlord opens a new request', async () => {
    mocks.renewalStart.mockResolvedValue(choice);
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'renewal', renewal }} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Step 2: What changed/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'New landlord' }));
    fireEvent.click(await screen.findByRole('button', { name: /Post a new request for John/ }));
    expect(mocks.openT4).toHaveBeenCalledWith(expect.objectContaining({ mode: 'new', prefill: expect.objectContaining({ tenantId: 'tenant-1' }) }));
    fireEvent.click(screen.getByRole('button', { name: 'Moved house (same landlord)' }));
    expect(await screen.findAllByText(/Photo time!/)).not.toHaveLength(0);
  });
});

describe('E130: a resubmit shows only what resubmit_needs lists', () => {
  const ready = { family_size: 4, work_business: 'Tailor', work_location: null, lc1_phone_confirmation: null };
  const needsReply = (over: Record<string, unknown>) => ({ items: [], count: 0, desk: 'Tenant Ops', desk_note: null, auto_note: null, ...over });
  const withNeeds = (reply: unknown) => mocks.rpc.mockImplementation(async (fn: string) => (
    fn === 'resubmit_needs' ? { data: reply, error: null } : { data: { ok: true }, error: null }
  ));
  const counter = () => screen.getByTestId('intake-counter').textContent;

  it('only id_back missing: only the ID-back question, "1 to fix", the desk line, and the note already written', async () => {
    mocks.tables.pipeline_intake_details = ready;
    withNeeds(needsReply({
      items: [{ code: 'id_back', label: 'ID photo (back)', why: 'missing' }], count: 1,
      desk_note: 'The ID back is blurry', auto_note: 'Fixed: ID photo (back)',
    }));
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest() }} />);
    await waitFor(() => expect(counter()).toBe('1 to fix'));
    expect(screen.getByTestId('sent-back-by')).toHaveTextContent('Sent back by Tenant Ops: The ID back is blurry');
    expect(await screen.findAllByText(/And the BACK of John’s National ID/)).not.toHaveLength(0);
    // Nothing else is asked: no front, no rent, no face photo, no summary of everything.
    expect(screen.queryByText(/photo of the FRONT of/)).toBeNull();
    expect(screen.queryByText(/Monthly rent \(one month only\)/)).toBeNull();
    expect(screen.queryByText(/face photo \(head and shoulders\) of John/)).toBeNull();
    expect(screen.queryByTestId('resubmit-summary')).toBeNull();
    fireEvent.change(screen.getByLabelText('National ID back photo'), { target: { files: [new File(['b'], 'back.jpg', { type: 'image/jpeg' })] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(counter()).toBe('All fixed'));
    // Resubmit is there at once; the note was written for the agent.
    expect(screen.getByTestId('resubmit-note')).toHaveTextContent('Fixed: ID photo (back)');
    await waitFor(() => expect(sendButton()).toBeEnabled());
    fireEvent.click(sendButton());
    expect(await screen.findAllByText('Sent to the Service Centre')).not.toHaveLength(0);
    expect(mocks.rpc).toHaveBeenCalledWith('agent_resubmit_rent_request', expect.objectContaining({ p_request_id: 'req-9', p_agent_note: 'Fixed: ID photo (back)' }));
  });

  it('named and missing items are merged without duplicates, in the order given', async () => {
    mocks.tables.pipeline_intake_details = ready;
    withNeeds(needsReply({
      items: [
        { code: 'gps', label: 'GPS of the house', why: 'missing' },
        { code: 'id_back', label: 'ID photo (back)', why: 'desk' },
        { code: 'id_back', label: 'ID photo (back)', why: 'missing' },
      ],
      count: 2, auto_note: 'Fixed: GPS, ID back',
    }));
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest() }} />);
    await waitFor(() => expect(counter()).toBe('2 to fix'));
    const needed = within(screen.getByTestId('intake-needed')).getAllByRole('listitem').map((li) => li.textContent);
    expect(needed).toEqual(['GPS of the house', 'ID photo (back)']);
    // The first in the order given opens first.
    expect(await screen.findAllByText(/capture its GPS location|Capture location/)).not.toHaveLength(0);
  });

  it('count 0: the desk note is read for what it names', async () => {
    mocks.tables.pipeline_intake_details = ready;
    withNeeds(needsReply({ desk_note: 'The house photos are too dark' }));
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest() }} />);
    await waitFor(() => expect(counter()).toBe('1 to fix'));
    expect(await screen.findAllByText(/Photo time!/)).not.toHaveLength(0);
  });

  it('count 0 and nothing named: the summary with every line tappable, "Tap what you fixed"', async () => {
    mocks.tables.pipeline_intake_details = ready;
    withNeeds(needsReply({ desk_note: 'Please call the Service Centre' }));
    render(<RentRequestAssistant open onOpenChange={vi.fn()} request={{ mode: 'resubmit', rejected: rejectedRequest() }} />);
    expect(await screen.findByTestId('intake-counter')).toHaveTextContent('Tap what you fixed');
    expect(screen.getByTestId('sent-back-by')).toHaveTextContent('Sent back by Tenant Ops: Please call the Service Centre');
    const summary = await screen.findByTestId('resubmit-summary');
    fireEvent.click(within(summary).getByRole('button', { name: 'Redo: House GPS' }));
    expect(await screen.findAllByText(/capture its GPS location/)).not.toHaveLength(0);
  });
});
