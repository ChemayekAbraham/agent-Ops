import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/** E120: Service Centre bulk Discard / Send back (sc_bulk_decide). The single-card buttons stay as they were. */

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
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ReadyBoard } from '../ReadyBoard';
import { ReviewStatusProvider } from '../reviewStatus';
import { filterRows, NO_FILTER } from '../scBulk';
import type { BoardRow } from '../boardApi';

function row(id: string, over: Partial<BoardRow> = {}): BoardRow {
  return {
    id, req: id.slice(0, 8), tenant: `Tenant ${id}`, tenant_id: null, tenant_phone: null, agent_id: 'a1', agent: 'Andy', agent_phone: '0700111222',
    agent_grade: null, agent_grade_week_ago: null, agent_flags: [], landlord: null, landlord_phone: null, rent: 400000, days_here: 3,
    rating: null, flags: { passes: 4, total: 4, hard_fail: false, soft_fail: false, failing: [], notes: [], flags: [] },
    decision: 'pass', rule_id: 'SC-1', why: 'items complete', receiver: null, waiting: null, wait_suggest: null,
    push: { decision: 'pass', results: [], reason_code: null, note: 'SC-1', target_agent_id: null }, call: null,
    ...over,
  };
}
const ROWS = [
  row('r-old-1', { days_here: 45, agent_id: 'a2', agent: 'Bea' }),
  row('r-old-2', { days_here: 12 }),
  row('r-new-3', { days_here: 2, tenant: 'Zara Q' }),
];

// This test environment has no window.localStorage; give it a plain in-memory one.
const store = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k), clear: () => store.clear(), key: () => null, length: 0 },
});

const board = { stage: 'service_centre', can_act: true, staff_ref: 'EMP-1', sc_only: false, counts: { pass: 3 }, scope: 'new', scope_counts: { new: 3, batch: 0 }, rows: ROWS };
const answer = (bulk: unknown) =>
  rpcMock.mockImplementation((fn: string) =>
    Promise.resolve(fn === 'pipeline_desk_board' ? { data: board, error: null } : fn === 'sc_bulk_decide' ? bulk : { data: null, error: null }),
  );
const bulkCalls = () => rpcMock.mock.calls.filter((c) => c[0] === 'sc_bulk_decide');

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ReviewStatusProvider>
        <ReadyBoard stage="service_centre" board={false} onOpen={vi.fn()} />
      </ReviewStatusProvider>
    </QueryClientProvider>,
  );
}
async function selectMode() {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Select' }));
}

beforeEach(() => {
  store.clear();
  rpcMock.mockReset();
});

describe('the filters', () => {
  it('older than, agent and search narrow the cards', () => {
    expect(filterRows(ROWS, { ...NO_FILTER, older: 7 }).map((r) => r.id)).toEqual(['r-old-1', 'r-old-2']);
    expect(filterRows(ROWS, { ...NO_FILTER, older: 30 }).map((r) => r.id)).toEqual(['r-old-1']);
    expect(filterRows(ROWS, { ...NO_FILTER, agent: 'a2' }).map((r) => r.id)).toEqual(['r-old-1']);
    expect(filterRows(ROWS, { ...NO_FILTER, search: 'zara' }).map((r) => r.id)).toEqual(['r-new-3']);
  });
});

describe('Service Centre Select mode', () => {
  it('tick boxes, select all matching a filter, then Discard calls sc_bulk_decide with the ids, reason and note', async () => {
    answer({ data: { ok: true, done: 2, failed: [], selected: 2 }, error: null });
    await selectMode();
    expect(document.querySelectorAll('[data-select]')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Older than 7 days' }));
    await waitFor(() => expect(document.querySelectorAll('[data-select]')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: /Select all matching \(2\)/ }));
    expect(document.querySelector('[data-selected-count]')?.textContent).toBe('2 selected');

    fireEvent.click(within(document.querySelector('[data-bulk-bar]') as HTMLElement).getByRole('button', { name: 'Discard (fake)' }));
    const dlg = await screen.findByRole('dialog', { name: 'Discard (fake) · 2 requests' });
    expect(dlg.querySelector('[data-discard-warning]')?.textContent).toBe('These 2 requests will be rejected for good and will NOT go back to the agent.');
    fireEvent.click(dlg.querySelector('[data-reason="FAKE_REQUEST"]')!);
    fireEvent.change(dlg.querySelector('[data-bulk-note]')!, { target: { value: 'Same phone, made-up landlords' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Discard (fake) · 2' }));
    await waitFor(() => expect(bulkCalls()).toHaveLength(1));
    expect(bulkCalls()[0][1]).toEqual({ p_request_ids: ['r-old-1', 'r-old-2'], p_decision: 'reject', p_reason_code: 'FAKE_REQUEST', p_note: 'Same phone, made-up landlords' });
    expect((await screen.findByText('Done: 2 · Skipped: 0')).getAttribute('data-bulk-summary')).not.toBeNull();
  });

  it('the note needs 10 characters and a reason must be chosen before anything is sent', async () => {
    answer({ data: { ok: true, done: 1, failed: [], selected: 1 }, error: null });
    await selectMode();
    fireEvent.click(document.querySelector('[data-select="r-new-3"]')!);
    fireEvent.click(screen.getByRole('button', { name: 'Discard (fake)' }));
    const dlg = await screen.findByRole('dialog', { name: 'Discard (fake) · 1 request' });
    const confirm = within(dlg).getByRole('button', { name: 'Discard (fake) · 1' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(dlg.querySelector('[data-reason="DUPLICATE_REQUEST"]')!);
    fireEvent.change(dlg.querySelector('[data-bulk-note]')!, { target: { value: 'too short' } });
    expect(confirm.disabled).toBe(true);
    expect(dlg.textContent).toContain('9 / 10');
    fireEvent.change(dlg.querySelector('[data-bulk-note]')!, { target: { value: 'Duplicate of an earlier request' } });
    expect(confirm.disabled).toBe(false);
    expect(bulkCalls()).toHaveLength(0);
  });

  it('partial failures are listed with the server’s reason, and the skipped stay ticked', async () => {
    answer({ data: { ok: true, done: 2, failed: [{ id: 'r-old-2', error: 'Only requests at the Service Centre can be reviewed here' }], selected: 3 }, error: null });
    await selectMode();
    fireEvent.click(screen.getByRole('button', { name: /Select all on this page \(3\)/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard (fake)' }));
    const dlg = await screen.findByRole('dialog', { name: 'Discard (fake) · 3 requests' });
    fireEvent.click(dlg.querySelector('[data-reason="STALE_REQUEST"]')!);
    fireEvent.change(dlg.querySelector('[data-bulk-note]')!, { target: { value: 'Older than a month, never followed up' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Discard (fake) · 3' }));
    const result = await screen.findByRole('dialog', { name: 'Discard (fake)' });
    expect(result.querySelector('[data-bulk-summary]')?.textContent).toBe('Done: 2 · Skipped: 1');
    expect(result.querySelector('[data-skipped="r-old-2"]')?.textContent).toBe('Tenant r-old-2Only requests at the Service Centre can be reviewed here');
    // The sheet's own close and the result's Close button both close it.
    fireEvent.click(within(result).getAllByRole('button', { name: 'Close' }).at(-1)!);
    await waitFor(() => expect(document.querySelector('[data-selected-count]')?.textContent).toBe('1 selected'));
  });

  it('send back to the agent: no discard warning, decision send_back', async () => {
    answer({ data: { ok: true, done: 1, failed: [], selected: 1 }, error: null });
    await selectMode();
    fireEvent.click(document.querySelector('[data-select="r-old-1"]')!);
    fireEvent.click(screen.getByRole('button', { name: 'Send back to agent' }));
    const dlg = await screen.findByRole('dialog', { name: 'Send back to agent · 1 request' });
    expect(dlg.querySelector('[data-discard-warning]')).toBeNull();
    fireEvent.click(dlg.querySelector('[data-reason="OTHER"]')!);
    fireEvent.change(dlg.querySelector('[data-bulk-note]')!, { target: { value: 'Photos unreadable, please retake' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Send back to agent · 1' }));
    await waitFor(() => expect(bulkCalls()).toHaveLength(1));
    expect(bulkCalls()[0][1]).toEqual({ p_request_ids: ['r-old-1'], p_decision: 'send_back', p_reason_code: 'OTHER', p_note: 'Photos unreadable, please retake' });
    expect(await screen.findByText('Done: 1 · Skipped: 0')).toBeTruthy();
  });

  it('a refusal for the whole batch shows the server’s words; outside Select mode the cards have no tick boxes', async () => {
    answer({ data: null, error: { message: 'BULK_LIMIT: at most 500 requests at a time' } });
    mount();
    await screen.findByRole('button', { name: 'Select' });
    expect(document.querySelector('[data-select]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    fireEvent.click(document.querySelector('[data-select="r-old-1"]')!);
    fireEvent.click(screen.getByRole('button', { name: 'Send back to agent' }));
    const dlg = await screen.findByRole('dialog', { name: 'Send back to agent · 1 request' });
    fireEvent.click(dlg.querySelector('[data-reason="OTHER"]')!);
    fireEvent.change(dlg.querySelector('[data-bulk-note]')!, { target: { value: 'Anything long enough' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Send back to agent · 1' }));
    expect((await within(dlg).findByRole('alert')).textContent).toBe('BULK_LIMIT: at most 500 requests at a time');
  });
});
