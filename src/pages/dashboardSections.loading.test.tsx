import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useState, type ReactNode } from 'react';
import COODashboard from './coo/Dashboard';
import CFODashboard from './cfo/Dashboard';

const mocks = vi.hoisted(() => ({ ops: vi.fn(), cfo: vi.fn(), approvals: vi.fn(), budget: vi.fn() }));
vi.mock('@/hooks/usePersistedActiveTab', () => ({ usePersistedActiveTab: () => useState('overview') }));
vi.mock('@/components/layout/ExecutiveDashboardLayout', () => ({ default: ({ children, onTabChange, role }: { children: ReactNode; onTabChange: (id: string) => void; role: string }) => <div>
  <button onClick={() => onTabChange(role === 'coo' ? 'welile-signages-approvals' : 'signages')}>Open Signages</button>{children}
</div> }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/useCurrency', () => ({ useCurrency: () => ({ currency: { code: 'UGX' }, setCurrency: vi.fn(), getCurrencyByCode: vi.fn() }) }));
vi.mock('@/hooks/useSwipeSensitivity', () => ({ useSwipeSensitivity: () => ({ threshold: 50, setThreshold: vi.fn() }) }));
vi.mock('@/hooks/useHorizontalSwipe', () => ({ useHorizontalSwipe: () => ({}) }));
vi.mock('@/hooks/useCfoAdvanceDisbursementCount', () => ({ useCfoAdvanceDisbursementCount: () => 0 }));
vi.mock('@/components/cfo/CFOBreadcrumbHeader', () => ({ CFOBreadcrumbHeader: () => null }));
vi.mock('@/components/cfo/SwipeOnboardingHint', () => ({ SwipeOnboardingHint: () => null }));
vi.mock('@/components/cfo/CFOApprovalNotificationsBell', () => ({ CFOApprovalNotificationsBell: () => null }));
vi.mock('@/components/cfo/CFOOverviewDashboard', () => ({ CFOOverviewDashboard: () => <p>CFO overview</p> }));
vi.mock('@/components/coo/COOOverviewSnapshot', () => ({ default: () => <p>COO overview</p> }));
vi.mock('@/components/service-center/OverdueVettingOpsCard', () => ({ OverdueVettingOpsCard: () => null }));
vi.mock('@/components/cfo/ServiceCentreReceivablesPanel', () => ({ ServiceCentreReceivablesPanel: () => null }));
vi.mock('@/components/executive/tenant-ops/AgentNetworkBadge', () => ({ AgentNetworkBadge: () => null }));
vi.mock('@/components/shared/ShareSupporterRecruit', () => ({ ShareSupporterRecruit: () => null }));
vi.mock('@/components/executive/agent-ops-v2/WelileSignagesOps', () => ({ WelileSignagesOps: () => { mocks.ops(); return <p>COO Signages queue</p>; } }));
vi.mock('@/components/cfo/CFOSignagesDesk', () => ({ CFOSignagesDesk: () => { mocks.cfo(); return <p>CFO Signages queue</p>; } }));
vi.mock('@/components/coo/COOWithdrawalApprovals', () => ({ COOWithdrawalApprovals: () => { mocks.approvals(); return null; } }));
vi.mock('@/components/cfo/BudgetApprovalPanel', () => ({ default: () => { mocks.budget(); return null; } }));
beforeEach(() => { cleanup(); vi.clearAllMocks(); });
describe('Executive active-section loading', () => {
  it.each([{ Page: COODashboard, label: 'COO', queue: mocks.ops }, { Page: CFODashboard, label: 'CFO', queue: mocks.cfo }])('mounts only the active $label section', async ({ Page, label, queue }) => {
    render(<MemoryRouter><Page /></MemoryRouter>);
    expect(await screen.findByText(`${label} overview`)).toBeInTheDocument();
    expect(queue).not.toHaveBeenCalled();
    expect(mocks.approvals).not.toHaveBeenCalled();
    expect(mocks.budget).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open Signages' }));
    expect(await screen.findByText(`${label} Signages queue`)).toBeInTheDocument();
    expect(screen.queryByText(`${label} overview`)).not.toBeInTheDocument();
  });
});