import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApplicationPerformance } from '@/components/executive/agent-ops/AgentApplicationPerformance';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: mocks }));
vi.mock('@/lib/kampalaDays', () => ({ kampalaTodayYmd: () => '2026-10-21', kampalaOffsetYmd: () => '2026-09-22' }));
const report = { kpis: { expected_window: 120000, collected_window: 90000, window_rate: 75, payments_window: 18, active_repaying: 4, outstanding: 600000 } };
function mount(agentId = 'agent-daniel') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><AgentApplicationPerformance agentId={agentId} /></QueryClientProvider>);
}
beforeEach(() => { vi.clearAllMocks(); mocks.rpc.mockResolvedValue({ data: report, error: null }); });
describe('agent application performance', () => {
  it('reads the selected agent report for the inclusive Kampala 30-day window', async () => {
    mount();
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('agent_ops_report_agent', { p_agent_id: 'agent-daniel', p_from: '2026-09-22', p_to: '2026-10-21' }));
    expect(await screen.findByText('UGX 90,000')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it('does not substitute a zero report for a failed request and supports retry', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Unavailable' } });
    mount();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('UGX 0')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('UGX 90,000')).toBeInTheDocument();
  });
  it('reads a different applicant independently', async () => {
    mount('agent-enock');
    await screen.findByText('UGX 90,000');
    expect(mocks.rpc).toHaveBeenCalledWith('agent_ops_report_agent', expect.objectContaining({ p_agent_id: 'agent-enock' }));
  });
  it('preserves an unavailable rate instead of claiming zero performance', async () => {
    mocks.rpc.mockResolvedValue({ data: { kpis: { ...report.kpis, window_rate: null } }, error: null });
    mount();
    expect(await screen.findByText('—')).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });
});