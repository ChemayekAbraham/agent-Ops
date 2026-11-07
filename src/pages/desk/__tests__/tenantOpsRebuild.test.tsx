import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: vi.fn(), storage: { from: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: [] }) }));
vi.mock('@/hooks/useCrmVoiceCall', () => ({
  useCrmVoiceCall: () => ({ state: 'idle', callId: null, elapsed: 0, error: null, isEnding: false, start: vi.fn(), end: vi.fn() }),
  useHumanCallingPaused: () => ({ data: { paused: false, reason: null, paused_at: null } }),
  isTerminalCallState: () => false,
}));

import { healthChip, type TenantHealth } from '../paymentHealth';
import { ConcernsChip, ConcernsSection, concernBlocked, concernsChip, sortConcerns, type Concern } from '../concerns';
import { primaryLabel, type BoardRow } from '../boardApi';
import { ReadyBoard } from '../ReadyBoard';
import { ReviewStatusProvider } from '../reviewStatus';

const health = (status: TenantHealth['status']): TenantHealth => ({
  status, summary: `${status} summary`, completed_plans: 2, completed_repaid_pct: 90, active_plans: 1, active_collected_pct: 70, owing: 120000,
});

function row(over: Partial<BoardRow>): BoardRow {
  return {
    id: 'req-1', req: 'req-1', tenant: 'Tenant One', tenant_id: 't1', tenant_phone: null, agent_id: 'a1', agent: 'Agent Ann', agent_phone: '+256700000001',
    agent_grade: 'C', agent_grade_week_ago: null, agent_flags: [], landlord: null, landlord_phone: null, rent: 300000, days_here: 2,
    rating: null, flags: { passes: 3, total: 3, hard_fail: false, soft_fail: false, failing: [], notes: [], flags: [] },
    decision: 'pass', rule_id: 'TO-1', why: 'call answered; checks pass', receiver: null, waiting: null, wait_suggest: null,
    push: { decision: 'pass', results: [], reason_code: null, note: 'TO-1 pass', target_agent_id: null }, call: null,
    ...over,
  };
}

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => rpcMock.mockReset());

describe('payment health chip', () => {
  it('Good green, Watch amber, Poor red, New grey, with the summary on hover', () => {
    expect(healthChip(health('good'))).toEqual({ text: 'Payment: Good', tone: 'ok', title: 'good summary' });
    expect(healthChip(health('watch'))?.tone).toBe('warn');
    expect(healthChip(health('poor'))).toMatchObject({ text: 'Payment: Poor', tone: 'bad' });
    expect(healthChip(health('new'))).toMatchObject({ text: 'Payment: New', tone: 'idle' });
    expect(healthChip(undefined)).toBeNull();
  });
});

describe('concerns chip', () => {
  it('hidden when none, red when serious, amber otherwise', () => {
    expect(concernsChip(undefined)).toBeNull();
    expect(concernsChip({ open: 0, serious: 0, latest: null })).toBeNull();
    expect(concernsChip({ open: 2, serious: 1, latest: 'Story changed' })).toEqual({ text: '⚠ 2 concerns', tone: 'bad', title: 'Story changed' });
    expect(concernsChip({ open: 1, serious: 0, latest: null })).toMatchObject({ text: '⚠ 1 concern', tone: 'warn' });
    const { container } = render(<ConcernsChip summary={{ open: 0, serious: 0, latest: null }} />);
    expect(container.textContent).toBe('');
  });

  it('open concerns come first', () => {
    const c = (id: string, resolved: boolean, at: string): Concern => ({
      id, desk: 'tenant_ops', category: 'other', severity: 'note', note: null, raised_by: null, raised_staff_ref: null, raised_at: at,
      resolved_at: resolved ? at : null, resolution: null, resolved_by: null,
    });
    expect(sortConcerns([c('r', true, '2026-11-07'), c('o1', false, '2026-11-01'), c('o2', false, '2026-11-05')]).map((x) => x.id)).toEqual(['o2', 'o1', 'r']);
  });
});

describe('log a concern', () => {
  it('needs a category, a severity and 10+ characters', () => {
    expect(concernBlocked({ category: null, severity: 'note', note: 'long enough note' })).toMatch(/what the concern/);
    expect(concernBlocked({ category: 'other', severity: null, note: 'long enough note' })).toMatch(/how serious/);
    expect(concernBlocked({ category: 'other', severity: 'note', note: 'short' })).toMatch(/10 characters/);
    expect(concernBlocked({ category: 'other', severity: 'note', note: 'long enough note' })).toBeNull();
  });

  it('Save stays off under 10 characters, then calls pipeline_raise_concern with the right args', async () => {
    rpcMock.mockImplementation((fn: string) => Promise.resolve({ data: fn === 'pipeline_concerns_list' ? [] : null, error: null }));
    render(
      <QueryClientProvider client={qc()}>
        <ConcernsSection requestId="req-9" desk="tenant_ops" />
      </QueryClientProvider>,
    );
    await screen.findByText('No concerns logged on this request.');
    const save = screen.getByRole('button', { name: 'Log the concern' }) as HTMLButtonElement;
    fireEvent.click(screen.getByRole('button', { name: 'Inconsistent story' }));
    fireEvent.click(screen.getByRole('button', { name: 'Serious' }));
    fireEvent.change(screen.getByLabelText('What you saw'), { target: { value: 'too short' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('What you saw'), { target: { value: 'Tenant gave two different employers on the call.' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith('pipeline_raise_concern', {
        p_request_id: 'req-9',
        p_desk: 'tenant_ops',
        p_category: 'inconsistent_story',
        p_severity: 'serious',
        p_note: 'Tenant gave two different employers on the call.',
      }),
    );
  });
});

describe('Tenant Ops board', () => {
  it('the pass button reads "Forward to Landlord Ops"', () => {
    expect(primaryLabel(row({}), 'tenant_ops')).toBe('Forward to Landlord Ops');
    expect(primaryLabel(row({}), 'landlord_ops')).toBe('Forward to COO');
  });

  it('shows health and concerns chips from one batch call each, and no transfer, eligibility or freeze UI', async () => {
    const rows = [
      row({ eligibility: { eligible: false, pct: 20, new: false, open: 0 } }),
      row({ id: 'req-2', req: 'req-2', tenant: 'Tenant Two', tenant_id: 't2', decision: 'call', push: null }),
    ];
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'pipeline_desk_board')
        return Promise.resolve({ data: { stage: 'tenant_ops', can_act: true, staff_ref: 'EMP-1', sc_only: false, counts: { pass: 1, call: 1 }, rows }, error: null });
      if (fn === 'tenant_payment_health_many') return Promise.resolve({ data: { t1: health('poor'), t2: health('good') }, error: null });
      if (fn === 'pipeline_concerns_summary') return Promise.resolve({ data: { 'req-1': { open: 1, serious: 1, latest: 'ID photo mismatch' } }, error: null });
      return Promise.resolve({ data: null, error: null });
    });
    render(
      <QueryClientProvider client={qc()}>
        <ReviewStatusProvider>
          <ReadyBoard stage="tenant_ops" board={false} onOpen={() => {}} />
        </ReviewStatusProvider>
      </QueryClientProvider>,
    );
    await screen.findByText('Payment: Poor');
    expect(screen.getByText('Payment: Good')).toBeTruthy();
    const concern = await screen.findByText('⚠ 1 concern');
    expect(concern.getAttribute('data-tone')).toBe('bad');
    expect(concern.getAttribute('title')).toBe('ID photo mismatch');
    expect(screen.getByRole('button', { name: 'Forward to Landlord Ops' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Call tenant' })).toBeTruthy();
    // The agent and their call button are on each row.
    expect(screen.getAllByText('Agent Ann').length).toBe(2);
    expect(screen.getAllByRole('button', { name: /Call Agent Ann from the company line/ }).length).toBe(2);

    // One batch call each, with every id on the board.
    const calls = (fn: string) => rpcMock.mock.calls.filter((c) => c[0] === fn);
    expect(calls('tenant_payment_health_many')).toHaveLength(1);
    expect(calls('tenant_payment_health_many')[0][1]).toEqual({ p_tenant_ids: ['t1', 't2'] });
    expect(calls('pipeline_concerns_summary')[0][1]).toEqual({ p_request_ids: ['req-1', 'req-2'] });

    // No eligibility, transfer or freeze UI.
    expect(screen.queryByText(/collected ✓|below 50%|New agent/)).toBeNull();
    expect(screen.queryByText(/Frozen/)).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: /More for Tenant One/ })[0]);
    expect(screen.queryByText(/Pick another/)).toBeNull();
    expect(screen.queryByText(/Transfer/)).toBeNull();
  });
});
