import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentProductsPanel } from '@/components/executive/agent-ops/AgentProductsPanel';

// The card itself is covered by merchandiseReceivablesReconciliationCard.test.tsx; here we only need to know
// whether the Agent Products panel renders it, so the card is replaced with a marker.
vi.mock('@/components/merchandise/MerchandiseReceivablesReconciliation', () => ({
  MerchandiseReceivablesReconciliation: () => <div>RECON-CARD-MARKER</div>,
}));

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: mocks }));

function chainable(): any {
  return new Proxy(function () {} as any, {
    get: (_t, prop) => {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
      return chainable();
    },
    apply: () => chainable(),
  });
}

function renderPanel(props: Parameters<typeof AgentProductsPanel>[0]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AgentProductsPanel {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockImplementation((fn: string) =>
    Promise.resolve({ data: fn.includes('overview') ? {} : [], error: null }));
  mocks.from.mockReturnValue(chainable());
});

describe('Receivables reconciliation card on the Agent Products panel', () => {
  it('shows the A12 + A13 card by default (CFO / CMO merchandise desks)', () => {
    renderPanel({ category: 'motor_bike' });
    expect(screen.getAllByText('RECON-CARD-MARKER').length).toBeGreaterThanOrEqual(1);
  });

  it('leaves the card out when the screen asks for it hidden (Agent Ops motor bikes)', () => {
    renderPanel({ category: 'motor_bike', showReceivablesReconciliation: false });
    expect(screen.queryByText('RECON-CARD-MARKER')).toBeNull();
  });
});
