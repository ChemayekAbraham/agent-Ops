import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const rpcMock = vi.fn();
const fromChain = {
  select: () => fromChain,
  eq: () => fromChain,
  order: () => Promise.resolve({ data: [], error: null }),
  update: () => fromChain,
};
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: () => fromChain, storage: { from: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: [] }) }));
vi.mock('@/hooks/useCrmVoiceCall', () => ({
  useCrmVoiceCall: () => ({ state: 'idle', callId: null, elapsed: 0, error: null, isEnding: false, start: vi.fn(), end: vi.fn() }),
  useHumanCallingPaused: () => ({ data: { paused: false, reason: null, paused_at: null } }),
  isTerminalCallState: () => false,
}));
vi.mock('@/components/coo/CooReasonPicker', () => ({
  useCooReasonPicker: () => ({ picker: null, askReason: vi.fn(), meaningOf: () => null }),
}));

import { ContactCards, ScriptPanel, mobileMoneyMismatch, rentOnRequestText, type LandlordContext } from '../landlordOps';
import { ReviewDrawer } from '../ReviewDrawer';
import { ReviewStatusProvider } from '../reviewStatus';
import { primaryLabel, type BoardRow } from '../boardApi';

const CTX: LandlordContext = {
  rent_on_request: 500000,
  duration_days: 30,
  tenant: { id: 't1', name: 'Tina Tenant', phone: '+256700000001', payment_health: { status: 'watch', summary: 'Paid 70% of what was due', completed_plans: 1, completed_repaid_pct: 80, active_plans: 1, active_collected_pct: 70, owing: 50000 } },
  agent: { id: 'a1', name: 'Andy Agent', phone: '+256700000002' },
  landlord: {
    id: 'l1', name: 'Lucy Landlord', phone: '0700000003', mobile_money_number: '0700000004', mobile_money_name: 'Peter Other', verified: true,
    caretaker: { name: 'Carl Caretaker', phone: '0700000005' }, is_agent_managed: false, number_of_houses: 6, arrears_hint: 'Tenant owed 2 months last year', welile_tenants: 3,
  },
  script: { title: 'Landlord welcome', body: 'Hello, I am calling from Welile about your tenant.', version: 4 },
};

const item = (code: string, label: string, value_kind: 'amount' | null = null) => ({
  code, stage: 'landlord_ops', label, question: `${label}?`, method: 'call', weight: 1, required: false, on_fail: 'send_back',
  value_kind, assumption: null, system_said: null, system_detail: null, last: null,
});

const SHEET = {
  request: {
    id: 'req-1', status: 'tenant_ops_approved', stage: 'landlord_ops', round: 0, rent_amount: 500000, duration_days: 30, created_at: '2026-11-01',
    tenant: { id: 't1', name: 'Tina Tenant', phone: '+256700000001', occupation: null },
    agent: { id: 'a1', name: 'Andy Agent', phone: '+256700000002' },
    landlord: { id: 'l1', name: 'Lucy Landlord', phone: '0700000003', verified: true },
    lc1: null, lc_letter: null, house_photos: [], gps: null, funder_visible: true,
  },
  checklist: [
    item('lo_reachable', 'Landlord reachable'),
    item('lo_rent_confirmed', 'Rent confirmed by the landlord'),
    item('lo_tenant_no_arrears', 'Tenant not in rent arrears'),
    item('lo_value_prop', 'Value proposition offered'),
  ],
  history: [], score: null, recommendation: null, can_review: true, my_staff_ref: 'EMP-1',
};

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockImplementation((fn: string) => {
    if (fn === 'pipeline_review_sheet') return Promise.resolve({ data: SHEET, error: null });
    if (fn === 'landlord_ops_context') return Promise.resolve({ data: CTX, error: null });
    if (fn === 'pipeline_concerns_list' || fn === 'pipeline_request_calls' || fn === 'pipeline_waiting_list') return Promise.resolve({ data: [], error: null });
    return Promise.resolve({ data: null, error: null });
  });
});

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReviewStatusProvider>{ui}</ReviewStatusProvider>
    </QueryClientProvider>,
  );
}

describe('Landlord Ops contact cards', () => {
  it('landlord, tenant and agent each get a call button', () => {
    wrap(<ContactCards ctx={CTX} requestId="req-1" />);
    expect(screen.getByRole('button', { name: /Call Lucy Landlord/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Call Tina Tenant/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Call Andy Agent/ })).toBeTruthy();
    const landlord = screen.getByRole('region', { name: 'Landlord' });
    expect(within(landlord).getByText('Verified').getAttribute('data-tone')).toBe('ok');
    // Mobile money in another name than the landlord's is amber.
    expect(landlord.querySelector('[data-mismatch="true"]')?.textContent).toMatch(/Peter Other/);
    expect(within(landlord).getByText(/Carl Caretaker/)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Tenant' })).getByText('Payment: Watch')).toBeTruthy();
  });

  it('mobile money name match ignores case and spacing', () => {
    expect(mobileMoneyMismatch('Lucy  Landlord', 'LUCY LANDLORD')).toBe(false);
    expect(mobileMoneyMismatch('Lucy Landlord', 'Peter Other')).toBe(true);
    expect(mobileMoneyMismatch('Lucy Landlord', null)).toBe(false);
    expect(rentOnRequestText(500000)).toBe('Rent on the request: UGX 500,000');
  });

  it('the script panel renders its title and body', () => {
    wrap(<ScriptPanel script={CTX.script} />);
    expect(screen.getByText('Call script: Landlord welcome')).toBeTruthy();
    expect(screen.getByText(/calling from Welile about your tenant/)).toBeTruthy();
  });

  it('the pass button reads "Forward to COO"', () => {
    expect(primaryLabel({ decision: 'pass' } as BoardRow, 'landlord_ops')).toBe('Forward to COO');
  });
});

describe('Landlord Ops drawer', () => {
  it('shows rent, the arrears hint and the script, and sends the confirmed rent as the check value', async () => {
    wrap(<ReviewDrawer stage="landlord_ops" requestId="req-1" onClose={() => {}} />);

    // Rent on the request, beside "Rent confirmed by the landlord" (and in the header panel).
    await waitFor(() => expect(screen.getAllByText(/Rent on the request: UGX 500,000/).length).toBeGreaterThan(0));
    // The arrears hint sits beside "Tenant not in rent arrears".
    expect(screen.getByText('Arrears hint: Tenant owed 2 months last year')).toBeTruthy();
    // The call script sits right above "Value proposition offered".
    const script = screen.getByRole('region', { name: 'Call script' });
    const valueProp = screen.getByText('Value proposition offered');
    expect(script.compareDocumentPosition(valueProp) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Pass the rent check: the amount box appears; type what the landlord said.
    const rentRow = screen.getByText('Rent confirmed by the landlord').closest('li') as HTMLElement;
    fireEvent.click(within(rentRow).getByRole('button', { name: 'Pass' }));
    const amount = within(rentRow).getByRole('spinbutton');
    expect(amount.getAttribute('placeholder')).toBe('500000');
    fireEvent.change(amount, { target: { value: '480000' } });

    // Record a "Call again" (no call needed for it) and check the value went with the check.
    fireEvent.click(screen.getByRole('button', { name: /Call again/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Record the review and act' }));
    await waitFor(() => expect(rpcMock.mock.calls.some((c) => c[0] === 'pipeline_record_review')).toBe(true));
    const args = rpcMock.mock.calls.find((c) => c[0] === 'pipeline_record_review')![1];
    expect(args.p_stage).toBe('landlord_ops');
    expect(args.p_results).toContainEqual({ code: 'lo_rent_confirmed', result: 'pass', value: 480000 });
  });
});
