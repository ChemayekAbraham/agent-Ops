import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const rpc = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
vi.mock('@/components/executive/AgentBioEditor', () => ({
  AgentBioEditor: ({ agentId }: { agentId: string }) => <div>Profile details: {agentId}</div>,
}));
import { AgentProfile360Sheet } from '@/components/executive/AgentProfile360Sheet';

describe('Recruitment sub-agent profiles', () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockImplementation(async (_name: string, args: { p_agent_id: string }) => ({
      data: {
        bio: { full_name: args.p_agent_id === 'parent' ? 'Recruiting agent' : 'Onboarded agent' },
        recruitment: args.p_agent_id === 'parent'
          ? { sub_agents: [{ id: 'child', full_name: 'Onboarded agent', phone: '0700000000', status: 'verified' }] }
          : {},
      }, error: null,
    }));
  });

  it('opens the selected sub-agent and returns to the recruiting agent’s Recruitment list', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['agent-profile-360', 'parent'], {
      bio: { full_name: 'Recruiting agent' },
      recruitment: { sub_agents: [{ id: 'child', full_name: 'Onboarded agent', phone: '0700000000', status: 'verified' }] },
    });
    // Start on Profile before Overview's existing collection reads can run.
    client.setQueryData(['agent-expected-week', 'parent'], { expected: 0, collected: 0 });
    client.setQueryData(['agent-target-cards', 'parent'], []);
    client.setQueryData(['agent-collection-performance', 'parent', 'weekly'], []);
    render(<QueryClientProvider client={client}><AgentProfile360Sheet agentId="parent" onOpenChange={() => {}} inline /></QueryClientProvider>);
    await userEvent.click(screen.getByRole('tab', { name: 'Recruitment' }));
    const name = await screen.findByRole('button', { name: 'Open profile for Onboarded agent' });
    name.focus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText('Profile details: child')).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith('get_agent_profile_360', { p_agent_id: 'child' });
    await userEvent.click(screen.getByRole('button', { name: 'Back to recruiting agent' }));
    expect(await screen.findByRole('button', { name: 'Open profile for Onboarded agent' })).toBeInTheDocument();
    expect(screen.queryByText('Profile details: child')).toBeNull();
  });
});