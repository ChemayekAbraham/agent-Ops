import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/** E116: promises kept — my promises, the desk board, broken promises with "Call again", and the Command Centre card. */

const h = vi.hoisted(() => ({ rpc: vi.fn(), staffRef: 'ST-0042' as string | null }));
vi.mock('@/integrations/supabase/client', () => {
  const builder = () => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit']) b[m] = vi.fn(() => b);
    b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: h.staffRef ? [{ staff_ref: h.staffRef }] : [], error: null }).then(ok);
    return b;
  };
  return { supabase: { rpc: (...a: unknown[]) => h.rpc(...a), from: () => builder(), storage: { from: vi.fn() } } };
});
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: ['tenant_ops'] }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { DeskPromises, PromisesCard } from '../arrears/promises';
import { LogCallSheet } from '../arrears/ArrearsParts';

const OFFICERS = [
  { staff_ref: 'ST-0007', name: 'Sarah Nambi', desk: 'tenant-ops', promises: 10, kept: 8, broken: 1, open: 1, kept_pct: 88.9, collected_on_kept: 400000 },
  { staff_ref: 'ST-0042', name: 'Josh K', desk: 'tenant-ops', promises: 6, kept: 3, broken: 1, open: 2, kept_pct: 75, collected_on_kept: 90000 },
  { staff_ref: 'ST-0099', name: 'Ali M', desk: 'tenant-ops', promises: 4, kept: 1, broken: 3, open: 0, kept_pct: 25, collected_on_kept: 15000 },
];
const BROKEN = [
  {
    call_id: 501,
    desk: 'tenant-ops',
    by: 'ST-0042',
    party: 'tenant',
    promise_on: '2026-11-14',
    target: 30000,
    collected: 10000,
    rent_request_id: 'rr-9',
    tenant: { name: 'Amina Nakato', phone: '0772000111' },
    agent: { id: 'a1', name: 'Paul Okello', phone: '0700123456' },
  },
  { call_id: 502, desk: 'agent-ops', by: 'ST-0007', party: 'agent', promise_on: '2026-11-13', target: null, collected: 0, rent_request_id: null, tenant: null, agent: { id: 'a2', name: 'Grace A', phone: '0700999888' } },
];
const DATA = { days: 30, rule: 'PROMISES-KEPT (E116): …', totals: { promises: 20, kept: 12, broken: 5, open: 3, kept_pct: 70.6, collected_on_kept: 505000 }, officers: OFFICERS, broken_recent: BROKEN };
const EMPTY = { days: 30, rule: null, totals: { promises: 0, kept: 0, broken: 0, open: 0, kept_pct: null, collected_on_kept: 0 }, officers: [], broken_recent: [] };

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
const answer = (map: Record<string, unknown>) =>
  h.rpc.mockImplementation((fn: string) => Promise.resolve(fn in map ? (map[fn] as object) : { data: null, error: null }));
const findEl = (sel: string, root: ParentNode = document) =>
  waitFor(() => {
    const el = root.querySelector(sel) as HTMLElement | null;
    expect(el).toBeTruthy();
    return el!;
  });

beforeEach(() => {
  h.rpc.mockReset();
  h.staffRef = 'ST-0042';
});

describe('My promises and the desk board', () => {
  it('my chip by staff ID: kept %, kept / broken / open, collected on kept; the board in the server’s order with mine marked', async () => {
    answer({ promises_kept: { data: DATA, error: null } });
    wrap(<DeskPromises desk="tenant-ops" />);
    const mine = await findEl('[data-my-promises="ST-0042"]');
    expect(h.rpc).toHaveBeenCalledWith('promises_kept', { p_days: 30, p_desk: 'tenant-ops' });
    expect(mine.textContent).toBe('My promises: 75% kept3 kept / 1 broken / 2 open · UGX 90,000 collected on kept');

    const rows = Array.from(document.querySelectorAll('[data-promise-board] tbody tr'));
    expect(rows.map((r) => r.getAttribute('data-officer'))).toEqual(['ST-0007', 'ST-0042', 'ST-0099']);
    expect(rows.map((r) => r.getAttribute('data-mine'))).toEqual([null, 'true', null]);
    expect(rows.map((r) => r.querySelector('[data-kept-tone]')?.getAttribute('data-kept-tone'))).toEqual(['ok', 'ok', 'bad']);
    expect(rows[0].textContent).toBe('Sarah NambiST-00071088.9%UGX 400,000');
  });

  it('no row for me yet, and no staff ID on file', async () => {
    answer({ promises_kept: { data: { ...DATA, officers: OFFICERS.filter((o) => o.staff_ref !== 'ST-0042') }, error: null } });
    const a = wrap(<DeskPromises desk="tenant-ops" />);
    expect((await findEl('[data-my-promises]')).textContent).toBe('My promises: none logged yet');
    a.unmount();
    h.staffRef = null;
    wrap(<DeskPromises desk="tenant-ops" />);
    expect((await findEl('[data-my-promises]')).getAttribute('data-my-promises')).toBe('no-staff-id');
  });

  it('empty: plain lines, never a made-up figure', async () => {
    answer({ promises_kept: { data: EMPTY, error: null } });
    wrap(<DeskPromises desk="agent-ops" />);
    expect((await findEl('[data-my-promises]')).textContent).toBe('My promises: none logged yet');
    expect(screen.getByText('No promises logged in this period.')).toBeTruthy();
    expect(screen.getByText('No broken promises in this period.')).toBeTruthy();
    expect(h.rpc).toHaveBeenCalledWith('promises_kept', { p_days: 30, p_desk: 'agent-ops' });
  });
});

describe('Broken promises', () => {
  it('tenant Call/WhatsApp, agent Call, promised date, target vs collected; "Call again" opens Log call on the plan', async () => {
    answer({ promises_kept: { data: DATA, error: null }, arrears_log_call: { data: { ok: true }, error: null } });
    wrap(<DeskPromises desk="tenant-ops" />);
    const item = await findEl('[data-broken="501"]');
    const it2 = within(item);
    expect(it2.getByRole('link', { name: 'Call tenant Amina Nakato' }).getAttribute('href')).toBe('tel:0772000111');
    expect(it2.getByRole('link', { name: 'WhatsApp tenant Amina Nakato' })).toBeTruthy();
    expect(it2.getByRole('link', { name: 'Call agent Paul Okello' }).getAttribute('href')).toBe('tel:0700123456');
    expect(item.querySelector('[data-broken-figures]')?.textContent).toBe('Promised for 14 Nov 2026 · target UGX 30,000 · collected UGX 10,000 · logged by ST-0042');
    // No amount promised: the target reads "—".
    expect(document.querySelector('[data-broken="502"] [data-broken-figures]')?.textContent).toContain('target —');

    fireEvent.click(it2.getByRole('button', { name: 'Call again' }));
    const sheet = await screen.findByRole('dialog', { name: 'Call again · Amina Nakato' });
    expect((sheet.querySelector('[data-party="tenant"]') as HTMLInputElement).checked).toBe(true);
    fireEvent.change(sheet.querySelector('[data-outcome]')!, { target: { value: 'will_pay_today' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save call' }));
    await waitFor(() => expect(h.rpc.mock.calls.some((c) => c[0] === 'arrears_log_call')).toBe(true));
    expect(h.rpc.mock.calls.find((c) => c[0] === 'arrears_log_call')![1]).toEqual(expect.objectContaining({ p_party: 'tenant', p_outcome: 'will_pay_today', p_rent_request_id: 'rr-9', p_desk: 'tenant-ops' }));
  });

  it('an agent-level promise calls the agent again', async () => {
    answer({ promises_kept: { data: DATA, error: null }, arrears_log_call: { data: { ok: true }, error: null } });
    wrap(<DeskPromises desk="agent-ops" />);
    const item = await findEl('[data-broken="502"]');
    fireEvent.click(within(item).getByRole('button', { name: 'Call again' }));
    const sheet = await screen.findByRole('dialog', { name: 'Call again · Grace A' });
    expect(sheet.querySelector('[data-party]')).toBeNull();
    fireEvent.change(sheet.querySelector('[data-outcome]')!, { target: { value: 'no_answer' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save call' }));
    await waitFor(() => expect(h.rpc.mock.calls.some((c) => c[0] === 'arrears_log_call')).toBe(true));
    expect(h.rpc.mock.calls.find((c) => c[0] === 'arrears_log_call')![1]).toEqual(expect.objectContaining({ p_party: 'agent', p_agent_id: 'a2', p_desk: 'agent-ops' }));
  });
});

describe('Command Centre · Promises kept', () => {
  it('totals and the ranking across both desks; 7 / 30 / 90 days', async () => {
    answer({ promises_kept: { data: { ...DATA, officers: [...OFFICERS, { ...OFFICERS[0], staff_ref: 'ST-0300', name: 'Agent Ops Ann', desk: 'agent-ops' }] }, error: null } });
    wrap(<PromisesCard board={false} />);
    expect((await findEl('[data-promise-totals]')).textContent).toBe('70.6% kept · 12 kept / 5 broken / 3 open of 20 · UGX 505,000 collected on kept');
    expect(h.rpc).toHaveBeenCalledWith('promises_kept', { p_days: 30, p_desk: null });
    expect(document.querySelector('[data-officer="ST-0300"]')?.textContent).toContain('Agent Ops');
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('promises_kept', { p_days: 7, p_desk: null }));
    fireEvent.click(screen.getByRole('button', { name: '90 days' }));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('promises_kept', { p_days: 90, p_desk: null }));
  });

  it('empty totals read as sent; a viewer the server refuses sees no card', async () => {
    answer({ promises_kept: { data: EMPTY, error: null } });
    const a = wrap(<PromisesCard board={false} />);
    expect((await findEl('[data-promise-totals]')).textContent).toContain('— kept');
    expect(screen.getByText('No promises logged in this period.')).toBeTruthy();
    a.unmount();
    answer({ promises_kept: { data: null, error: { code: '42501', message: 'PROMISES_DENIED: …' } } });
    const b = wrap(<PromisesCard board={false} />);
    await waitFor(() => expect(b.container.querySelector('[aria-label="Promises kept"]')).toBeNull(), { timeout: 4000 });
  });
});

describe('Log call: the promised amount', () => {
  it('"Promised amount (optional, recommended)", with why', async () => {
    wrap(<LogCallSheet title="Log call" parties={['tenant']} defaultParty="tenant" rentRequestId="rr-1" desk="tenant-ops" day="2026-11-15" onClose={() => {}} />);
    const sheet = await screen.findByRole('dialog', { name: 'Log call' });
    fireEvent.change(sheet.querySelector('[data-outcome]')!, { target: { value: 'promised_date' } });
    expect(within(sheet).getByText('Promised amount (optional, recommended)')).toBeTruthy();
    expect(sheet.querySelector('[data-amount-hint]')?.textContent).toContain('With an amount the promise is judged exactly');
  });

  it('sits at the top of both Arrears calls tabs and on the Command Centre', () => {
    for (const [f, desk] of [['../arrears/TenantArrearsTab.tsx', 'tenant-ops'], ['../arrears/AgentArrearsTab.tsx', 'agent-ops']]) {
      expect(readFileSync(resolve(__dirname, f), 'utf8')).toContain(`<DeskPromises desk="${desk}" />`);
    }
    expect(readFileSync(resolve(__dirname, '../CommandCentre.tsx'), 'utf8')).toContain('<PromisesCard board={false} />');
  });
});
