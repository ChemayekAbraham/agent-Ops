import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import { ReadyBoard, limitNote } from '../ReadyBoard';
import { ReviewStatusProvider } from '../reviewStatus';
import { boardArgs, scopeLabels, scopeTotal, type BoardRow } from '../boardApi';

function row(id: string, batch: boolean): BoardRow {
  return {
    id, req: id.slice(0, 8), tenant: `Tenant ${id}`, tenant_id: null, tenant_phone: null, agent_id: null, agent: 'Agent', agent_phone: null,
    agent_grade: null, agent_grade_week_ago: null, agent_flags: [], landlord: null, landlord_phone: null, rent: 400000, days_here: 80,
    rating: null, flags: { passes: 4, total: 4, hard_fail: false, soft_fail: false, failing: [], notes: [], flags: [] },
    decision: 'pass', rule_id: 'SC-1', why: batch ? 'Aug batch · items complete' : 'items complete', receiver: null,
    waiting: null, wait_suggest: null,
    push: { decision: 'pass', results: [], reason_code: null, note: 'SC-1', target_agent_id: null },
    call: null, batch,
  };
}

const board = (scope: string) => ({
  data: { stage: 'service_centre', can_act: true, staff_ref: 'EMP-1', sc_only: false, counts: { pass: 2 }, scope, scope_counts: { new: 213, batch: 3580 }, rows: [row('batch-row-1', true), row('new-row-1', false)] },
  error: null,
});

// This test environment has no window.localStorage; give it a plain in-memory one.
const store = new Map<string, string>();
const memoryStorage = {
  getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() {
    return store.size;
  },
};
Object.defineProperty(window, 'localStorage', { value: memoryStorage, configurable: true });

beforeEach(() => {
  window.localStorage.clear();
  rpcMock.mockReset();
  rpcMock.mockImplementation((fn: string, args: { p_scope?: string }) =>
    Promise.resolve(fn === 'pipeline_desk_board' ? board(args?.p_scope ?? 'new') : { data: null, error: null }),
  );
});
afterEach(() => window.localStorage.clear());

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReviewStatusProvider>
        <ReadyBoard stage="service_centre" board={false} onOpen={() => {}} />
      </ReviewStatusProvider>
    </QueryClientProvider>,
  );
}

const boardCalls = () => rpcMock.mock.calls.filter((c) => c[0] === 'pipeline_desk_board').map((c) => c[1]);

describe('Service Centre scope switch', () => {
  it('starts on New, sends p_scope with a 300 limit, and labels come from scope_counts', async () => {
    mount();
    await waitFor(() => expect(screen.getByRole('radio', { name: 'New (213)' })).toBeTruthy());
    expect(screen.getByRole('radio', { name: 'August batch (3,580)' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'All' })).toBeTruthy();
    expect(boardCalls()[0]).toEqual({ p_stage: 'service_centre', p_limit: 300, p_scope: 'new' });
  });

  it('switching sends the chosen p_scope and remembers it per user', async () => {
    mount();
    await waitFor(() => screen.getByRole('radio', { name: 'August batch (3,580)' }));
    fireEvent.click(screen.getByRole('radio', { name: 'August batch (3,580)' }));
    await waitFor(() => expect(boardCalls().some((a) => a.p_scope === 'batch')).toBe(true));
    expect(window.localStorage.getItem('desk:sc-scope:u1')).toBe('batch');
    fireEvent.click(screen.getByRole('radio', { name: 'All' }));
    await waitFor(() => expect(boardCalls().some((a) => a.p_scope === 'all')).toBe(true));
  });

  it('opens on the remembered scope', async () => {
    window.localStorage.setItem('desk:sc-scope:u1', 'batch');
    mount();
    await waitFor(() => expect(boardCalls().length).toBeGreaterThan(0));
    expect(boardCalls()[0].p_scope).toBe('batch');
  });

  it('batch rows carry the grey "Aug batch" chip; new rows do not', async () => {
    mount();
    await waitFor(() => screen.getByText('Tenant batch-row-1'));
    expect(screen.getAllByText('Aug batch')).toHaveLength(1);
    const chip = screen.getByText('Aug batch');
    expect(chip.previousElementSibling?.textContent).toBe('Tenant batch-row-1');
  });
});

describe('scope helpers', () => {
  it('other stages never send p_scope and keep the 150 limit', () => {
    expect(boardArgs('agent_ops', 'batch')).toEqual({ p_stage: 'agent_ops', p_limit: 150 });
    expect(boardArgs('service_centre')).toEqual({ p_stage: 'service_centre', p_limit: 300, p_scope: 'new' });
  });

  it('labels and totals', () => {
    expect(scopeLabels({ new: 213, batch: 3580 })).toEqual({ new: 'New (213)', batch: 'August batch (3,580)', all: 'All' });
    expect(scopeTotal('all', { new: 213, batch: 3580 })).toBe(3793);
    expect(scopeTotal('batch', null)).toBeNull();
  });

  it('the "Showing 300 of …" line', () => {
    expect(limitNote('service_centre', 'batch', 300, { new: 213, batch: 3580 })).toBe(
      'Showing 300 of 3,580 — oldest first; push or wait some to see more',
    );
    expect(limitNote('service_centre', 'new', 213, { new: 213, batch: 3580 })).toBeNull();
    expect(limitNote('service_centre', 'new', 300, { new: 300, batch: 3580 })).toBeNull();
  });
});
