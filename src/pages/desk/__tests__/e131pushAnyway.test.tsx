import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/** E131: the COO's "Push anyway" for rows held only for missing items, and the amber override line. */

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
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CooBoard, type CooRow } from '../CooBoard';
import { isHeldForMissing } from '../pushAnyway';
import { CooOverrideLine } from '@/components/coo/CooOverrideLine';
import { FundersIncompleteChip } from '@/components/funder-new/FundersIncompleteChip';

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
afterEach(() => setWidth(1024));
beforeEach(() => rpcMock.mockReset());

const wrap = (ui: ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

const FROZEN = { reason: 'Agent below 50% collected', since: '2026-11-02T08:00:00Z', returns_to_agent_ops_at: '2026-11-12T08:00:00Z' };
const coo = (over: Partial<CooRow>): CooRow => ({
  id: 'p1', req: 'p1', tenant: 'Pia', agent: 'Andy', agent_grade: 'B', agent_pct: 76, landlord: 'L', landlord_verified: true, rent: 300000, days_here: 4,
  ratings: { agent_ops: 80, tenant_ops: 70, landlord_ops: 60, average: 70, grade: 'B', partly_rated: false }, grade: 'A', avg: 80,
  flags: null, auto_forwarded: false, waiting: null, rank: 1, pushable: true, frozen: null, ...over,
});
const ROWS = [
  coo({}),
  coo({ id: 'h1', req: 'h1', tenant: 'Hana', rank: 2, pushable: false, incomplete: ['ID back'] }),
  coo({ id: 'h2', req: 'h2', tenant: 'Hugo', rank: 3, pushable: false, incomplete: ['ID back', 'LC1 letter'], rent: 200000 }),
  coo({ id: 'f1', req: 'f1', tenant: 'Fred', rank: 4, pushable: false, frozen: FROZEN, incomplete: ['ID back'] }),
  coo({ id: 'c1', req: 'c1', tenant: 'Cleo', rank: 5, pushable: false, concern_block: true, incomplete: ['ID back'] }),
];

type Rpc = (fn: string, args?: Record<string, unknown>) => { data: unknown; error: unknown } | undefined;
const mockRpcs = (extra: Rpc = () => undefined, canPush = true) =>
  rpcMock.mockImplementation((fn: string, args?: Record<string, unknown>) => {
    const hit = extra(fn, args);
    if (hit) return Promise.resolve(hit);
    if (fn === 'pipeline_coo_board') return Promise.resolve({ data: { counts: { A: 5, pushable: 1, frozen: 1 }, can_push: canPush, rows: ROWS }, error: null });
    return Promise.resolve({ data: null, error: null });
  });
const overrideCalls = () => rpcMock.mock.calls.filter((c) => c[0] === 'coo_push_override');
const rowEl = (id: string) => document.querySelector(`[data-row="${id}"]`) as HTMLElement;
const REASON = 'Landlord confirmed the tenant by phone';

describe('Push anyway on the COO desk', () => {
  it('a row held only for missing items shows Push anyway; frozen, blocked and pushable rows do not', async () => {
    setWidth(1280);
    mockRpcs();
    wrap(<CooBoard board={false} onOpen={() => {}} />);
    await screen.findByText('Hana');
    expect(within(rowEl('h1')).getByRole('button', { name: 'Push anyway' })).toBeTruthy();
    // Frozen: unchanged — the Frozen badge with the reason, no push buttons at all.
    const f = rowEl('f1');
    expect(f.querySelector('[data-frozen-chip]')?.textContent).toBe('Frozen');
    expect(f.textContent).toContain('Agent below 50% collected');
    expect(within(f).queryByRole('button', { name: 'Push anyway' })).toBeNull();
    expect(within(f).queryByRole('button', { name: 'Push to funders' })).toBeNull();
    // A serious concern still blocks; a pushable row keeps its normal push.
    expect(within(rowEl('c1')).queryByRole('button', { name: 'Push anyway' })).toBeNull();
    expect(within(rowEl('p1')).queryByRole('button', { name: 'Push anyway' })).toBeNull();
    expect(within(rowEl('p1')).getByRole('button', { name: 'Push to funders' })).toBeTruthy();
  });

  it('COO only: without the push right there is no Push anyway', async () => {
    setWidth(1280);
    mockRpcs(undefined, false);
    wrap(<CooBoard board={false} onOpen={() => {}} />);
    await screen.findByText('Hana');
    expect(screen.queryByRole('button', { name: 'Push anyway' })).toBeNull();
  });

  it('the dialog lists the missing items and the reason is required (at least 10 characters)', async () => {
    setWidth(1280);
    mockRpcs((fn) =>
      fn === 'coo_push_override' ? { data: { approved: [{ id: 'h1', rent_amount: 300000 }], approved_total: 300000, skipped: [] }, error: null } : undefined,
    );
    wrap(<CooBoard board={false} onOpen={() => {}} />);
    await screen.findByText('Hana');
    fireEvent.click(within(rowEl('h1')).getByRole('button', { name: 'Push anyway' }));
    const sheet = await screen.findByRole('dialog', { name: 'Push anyway' });
    expect(sheet.querySelector('[data-push-anyway-row="h1"] [data-push-anyway-missing]')?.textContent).toBe('Missing: ID back');
    const go = within(sheet).getByRole('button', { name: 'Push anyway' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(sheet.querySelector('[data-push-anyway-hint]')?.textContent).toBe('A reason is required.');
    const box = within(sheet).getByLabelText('Reason for pushing with items missing');
    fireEvent.change(box, { target: { value: '  too short ' } });
    expect(sheet.querySelector('[data-push-anyway-hint]')?.textContent).toBe('1 more character needed.');
    expect(go.disabled).toBe(true);
    fireEvent.click(go);
    expect(overrideCalls()).toHaveLength(0);
    fireEvent.change(box, { target: { value: ` ${REASON} ` } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(overrideCalls()).toHaveLength(1));
    expect(overrideCalls()[0][1]).toEqual({ p_ids: ['h1'], p_reason: REASON });
    expect((await within(sheet).findByRole('status')).textContent).toContain("Pushed 1 (UGX 300,000) to the funders' board.");
  });

  it("a skipped frozen row shows the server's message", async () => {
    setWidth(1280);
    const msg = 'Agent is frozen: below 50% collected over 30 days. The freeze stays.';
    mockRpcs((fn) => (fn === 'coo_push_override' ? { data: { approved: [], skipped: [{ id: 'h1', reason: 'frozen', message: msg }] }, error: null } : undefined));
    wrap(<CooBoard board={false} onOpen={() => {}} />);
    await screen.findByText('Hana');
    fireEvent.click(within(rowEl('h1')).getByRole('button', { name: 'Push anyway' }));
    const sheet = await screen.findByRole('dialog', { name: 'Push anyway' });
    fireEvent.change(within(sheet).getByLabelText('Reason for pushing with items missing'), { target: { value: REASON } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Push anyway' }));
    await waitFor(() => expect(sheet.querySelector('[data-push-anyway-skipped="h1"]')).toBeTruthy());
    expect(sheet.querySelector('[data-push-anyway-skipped="h1"]')?.textContent).toBe(`Hana: ${msg}`);
  });

  it("a refusal shows the server's words in plain language", async () => {
    setWidth(1280);
    mockRpcs((fn) => (fn === 'coo_push_override' ? { data: null, error: { message: 'COO_ONLY: only the COO can push anyway', code: '42501' } } : undefined));
    wrap(<CooBoard board={false} onOpen={() => {}} />);
    await screen.findByText('Hana');
    fireEvent.click(within(rowEl('h1')).getByRole('button', { name: 'Push anyway' }));
    const sheet = await screen.findByRole('dialog', { name: 'Push anyway' });
    fireEvent.change(within(sheet).getByLabelText('Reason for pushing with items missing'), { target: { value: REASON } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Push anyway' }));
    expect(await within(sheet).findByText('Only the COO can push anyway.')).toBeTruthy();
  });

  it('Select mode: "Push selected anyway" takes only the ticked held rows, with one reason; frozen rows never go', async () => {
    setWidth(1280);
    mockRpcs((fn) =>
      fn === 'coo_push_override'
        ? { data: { approved: [{ id: 'h1', rent_amount: 300000 }, { id: 'h2', rent_amount: 200000 }], approved_total: 500000, skipped: [] }, error: null }
        : undefined,
    );
    wrap(<CooBoard board={false} onOpen={() => {}} />);
    await screen.findByText('Hana');
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    // Only frozen ticked: there is nothing to push anyway.
    fireEvent.click(document.querySelector('[data-coo-select="f1"]') as HTMLElement);
    expect(document.querySelector('[data-coo-push-selected-anyway]')).toBeNull();
    fireEvent.click(document.querySelector('[data-coo-select="h1"]') as HTMLElement);
    fireEvent.click(document.querySelector('[data-coo-select="h2"]') as HTMLElement);
    const bulk = document.querySelector('[data-coo-push-selected-anyway]') as HTMLElement;
    expect(bulk.textContent).toBe('Push selected anyway (2)');
    fireEvent.click(bulk);
    const sheet = await screen.findByRole('dialog', { name: 'Push 2 anyway' });
    expect(sheet.querySelector('[data-push-anyway-row="f1"]')).toBeNull();
    expect(sheet.querySelector('[data-push-anyway-row="h2"] [data-push-anyway-missing]')?.textContent).toBe('Missing: ID back, LC1 letter');
    fireEvent.change(within(sheet).getByLabelText('Reason for pushing with items missing'), { target: { value: REASON } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Push 2 anyway' }));
    await waitFor(() => expect(overrideCalls()).toHaveLength(1));
    expect(overrideCalls()[0][1]).toEqual({ p_ids: ['h1', 'h2'], p_reason: REASON });
    // Pushed ones leave the selection; the frozen tick stays.
    expect(document.querySelector('[data-coo-selected-count]')?.textContent).toBe('1 selected');
  });

  it('the held rule: missing items and nothing else keeping it back', () => {
    expect(isHeldForMissing(coo({ incomplete: ['ID back'], pushable: false }))).toBe(true);
    expect(isHeldForMissing(coo({ incomplete: [] }))).toBe(false);
    expect(isHeldForMissing(coo({ incomplete: ['ID back'], frozen: FROZEN }))).toBe(false);
    expect(isHeldForMissing(coo({ incomplete: ['ID back'], phone_block: true }))).toBe(false);
    expect(isHeldForMissing(coo({ incomplete: ['ID back'], demoted_awaiting: true }))).toBe(false);
    const hold = { reason_code: 'NEED_DOCS', owner_kind: 'agent', until_at: '2026-12-01T00:00:00Z', expired: false, note: null, rule_id: null } as CooRow['waiting'];
    expect(isHeldForMissing(coo({ incomplete: ['ID back'], waiting: hold }))).toBe(false);
    expect(isHeldForMissing(coo({ incomplete: ['ID back'], waiting: { ...hold!, expired: true } }))).toBe(true);
  });
});

describe('the override line', () => {
  const OVERRIDE = { missing: ['ID back'], reason: 'Landlord confirmed by phone', by: 'WEL-0012', at: '2026-11-16T09:30:00Z' };

  it('renders "COO pushed with items missing: ID back — <reason>" on the desk review', async () => {
    rpcMock.mockImplementation((fn: string) => Promise.resolve(fn === 'coo_item_override_for' ? { data: OVERRIDE, error: null } : { data: null, error: null }));
    wrap(<CooOverrideLine requestId="r1" />);
    await waitFor(() => expect(document.querySelector('[data-coo-override]')).toBeTruthy());
    const line = document.querySelector('[data-coo-override]') as HTMLElement;
    expect(line.textContent).toBe('COO pushed with items missing: ID back — Landlord confirmed by phone');
    expect(line.getAttribute('title')).toContain('WEL-0012');
    expect(rpcMock).toHaveBeenCalledWith('coo_item_override_for', { p_request_id: 'r1' });
  });

  it('renders nothing without an override, or when the read fails', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: null });
    const a = wrap(<CooOverrideLine requestId="r1" />);
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    expect(a.container.querySelector('[data-coo-override]')).toBeNull();
    a.unmount();
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    const b = wrap(<CooOverrideLine requestId="r2" />);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(2));
    expect(b.container.querySelector('[data-coo-override]')).toBeNull();
  });

  it("the funders' board item: staff (who get the incomplete list) see the line; funders never trigger the lookup", async () => {
    rpcMock.mockImplementation((fn: string) => Promise.resolve(fn === 'coo_item_override_for' ? { data: OVERRIDE, error: null } : { data: null, error: null }));
    const staff = wrap(<FundersIncompleteChip items={['ID back']} requestId="r1" />);
    await waitFor(() => expect(staff.container.querySelector('[data-coo-override]')?.textContent).toContain('Landlord confirmed by phone'));
    staff.unmount();
    rpcMock.mockClear();
    // A funder's item has no incomplete list (null): no chip, no line, no call.
    const funder = wrap(<FundersIncompleteChip items={null} requestId="r1" />);
    expect(funder.container.innerHTML).toBe('');
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
