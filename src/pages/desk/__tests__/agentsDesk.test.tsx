import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
const fromResult = { data: { agent_id: 'a1', assigned_agent_id: null } as unknown, error: null as unknown };
const fromChain = {
  select: () => fromChain,
  eq: () => fromChain,
  maybeSingle: () => Promise.resolve(fromResult),
  order: () => Promise.resolve({ data: [], error: null }),
};
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: () => fromChain, storage: { from: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: [] }) }));
vi.mock('@/hooks/useCrmVoiceCall', () => ({
  useCrmVoiceCall: () => ({ state: 'idle', callId: null, elapsed: 0, error: null, isEnding: false, start: vi.fn(), end: vi.fn() }),
  useHumanCallingPaused: () => ({ data: { paused: false, reason: null, paused_at: null } }),
  isTerminalCallState: () => false,
}));

import { DESKS, feedsOf } from '../deskConfig';
import { AgentsDesk, ruleText } from '../agents/AgentsDesk';
import { isBelow, planPct, plansText, statusWords, uniqueByName, type PortfolioRow } from '../agents/agentPortfolioApi';
import { CooBoard, type CooRow } from '../CooBoard';

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
afterEach(() => setWidth(1024));
beforeEach(() => {
  rpcMock.mockReset();
  fromResult.data = { agent_id: 'a1', assigned_agent_id: null };
  fromResult.error = null;
});

const wrap = (ui: ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

const agentRow = (over: Partial<PortfolioRow>): PortfolioRow => ({
  agent_id: 'a1', name: 'Andy Agent', phone: '0700000001', grade: 'B', plans: 4, active: 2, completed: 1, funded_not_started: 1,
  plan_value: 12_500_000, due_so_far: 4_000_000, collected: 3_000_000, pct: 75, arrears_active: 1_000_000,
  eligible: true, new_agent: false, open_requests: 2, frozen_requests: 0, ...over,
});

const PORTFOLIO = {
  summary: { agents: 120, eligible: 80, below_50: 30, new: 10, frozen_requests: 7 },
  rows: [agentRow({}), agentRow({ agent_id: 'a2', name: 'Bena Low', pct: 32.4, eligible: false, frozen_requests: 3 })],
  rule: 'AGENT-ELIG v2 (E61): collected / due so far across ALL the agent\'s rent plans combined (active and finished) >= 50%',
  as_of: '2026-11-09T08:00:00Z',
};

const PLANS = {
  agent: { agent_id: 'a1', name: 'Andy Agent', phone: '0700000001' },
  eligibility: { eligible: false, new_agent: false, pct: 32, plans: 2, open_requests: 1, reason: 'collected only 32% across all 2 rent plans (needs 50%)', rule: 'x' },
  plans: [
    { rent_request_id: 'p1', short_id: 'p1aaaaaa', tenant: 'Tina Tenant', status: 'repaying', funded_at: '2026-09-01T09:00:00Z', starts_on: '2026-09-02', rent: 1_000_000, plan_value: 1_330_000, due_so_far: 600_000, repaid: 150_000 },
    { rent_request_id: 'p2', short_id: 'p2bbbbbb', tenant: 'Tom Tenant', status: 'completed', funded_at: '2026-05-01T09:00:00Z', starts_on: null, rent: 500_000, plan_value: 665_000, due_so_far: 665_000, repaid: 665_000 },
  ],
  open_requests: [{ rent_request_id: 'o1', short_id: 'o1cccccc', tenant: 'Olga Open', status: 'partner_ops_approved', rent: 800_000, created_at: '2026-11-01T09:00:00Z' }],
};

const mockRpc = () =>
  rpcMock.mockImplementation((fn: string) =>
    Promise.resolve(
      fn === 'desk_agent_portfolio'
        ? { data: PORTFOLIO, error: null }
        : fn === 'desk_agent_plans'
          ? { data: PLANS, error: null }
          : { data: null, error: null },
    ),
  );

describe('Agents desk config', () => {
  it('sits right after the COO desk, for COO, CEO, Agent Ops and CFO, and reads no desk feed', () => {
    const ids = DESKS.map((d) => d.id);
    expect(ids[ids.indexOf('coo') + 1]).toBe('agents');
    const agents = DESKS.find((d) => d.id === 'agents')!;
    expect(agents.name).toBe('Agents');
    expect(agents.roles).toEqual(expect.arrayContaining(['coo', 'ceo', 'agent_ops', 'cfo']));
    expect(agents.roles).not.toContain('tenant_ops');
    expect(feedsOf(agents)).toEqual([]);
  });
});

describe('Agents desk helpers', () => {
  it('reads plans, percentages, statuses and the rule in desk words', () => {
    expect(plansText(agentRow({}))).toBe('2 / 1 / 1');
    expect(isBelow(49.9)).toBe(true);
    expect(isBelow(50)).toBe(false);
    expect(isBelow(null)).toBe(false);
    expect(planPct({ due_so_far: 0, repaid: 10 })).toBeNull();
    expect(planPct({ due_so_far: 200, repaid: 50 })).toBe(25);
    expect(statusWords('funded')).toBe('Not started');
    expect(statusWords('partner_ops_approved')).toBe('COO');
    expect(ruleText('AGENT-ELIG v1: collected / due-to-date')).toBe('Collected / due-to-date');
    expect(uniqueByName([{ agent_id: 'a', name: 'Andy  Agent' }, { agent_id: 'b', name: 'Bob' }], 'andy agent')).toBe('a');
    expect(uniqueByName([{ agent_id: 'a', name: 'Bob' }, { agent_id: 'b', name: 'Bob' }], 'Bob')).toBeNull();
  });
});

describe('Agents desk', () => {
  it('shows the summary chips and one row per agent, UGX in full, under-50% in red', async () => {
    setWidth(1280);
    mockRpc();
    wrap(<AgentsDesk board={false} />);
    await screen.findByText('Bena Low');
    const summary = document.querySelector('[data-agent-summary]') as HTMLElement;
    expect(summary.textContent).toContain('120 agents');
    expect(summary.textContent).toContain('30 below 50%');
    expect(summary.textContent).toContain('7 requests frozen');
    expect(rpcMock).toHaveBeenCalledWith('desk_agent_portfolio', { p_search: null, p_filter: 'all', p_limit: 500 });
    const andy = document.querySelector('[data-agent="a1"]') as HTMLElement;
    expect(andy.textContent).toContain('UGX 12,500,000');
    expect(andy.textContent).toContain('2 / 1 / 1');
    const bena = document.querySelector('[data-agent="a2"] [data-pct]') as HTMLElement;
    expect(bena.textContent).toBe('32%');
    expect(bena.className).toMatch(/font-semibold/);
    expect((document.querySelector('[data-agent="a1"] [data-pct]') as HTMLElement).className).not.toMatch(/font-semibold/);
    expect(screen.getByText(/^Rule: Collected/)).toBeTruthy();
  });

  it('a filter chip asks the server for that filter', async () => {
    setWidth(1280);
    mockRpc();
    wrap(<AgentsDesk board={false} />);
    await screen.findByText('Bena Low');
    fireEvent.click(within(screen.getByRole('group', { name: 'Show agents' })).getByRole('button', { name: /Requests frozen/ }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('desk_agent_portfolio', { p_search: null, p_filter: 'frozen_requests', p_limit: 500 }));
  });

  it('tapping a row opens the agent sheet: eligibility, plans, open requests', async () => {
    setWidth(1280);
    mockRpc();
    wrap(<AgentsDesk board={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Andy Agent' }));
    const sheet = await screen.findByRole('dialog', { name: 'Andy Agent' });
    await within(sheet).findByText('Tina Tenant');
    expect(rpcMock).toHaveBeenCalledWith('desk_agent_plans', { p_agent: 'a1' });
    expect(sheet.querySelector('[data-eligibility]')?.textContent).toContain('collected only 32% across all 2 rent plans (needs 50%)');
    const tina = sheet.querySelector('[data-plan="p1aaaaaa"]') as HTMLElement;
    expect(tina.textContent).toContain('Repaying');
    expect(tina.textContent).toContain('UGX 1,330,000');
    expect(tina.textContent).toContain('UGX 600,000');
    expect(tina.textContent).toContain('25%');
    expect(tina.textContent).toContain('2 Sept 2026');
    expect(sheet.querySelector('[data-open-request="o1cccccc"]')?.textContent).toContain('At COO');
  });

  it('the call button does not open the sheet', async () => {
    setWidth(1280);
    mockRpc();
    wrap(<AgentsDesk board={false} />);
    await screen.findByText('Andy Agent');
    fireEvent.click(screen.getAllByRole('button', { name: 'Call Andy Agent from the company line' })[0]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('375 px: one card per agent', async () => {
    setWidth(375);
    mockRpc();
    wrap(<AgentsDesk board={false} />);
    await screen.findByText('Bena Low');
    expect(document.querySelectorAll('li[data-agent]').length).toBe(2);
    expect(document.querySelector('table')).toBeNull();
  });
});

const coo = (over: Partial<CooRow>): CooRow => ({
  id: 'c1', req: 'c1', tenant: 'Cara', agent: 'Andy Agent', agent_grade: 'B', landlord: 'L', landlord_verified: true, rent: 300000, days_here: 4.4,
  ratings: { agent_ops: 80, tenant_ops: null, landlord_ops: 60, average: 70, grade: 'B', partly_rated: false }, grade: 'A', avg: 80,
  flags: null, auto_forwarded: false, waiting: null, rank: 1, pushable: true, frozen: null, ...over,
});

describe('COO board → agent sheet', () => {
  const mockCoo = () =>
    rpcMock.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'pipeline_coo_board'
          ? { data: { counts: { A: 1, pushable: 1, frozen: 1 }, can_push: true, rows: [coo({}), coo({ id: 'c2', tenant: 'Fred', agent: 'Bena Low', pushable: false, frozen: { reason: 'Agent below 50%', since: null, returns_to_agent_ops_at: '2026-11-12' } })] }, error: null }
          : fn === 'desk_agent_plans'
            ? { data: PLANS, error: null }
            : { data: null, error: null },
      ),
    );

  it('the agent name opens the agent sheet for the request’s agent', async () => {
    setWidth(1280);
    mockCoo();
    wrap(<CooBoard board={false} onOpen={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: "Open Andy Agent's rent plans" }));
    const sheet = await screen.findByRole('dialog', { name: 'Andy Agent' });
    await within(sheet).findByText('Tina Tenant');
    expect(rpcMock).toHaveBeenCalledWith('desk_agent_plans', { p_agent: 'a1' });
  });

  it('the Frozen chip opens the same sheet', async () => {
    setWidth(1280);
    mockCoo();
    fromResult.data = { agent_id: 'a9', assigned_agent_id: 'a2' };
    wrap(<CooBoard board={false} onOpen={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: "Frozen — open Bena Low's rent plans" }));
    await screen.findByRole('dialog', { name: 'Bena Low' });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('desk_agent_plans', { p_agent: 'a2' }));
  });

  it('when the request cannot be read, the agent is found by exact name', async () => {
    setWidth(1280);
    mockCoo();
    rpcMock.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'pipeline_coo_board'
          ? { data: { counts: {}, can_push: true, rows: [coo({})] }, error: null }
          : fn === 'desk_agent_portfolio'
            ? { data: PORTFOLIO, error: null }
            : fn === 'desk_agent_plans'
              ? { data: PLANS, error: null }
              : { data: null, error: null },
      ),
    );
    fromResult.data = null;
    fromResult.error = { message: 'permission denied' };
    wrap(<CooBoard board={false} onOpen={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: "Open Andy Agent's rent plans" }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('desk_agent_plans', { p_agent: 'a1' }));
  });
});
