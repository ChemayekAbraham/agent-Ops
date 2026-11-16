import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a) },
}));
const openMock = vi.fn();
vi.mock('@/lib/t4RentRequest', () => ({ openT4RentRequest: (...a: unknown[]) => openMock(...a) }));

import { ReadyToRenewCard } from '../ReadyToRenewCard';

const renderCard = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReadyToRenewCard />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  rpcMock.mockReset();
  openMock.mockReset();
});

/** A row exactly as ready_to_renew returns it (E128). */
const exactRow = (over: Record<string, unknown> = {}) => ({
  last_request_id: '6f1c2a9e-0000-4000-8000-000000000001', ref: 'RR-1042',
  tenant: { id: 't-1', name: 'Grace Nakato', phone: '0700000001' },
  agent: { id: 'a-2', name: 'Agent Two', phone: '0700000002' },
  last_rent: 300000, last_days: 30, repaid: 420000, total: 420000,
  completed_on: '2026-11-01', tenant_asked: false,
  ...over,
});

describe('ReadyToRenewCard', () => {
  it('one row in the exact E128 shape renders, and Renew opens the renewal (step 1) with last_request_id', async () => {
    rpcMock.mockResolvedValue({ data: [exactRow()], error: null });
    renderCard();
    const [row] = await screen.findAllByTestId('ready-to-renew-row');
    expect(rpcMock).toHaveBeenCalledWith('ready_to_renew', {});
    expect(screen.getByText('Ready to renew (1)')).toBeInTheDocument();
    expect(within(row).getByText('Grace Nakato')).toBeInTheDocument();
    expect(row.textContent).toMatch(/300,000 · 30 days · Completed 1 Nov 2026 · RR-1042/);
    await userEvent.click(within(row).getByRole('button', { name: 'Renew' }));
    expect(openMock).toHaveBeenCalledWith({
      mode: 'renewal',
      entry: 'ready-to-renew',
      renewal: {
        prevId: '6f1c2a9e-0000-4000-8000-000000000001', tenantId: 't-1', tenantName: 'Grace Nakato', tenantPhone: '0700000001',
        currentRent: 300000, currentDays: 30, agentId: 'a-2', tenantAsked: false,
      },
    });
  });

  it('lists tenant-asked rows first', async () => {
    rpcMock.mockResolvedValue({
      data: [
        exactRow({ last_request_id: 'rr-new', tenant: { id: 't-1', name: 'Newest Done', phone: '0701' }, completed_on: '2026-11-10' }),
        exactRow({ last_request_id: 'rr-asked', tenant: { id: 't-2', name: 'Asked Tenant', phone: '0702' }, completed_on: '2026-10-01', tenant_asked: true }),
      ],
      error: null,
    });
    renderCard();
    const rows = await screen.findAllByTestId('ready-to-renew-row');
    expect(within(rows[0]).getByText('Asked Tenant')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Tenant asked')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Newest Done')).toBeInTheDocument();
    expect(within(rows[1]).queryByText('Tenant asked')).toBeNull();
  });

  it('renders nothing when the list is empty', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    const { container } = renderCard();
    await vi.waitFor(() => expect(rpcMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the call fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    rpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { container } = renderCard();
    // The hook retries once (about 1 s) before it reports the error.
    await vi.waitFor(() => expect(warn).toHaveBeenCalled(), { timeout: 4000 });
    expect(container).toBeEmptyDOMElement();
    warn.mockRestore();
  });
});
