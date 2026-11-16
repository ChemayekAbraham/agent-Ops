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

describe('ReadyToRenewCard', () => {
  it('lists tenant-asked rows first and Renew opens the T4 renewal', async () => {
    rpcMock.mockResolvedValue({
      data: [
        { prev_request_id: 'rr-new', tenant: { id: 't-1', name: 'Newest Done', phone: '0701' }, agent: { id: 'a-1', name: 'Me' }, last_rent: 200000, last_days: 30, completed_on: '2026-11-10', tenant_asked: false },
        { prev_request_id: 'rr-asked', tenant: { id: 't-2', name: 'Asked Tenant', phone: '0702' }, agent: { id: 'a-2', name: 'Other' }, last_rent: 350000, last_days: 60, completed_on: '2026-10-01', tenant_asked: true },
      ],
      error: null,
    });
    renderCard();

    const rows = await screen.findAllByTestId('ready-to-renew-row');
    expect(rpcMock).toHaveBeenCalledWith('ready_to_renew', {});
    expect(screen.getByText('Ready to renew (2)')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Asked Tenant')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Tenant asked')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Newest Done')).toBeInTheDocument();
    expect(within(rows[1]).queryByText('Tenant asked')).toBeNull();
    expect(rows[0].textContent).toMatch(/350,000/);
    expect(rows[0].textContent).toMatch(/60 days/);
    expect(rows[0].textContent).toMatch(/Completed 1 Oct 2026/);

    await userEvent.click(within(rows[0]).getByRole('button', { name: 'Renew' }));
    expect(openMock).toHaveBeenCalledWith({
      mode: 'renewal',
      entry: 'ready-to-renew',
      renewal: {
        prevId: 'rr-asked', tenantId: 't-2', tenantName: 'Asked Tenant', tenantPhone: '0702',
        currentRent: 350000, currentDays: 60, agentId: 'a-2', tenantAsked: true,
      },
    });
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
