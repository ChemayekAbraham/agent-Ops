import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AgentOpsDashboard } from './AgentOpsDashboard';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), signage: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc, from: mocks.from } }));
vi.mock('@/hooks/usePendingAdvanceCount', () => ({ usePendingAdvanceCount: () => 0 }));
vi.mock('@/ops-tutorials/components/TutorialVideosButton', () => ({ default: () => null }));
vi.mock('./AgentDailyOverviewReportButton', () => ({ AgentDailyOverviewReportButton: () => null }));
vi.mock('@/components/supporter/UserProfileDialog', () => ({ UserProfileDialog: () => null }));
vi.mock('./agent-ops-v2/WelileSignagesOps', () => ({ WelileSignagesOps: () => { mocks.signage(); return <p>Selected signage queue</p>; } }));
beforeEach(() => { cleanup(); vi.clearAllMocks(); });
describe('Agent Ops active-section loading', () => {
  it('does not load earnings or Signages on the home grid, then opens the selected Signages section', async () => {
    render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AgentOpsDashboard /></QueryClientProvider></MemoryRouter>);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.signage).not.toHaveBeenCalled();
    const signage = screen.getAllByRole('button').find((button) => button.textContent?.includes('Welile Signages'));
    if (!signage) throw new Error('Signages navigation is missing');
    fireEvent.click(signage);
    expect(await screen.findByText('Selected signage queue')).toBeInTheDocument();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });
});