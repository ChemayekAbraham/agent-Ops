import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), upload: vi.fn(), from: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: mocks.from,
    storage: { from: () => ({ upload: mocks.upload }) },
  },
}));
vi.mock('@/lib/imageOptimizer', () => ({ optimizeImage: vi.fn(async (file: File) => ({ file })) }));
vi.mock('@/components/agent/EditTenantDialog', () => ({ EditTenantDialog: () => null }));
// The data hook waits for a signed-in session (useAuthenticatedAudience); this test is always signed in.
vi.mock('@/hooks/useAuthenticatedPoll', () => ({ useAuthenticatedAudience: () => true, requireUserSession: async () => {} }));

import { AgentCompleteRequestsCard } from '@/components/agent/AgentCompleteRequestsCard';

type Row = { id: string; req: string; tenant: string; status: string; submitted_at: string; rent: number; missing: string[] };
const row = (id: string, missing: string[]): Row => ({
  id, req: `RR-${id}`, tenant: `Tenant ${id}`, status: 'pending', submitted_at: '2026-11-01T08:00:00Z', rent: 300000, missing,
});

/** Serves agent_requests_missing_details from `list`, and records every other RPC call. */
function serve(list: { rows: Row[] }, onSave?: () => void) {
  mocks.rpc.mockImplementation(async (fn: string) => {
    if (fn === 'agent_requests_missing_details') return { data: list, error: null };
    onSave?.();
    return { data: { ok: true }, error: null };
  });
}

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AgentCompleteRequestsCard agentId="agent-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.upload.mockResolvedValue({ error: null });
});

describe('Complete your requests card', () => {
  it('is hidden when no request is missing details', async () => {
    serve({ rows: [] });
    const { container } = mount();
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('agent_requests_missing_details', undefined));
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the count and inline inputs only for what each request is missing', async () => {
    serve({ rows: [row('1', ['family_size']), row('2', ['lc1_letter']), row('3', ['tenant_full_name']), row('4', ['work_business'])] });
    mount();
    expect(await screen.findByText('Complete your requests (4)')).toBeInTheDocument();

    const r1 = within(screen.getByTestId('complete-request-1'));
    expect(r1.getByLabelText('Family size')).toBeInTheDocument();
    expect(r1.queryByLabelText(/work or business/i)).toBeNull();
    expect(r1.queryByLabelText('LC1 letter photo')).toBeNull();
    expect(r1.queryByText(/Ask the tenant for their full name/)).toBeNull();

    const r2 = within(screen.getByTestId('complete-request-2'));
    expect(r2.getByLabelText('LC1 letter photo')).toBeInTheDocument();
    expect(r2.queryByLabelText('Family size')).toBeNull();
    expect(r2.queryByRole('button', { name: /Save details/ })).toBeNull();

    const r3 = within(screen.getByTestId('complete-request-3'));
    expect(r3.getByText(/Ask the tenant for their full name/)).toBeInTheDocument();
    expect(r3.queryByLabelText('Family size')).toBeNull();
    expect(r3.queryByLabelText('LC1 letter photo')).toBeNull();

    const r4 = within(screen.getByTestId('complete-request-4'));
    expect(r4.getByLabelText(/work or business/i)).toBeInTheDocument();
    expect(r4.getByLabelText(/Work location/)).toBeInTheDocument();
    expect(r4.queryByLabelText('Family size')).toBeNull();
  });

  it('saves family size + work through agent_save_intake_details, then refetches and drops the row', async () => {
    const list = { rows: [row('1', ['family_size', 'work_business'])] };
    serve(list, () => { list.rows = []; });
    mount();
    const r1 = within(await screen.findByTestId('complete-request-1'));

    fireEvent.click(r1.getByRole('button', { name: /Save details/ }));
    expect(await r1.findByRole('alert')).toHaveTextContent(/household/);
    expect(mocks.rpc).not.toHaveBeenCalledWith('agent_save_intake_details', expect.anything());

    fireEvent.change(r1.getByLabelText('Family size'), { target: { value: '5' } });
    fireEvent.change(r1.getByLabelText(/work or business/i), { target: { value: 'Sells charcoal' } });
    fireEvent.change(r1.getByLabelText(/Work location/), { target: { value: 'Kalerwe' } });
    fireEvent.click(r1.getByRole('button', { name: /Save details/ }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('agent_save_intake_details', {
      p_request_id: '1', p_family_size: 5, p_work_business: 'Sells charcoal', p_work_location: 'Kalerwe',
    }));
    await waitFor(() => expect(screen.queryByText(/Complete your requests/)).toBeNull());
    expect(mocks.rpc.mock.calls.filter(([fn]) => fn === 'agent_requests_missing_details').length).toBeGreaterThanOrEqual(2);
  });

  it('shows a save error from the server as-is and keeps the row', async () => {
    mocks.rpc.mockImplementation(async (fn: string) => (fn === 'agent_requests_missing_details'
      ? { data: { rows: [row('1', ['family_size'])] }, error: null }
      : { data: null, error: { message: 'REQUEST_LOCKED: already funded' } }));
    mount();
    const r1 = within(await screen.findByTestId('complete-request-1'));
    fireEvent.change(r1.getByLabelText('Family size'), { target: { value: '3' } });
    fireEvent.click(r1.getByRole('button', { name: /Save details/ }));
    expect(await r1.findByRole('alert')).toHaveTextContent('REQUEST_LOCKED: already funded');
    expect(screen.getByTestId('complete-request-1')).toBeInTheDocument();
  });

  it('uploads the LC1 letter to the existing storage path, then calls agent_attach_lc1_letter', async () => {
    serve({ rows: [row('9', ['lc1_letter'])] });
    mount();
    const r9 = within(await screen.findByTestId('complete-request-9'));
    const file = new File(['x'], 'letter.jpg', { type: 'image/jpeg' });
    fireEvent.change(r9.getByLabelText('LC1 letter photo'), { target: { files: [file] } });
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('agent_attach_lc1_letter', {
      p_request_id: '9', p_path: 'agent-1/9/lc_letter.jpg',
    }));
    expect(mocks.upload).toHaveBeenCalledWith('agent-1/9/lc_letter.jpg', file, expect.objectContaining({ upsert: true }));
  });
});
