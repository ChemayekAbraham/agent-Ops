/**
 * The one-figure receivables summary that opens Agent, Tenant and Landlord Ops.
 *
 * Rules pinned here, straight from the brief:
 *  - a plain visit starts collapsed, showing the figure alone;
 *  - a figure that cannot be read says "Unavailable" — never 0 — and the whole
 *    dashboard opens by itself;
 *  - a link that asks for something specific opens the whole dashboard.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('@/hooks/useReceivables', () => ({
  useReceivablesTotal: () => mocks.query(),
}));

import { ReceivablesSummaryGate } from '@/components/receivables/ReceivablesSummaryGate';

const renderNode = (ui: ReactElement) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

const bodyText = () => document.body.textContent ?? '';

const ok = {
  data: {
    currency: 'UGX',
    as_at: '2026-10-22T15:03:00+00:00',
    total: 1204530116,
    item_count: 1547,
    categories: [],
    source: 'v_receivables_lines',
  },
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
};

const refused = { data: undefined, isError: true, isFetching: false, refetch: vi.fn() };

const DASHBOARD = 'The whole dashboard.';

describe('Receivables summary gate', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.query.mockReturnValue(ok);
  });

  it('opens on the figure alone and keeps the dashboard behind a button', () => {
    renderNode(<ReceivablesSummaryGate>{DASHBOARD}</ReceivablesSummaryGate>);
    expect(bodyText()).toMatch(/Total receivable/);
    expect(bodyText()).toMatch(/1,547 open items/);
    expect(bodyText()).toMatch(/As at .* EAT/);
    expect(screen.getByRole('button', { name: /Show all dashboard/ })).toBeInTheDocument();
    expect(bodyText()).not.toContain(DASHBOARD);
  });

  it('shows Unavailable, never 0, and opens the dashboard when the figure cannot be read', () => {
    mocks.query.mockReturnValue(refused);
    renderNode(<ReceivablesSummaryGate>{DASHBOARD}</ReceivablesSummaryGate>);
    expect(bodyText()).toMatch(/Unavailable/);
    expect(bodyText()).not.toMatch(/UGX 0/);
    expect(bodyText()).toContain(DASHBOARD);
  });

  it('opens the whole dashboard when the link asks for something specific', () => {
    renderNode(
      <ReceivablesSummaryGate startOpen>{DASHBOARD}</ReceivablesSummaryGate>,
    );
    expect(bodyText()).toContain(DASHBOARD);
    expect(screen.getByRole('button', { name: /Hide all dashboard/ })).toBeInTheDocument();
  });

  it('reads the figure again on Refresh', () => {
    const refetch = vi.fn();
    mocks.query.mockReturnValue({ ...ok, refetch });
    renderNode(<ReceivablesSummaryGate>{DASHBOARD}</ReceivablesSummaryGate>);
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
