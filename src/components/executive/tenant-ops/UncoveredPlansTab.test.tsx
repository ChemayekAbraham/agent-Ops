import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { UncoveredPlanRow } from '@/lib/agentMonitoringUncovered';

const mk = (i: number, over: Partial<UncoveredPlanRow> = {}): UncoveredPlanRow => ({
  id: `p${i}`, bucket: 'tenant_paying_no_landlord', tenantId: `t${i}`, tenantName: `Tenant ${String(i).padStart(2, '0')}`,
  tenantPhone: `+2567000000${String(i).padStart(2, '0')}`, agentId: i % 2 ? 'a1' : 'a2', agentName: i % 2 ? 'Agent One' : 'Agent Two',
  fundedAmount: 400_000, totalRepayment: 520_000, repaid: i * 10_000, stillOwed: 520_000 - i * 10_000, fundedOn: '2026-10-01',
  daysSinceFunding: i, payout: { kind: 'none', paidAmount: 0, allocatedAmount: 0 }, pipelineStatus: 'repaying', ...over,
});

let data: { tenantPaying: UncoveredPlanRow[]; awaiting: UncoveredPlanRow[]; asOf: string } | undefined;
let state = { isLoading: false, isError: false, isSuccess: true, error: null as unknown, refetch: vi.fn() };

vi.mock('@/hooks/useAgentMonitoringUncovered', () => ({
  useAgentMonitoringUncovered: () => ({ data, ...state }),
}));
vi.mock('@/components/ops/UserDrilldownDrawer', () => ({
  UserDrilldownDrawer: ({ open, tenantId }: { open: boolean; tenantId: string | null }) =>
    open ? <div data-testid="drawer">tenant {tenantId}</div> : null,
}));

import { UncoveredPlansTab } from './UncoveredPlansTab';

describe('UncoveredPlansTab', () => {
  beforeEach(() => {
    state = { isLoading: false, isError: false, isSuccess: true, error: null, refetch: vi.fn() };
    data = {
      tenantPaying: Array.from({ length: 30 }, (_, i) => mk(i + 1)),
      awaiting: [mk(1, { bucket: 'awaiting_landlord', repaid: 0, stillOwed: 520_000, daysSinceFunding: 9, pipelineStatus: 'funded', payout: { kind: 'failed', paidAmount: 0, allocatedAmount: 0 } })],
      asOf: '2026-10-12',
    };
  });

  it('shows the summary cards and the first page, most repaid first, with pagination', () => {
    render(<UncoveredPlansTab bucket="tenant_paying_no_landlord" />);
    expect(screen.getByText('Total repaid')).toBeTruthy();
    expect(screen.getAllByText('Still owed').length).toBeGreaterThan(0); // card and column heading
    expect(screen.getAllByText('Tenant 30').length).toBeGreaterThan(0); // most repaid is first
    expect(screen.getByText(/1–25 of 30 Rent Plans/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText(/26–30 of 30 Rent Plans/)).toBeTruthy();
  });

  it('searches, resets to page 1 and opens only the existing tenant profile', () => {
    render(<UncoveredPlansTab bucket="tenant_paying_no_landlord" />);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    fireEvent.change(screen.getByLabelText('Search tenant, phone or agent'), { target: { value: 'Tenant 07' } });
    expect(screen.getByText(/1–1 of 1 Rent Plans/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Tenant 07' })[0]);
    expect(screen.getByTestId('drawer').textContent).toContain('t7');
  });

  it('has no action buttons that change data', () => {
    render(<UncoveredPlansTab bucket="tenant_paying_no_landlord" />);
    const names = screen.getAllByRole('button').map((b) => b.textContent?.trim() ?? '');
    expect(names.some((n) => /approve|reject|delete|save|send|pay|reverse|edit/i.test(n))).toBe(false);
  });

  it('the awaiting list has days waiting and no repayment columns', () => {
    render(<UncoveredPlansTab bucket="awaiting_landlord" />);
    expect(screen.getAllByText('Days waiting').length).toBeGreaterThan(0);
    expect(screen.queryByText('Repaid so far')).toBeNull();
    expect(screen.queryByText('Total repaid')).toBeNull();
    expect(screen.getAllByText('Payout failed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Funded').length).toBeGreaterThan(0);
  });

  it('shows the empty message when no Rent Plan is in this position', () => {
    data = { tenantPaying: [], awaiting: [], asOf: '2026-10-12' };
    render(<UncoveredPlansTab bucket="awaiting_landlord" />);
    expect(screen.getByText('No funded Rent Plan is waiting for its landlord payout right now.')).toBeTruthy();
  });

  it('shows an error with a retry instead of numbers when loading fails', () => {
    data = undefined;
    state = { isLoading: false, isError: true, isSuccess: false, error: new Error('Not authorized'), refetch: vi.fn() };
    render(<UncoveredPlansTab bucket="tenant_paying_no_landlord" />);
    expect(screen.getByText('Not authorized')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(state.refetch).toHaveBeenCalled();
  });
});
