import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
const fromChain = {
  select: () => fromChain,
  eq: () => fromChain,
  in: () => fromChain,
  maybeSingle: () => Promise.resolve({ data: null, error: null }),
  order: () => Promise.resolve({ data: [], error: null }),
};
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: () => fromChain, storage: { from: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: ['coo'] }) }));
vi.mock('@/hooks/useCrmVoiceCall', () => ({
  useCrmVoiceCall: () => ({ state: 'idle', callId: null, elapsed: 0, error: null, isEnding: false, start: vi.fn(), end: vi.fn() }),
  useHumanCallingPaused: () => ({ data: { paused: false, reason: null, paused_at: null } }),
  isTerminalCallState: () => false,
}));

import { CooBoard, cooChips, type CooRow } from '../CooBoard';
import { agentGradeText, agentPctText, frozenFacts, holdFacts, notRatedDesks, ratingRows } from '../cooBadges';

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
afterEach(() => setWidth(1024));
beforeEach(() => rpcMock.mockReset());

const wrap = (ui: ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

const RATINGS = { agent_ops: 76, agent_ops_checks: 80, agent_points: 72, tenant_ops: null, landlord_ops: 64, average: 70, grade: 'B', rated_desks: 2, partly_rated: true };
const coo = (over: Partial<CooRow>): CooRow => ({
  id: 'c1', req: 'c1', tenant: 'Cara Tenant', agent: 'Andy Agent', agent_grade: 'X', agent_pct: 62.4,
  agent_red_flags: [{ code: 'landlord_phone_is_agent', label: "Landlord phone is the agent's phone", detail: "On 3 of the agent's 9 requests in the last 90 days, the landlord's number is the agent's own number." }],
  kind: { code: 'renewal', label: 'Renewal', color: '#0EA5E9', detail: 'Plan 2 · repaid 100% before', needs_agent: false },
  landlord: 'L', landlord_verified: true, rent: 300000, days_here: 4.4,
  ratings: RATINGS, grade: 'B', avg: 70,
  flags: { passes: 3, total: 5, failing: ['Tenant ID on file', 'No other open request'] },
  auto_forwarded: false, waiting: null, rank: 1, pushable: true, frozen: null, ...over,
});
const mockBoard = (rows: CooRow[]) =>
  rpcMock.mockImplementation((fn: string) =>
    Promise.resolve(fn === 'pipeline_coo_board' ? { data: { counts: { B: 1, pushable: 1, frozen: 0 }, can_push: true, rows }, error: null } : { data: null, error: null }),
  );

describe('E74: the words behind each COO badge', () => {
  it('grade X is a red flag, not a block', () => {
    expect(agentGradeText('X')).toBe('Red flag');
    expect(agentGradeText('b')).toBe('B');
    expect(agentGradeText(null)).toBe('Not graded');
    expect(agentPctText(62.4)).toBe('Collected 62% of what was due');
    expect(agentPctText(null)).toBeNull();
  });
  it("each desk's rating, and who has not rated yet", () => {
    expect(ratingRows(RATINGS).map((r) => r.value)).toEqual([76, null, 64]);
    expect(notRatedDesks(RATINGS)).toEqual(['Tenant Ops']);
    expect(notRatedDesks(null)).toEqual(['Agent Ops', 'Tenant Ops', 'Landlord Ops']);
  });
  it('frozen and held rows: reason, since, and when they come back', () => {
    expect(frozenFacts({ reason: 'Agent below 50%', since: '2026-11-05T09:00:00Z', returns_to_agent_ops_at: '2026-11-12T09:00:00Z' })).toEqual({
      reason: 'Agent below 50%', since: '5 Nov 2026', returns: '12 Nov 2026',
    });
    const h = holdFacts({ reason_code: 'OTHER', owner_kind: 'finops', until_at: '2026-11-12T09:00:00Z', expired: false, note: 'FinOps check first', rule_id: null }, Date.parse('2026-11-11T09:00:00Z'));
    expect(h).toMatchObject({ reason: 'FinOps check first', until: '12 Nov 2026', up: false });
  });
  it('failing checks get their own chip', () => {
    expect(cooChips(coo({})).map((c) => c.text)).toContain('2 failing checks');
    expect(cooChips(coo({ flags: { passes: 5, total: 5, failing: [] } })).map((c) => c.key)).not.toContain('failing');
  });
});

describe('E74: every COO badge opens its explanation', () => {
  it('desktop: popovers for the agent grade, kind, grade circle, ratings, partly rated and failing checks', async () => {
    setWidth(1280);
    mockBoard([coo({})]);
    wrap(<CooBoard board={false} onOpen={() => {}} />);

    // Agent grade X reads "Red flag" and lists the flags, the grade and the collections.
    const agentBtn = await screen.findByRole('button', { name: 'Agent grade Red flag: what it means' });
    expect(agentBtn.textContent).toBe('Red flag');
    expect(screen.queryByText('Blocked')).toBeNull();
    fireEvent.click(agentBtn);
    let panel = screen.getByRole('dialog', { name: 'Agent grade Red flag: what it means' });
    expect(within(panel).getByText("Landlord phone is the agent's phone")).toBeTruthy();
    expect(within(panel).getByText(/On 3 of the agent's 9 requests/)).toBeTruthy();
    expect(within(panel).getByText('Collected 62% of what was due')).toBeTruthy();
    expect(panel.textContent).toContain('does not block the push');

    fireEvent.click(screen.getByRole('button', { name: 'Renewal: what it means' }));
    panel = screen.getByRole('dialog', { name: 'Renewal: what it means' });
    expect(within(panel).getByText('Plan 2 · repaid 100% before')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Request grade B: what it means' }));
    panel = screen.getByRole('dialog', { name: 'Request grade B: what it means' });
    expect(panel.textContent).toMatch(/Average rating\s*70/);
    expect(panel.textContent).toContain('Agent Ops76');
    expect(panel.textContent).toContain('Tenant Opsnot rated yet');
    expect(panel.textContent).toContain('Landlord Ops64');

    fireEvent.click(screen.getByRole('button', { name: 'Desk ratings: what they mean' }));
    panel = screen.getByRole('dialog', { name: 'Desk ratings: what they mean' });
    expect(within(panel).getByText('Not rated yet: Tenant Ops')).toBeTruthy();
    expect(panel.textContent).toContain('half its checks (80)');

    fireEvent.click(screen.getByRole('button', { name: 'partly rated: what it means' }));
    expect(within(screen.getByRole('dialog', { name: 'partly rated: what it means' })).getByText('Not rated yet: Tenant Ops')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '2 failing checks: what it means' }));
    panel = screen.getByRole('dialog', { name: '2 failing checks: what it means' });
    expect([...panel.querySelectorAll('[data-failing] li')].map((li) => li.textContent)).toEqual(['✗ Tenant ID on file', '✗ No other open request']);
    expect(panel.textContent).toMatch(/Checks passed\s*3 of 5/);
  });

  it('frozen and held rows explain the reason, since when, and the return date', async () => {
    setWidth(1280);
    mockBoard([
      coo({ id: 'c2', tenant: 'Fred', agent_grade: 'B', pushable: false, frozen: { reason: 'Agent below 50%', since: '2026-11-05T09:00:00Z', returns_to_agent_ops_at: '2026-11-12T09:00:00Z' } }),
      coo({ id: 'c3', tenant: 'Hana', agent_grade: 'A', pushable: false, waiting: { reason_code: 'OTHER', owner_kind: 'finops', until_at: '2099-01-01T09:00:00Z', expired: false, note: 'FinOps check first', rule_id: null } }),
    ]);
    wrap(<CooBoard board={false} onOpen={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Frozen: what it means' }));
    let panel = screen.getByRole('dialog', { name: 'Frozen: what it means' });
    expect(within(panel).getByText('Agent below 50%')).toBeTruthy();
    expect(panel.textContent).toMatch(/Frozen since\s*5 Nov 2026/);
    expect(panel.textContent).toMatch(/Back to Agent Ops on\s*12 Nov 2026/);
    expect(within(panel).getByRole('button', { name: "Open the agent's rent plans" })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'On hold: what it means' }));
    panel = screen.getByRole('dialog', { name: 'On hold: what it means' });
    expect(within(panel).getByText('FinOps check first')).toBeTruthy();
    expect(panel.textContent).toMatch(/Until\s*1 Jan 2099/);
  });

  it('phone: the same explanation opens as a bottom sheet; every badge is a 44 px target', async () => {
    setWidth(375);
    mockBoard([coo({})]);
    wrap(<CooBoard board={false} onOpen={() => {}} />);
    const btn = await screen.findByRole('button', { name: 'Agent grade Red flag: what it means' });
    expect(btn.style.minHeight).toBe('44px');
    expect(btn.style.minWidth).toBe('44px');
    fireEvent.click(btn);
    const sheet = screen.getByRole('dialog', { name: 'Agent grade Red flag: what it means' });
    expect(sheet.className).toContain('desk-sheet-wrap');
    expect(within(sheet).getByText("Landlord phone is the agent's phone")).toBeTruthy();
  });
});
