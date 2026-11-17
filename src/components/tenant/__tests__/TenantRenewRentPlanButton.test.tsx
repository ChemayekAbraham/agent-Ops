import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let latest: Record<string, unknown> | null = null;
const rpcMock = vi.fn();
// A chainable query builder: rent_requests -> the latest request; anything else -> no row.
const builder = (table: string) => {
  const b: any = {};
  for (const m of ['select', 'eq', 'order', 'limit']) b[m] = () => b;
  b.maybeSingle = async () => ({ data: table === 'rent_requests' ? latest : null, error: null });
  return b;
};
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: (t: string) => builder(t) },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'tenant-1' } }) }));

import { TenantRenewRentPlanButton, isLatestPlanCompleted } from '../TenantRenewRentPlanButton';

const row = (status: string) => ({
  id: 'rr-1', status, rent_amount: 300000, total_repayment: 400000, daily_repayment: 13000, duration_days: 30,
  created_at: '2026-10-01T00:00:00Z', service_center_reviewed_at: null, coo_reviewed_at: null, approved_at: null,
  funded_at: null, disbursed_at: null, rejected_at: null,
});

const renderButton = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TenantRenewRentPlanButton />
    </QueryClientProvider>,
  );
};

const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  rpcMock.mockReset();
  latest = null;
});

describe('TenantRenewRentPlanButton', () => {
  it('counts completed and fully_repaid as completed', () => {
    expect(isLatestPlanCompleted('completed')).toBe(true);
    expect(isLatestPlanCompleted('fully_repaid')).toBe(true);
    expect(isLatestPlanCompleted('disbursed')).toBe(false);
    expect(isLatestPlanCompleted(null)).toBe(false);
  });

  it.each(['disbursed', 'pending', 'rejected'])('is hidden when the latest request is %s', async (status) => {
    latest = row(status);
    const { container } = renderButton();
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it('is hidden when the tenant has no request', async () => {
    const { container } = renderButton();
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows for a completed plan, calls tenant_request_renewal and keeps the message', async () => {
    latest = row('fully_repaid');
    let resolve!: (v: unknown) => void;
    rpcMock.mockReturnValue(new Promise((r) => { resolve = r; }));
    renderButton();
    const btn = await screen.findByRole('button', { name: /Renew my rent plan/ });
    await userEvent.click(btn);
    expect(rpcMock).toHaveBeenCalledWith('tenant_request_renewal');
    expect(btn).toBeDisabled();
    resolve({ data: { ok: true, message: 'Your agent will call you about renewing.' }, error: null });
    expect(await screen.findByText('Your agent will call you about renewing.')).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
  });

  it('shows the error message as it comes', async () => {
    latest = row('completed');
    rpcMock.mockResolvedValue({ data: null, error: { message: 'You already asked to renew.' } });
    renderButton();
    await userEvent.click(await screen.findByRole('button', { name: /Renew my rent plan/ }));
    expect(await screen.findByText('You already asked to renew.')).toBeInTheDocument();
  });
});
