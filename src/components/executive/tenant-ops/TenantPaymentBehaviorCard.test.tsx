import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a) } }));

import { TenantPaymentBehaviorCard } from './TenantPaymentBehaviorCard';
import { overviewFixture } from './workspace/payment-behavior/paymentBehavior.fixtures';

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

describe('TenantPaymentBehaviorCard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the self-pay share for the range Home is showing and opens the tab', async () => {
    rpcMock.mockResolvedValue({ data: overviewFixture.summary, error: null });
    const onOpen = vi.fn();
    render(<TenantPaymentBehaviorCard startIso="2026-10-05T00:00:00Z" endIso="2026-10-05T23:59:59Z" phrase="today" onOpen={onOpen} />, { wrapper });

    await waitFor(() => expect(screen.getByTestId('pb-card-pct')).toHaveTextContent('5.1%'));
    expect(screen.getByText(/38 of 748 tenants/)).toBeInTheDocument();
    expect(screen.getByText(/of paying tenants paid themselves today/)).toBeInTheDocument();
    expect(screen.getByText('+4.7 pts vs before')).toBeInTheDocument();
    expect(rpcMock).toHaveBeenCalledWith('tops_payment_behaviour_summary', expect.objectContaining({ p_start: '2026-10-05T00:00:00Z', p_end: '2026-10-05T23:59:59Z' }));

    await userEvent.setup().click(screen.getByRole('button', { name: 'Open Tenant Payment Behavior' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows a dash rather than a wrong number when the figures cannot load', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'not authorized' } });
    render(<TenantPaymentBehaviorCard startIso="a" endIso="b" phrase="today" onOpen={() => undefined} />, { wrapper });
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    expect(screen.getByTestId('pb-card-pct')).toHaveTextContent('—');
  });
});
