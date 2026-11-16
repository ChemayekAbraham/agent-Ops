import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/** The COO reviews and sends back ANY request in the COO queue: frozen, held and blocked ones too; one at a time or a selection. */

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
import type { DrawerContext } from '../ReadyBoard';

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
afterEach(() => setWidth(1024));
beforeEach(() => rpcMock.mockReset());

const wrap = (ui: ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

const FROZEN = { reason: 'Agent below 50% collected', since: '2026-11-02T08:00:00Z', returns_to_agent_ops_at: '2026-11-12T08:00:00Z' };
const coo = (over: Partial<CooRow>): CooRow => ({
  id: 'p1', req: 'p1', tenant: 'Pia', agent: 'Andy', agent_grade: 'B', agent_pct: 46, landlord: 'L', landlord_verified: true, rent: 300000, days_here: 4,
  ratings: { agent_ops: 80, tenant_ops: 70, landlord_ops: 60, average: 70, grade: 'B', partly_rated: false }, grade: 'A', avg: 80,
  flags: null, auto_forwarded: false, waiting: null, rank: 1, pushable: true, frozen: null, ...over,
});
const ROWS = [
  coo({}),
  coo({ id: 'f1', req: 'f1', tenant: 'Fred', rank: 2, pushable: false, frozen: FROZEN }),
  coo({ id: 'f2', req: 'f2', tenant: 'Faye', rank: 3, pushable: false, frozen: FROZEN }),
  coo({ id: 'w1', req: 'w1', tenant: 'Wes', rank: 4, pushable: false, waiting: { reason_code: 'NEED_DOCS', owner_kind: 'agent', until_at: '2026-12-01T00:00:00Z', expired: false, note: 'LC1 letter coming', rule_id: null } }),
];
const OPTIONS = [
  { code: 'agent', label: 'Field agent (to correct)', hint: 'Ends this round; the agent fixes and resubmits' },
  { code: 'service_centre', label: 'Service Centre', hint: 'Items to be checked again' },
  { code: 'agent_ops', label: 'Agent Ops', hint: 'Agent, items or photos to be reviewed again' },
  { code: 'tenant_ops', label: 'Tenant Ops', hint: 'Tenant to be called again' },
  { code: 'landlord_ops', label: 'Landlord Ops', hint: 'Landlord to be called again' },
];
const COO_CODES = [
  { code: 'AGENT_FROZEN', meaning: 'Agent below 50% collected', requires_text: false },
  { code: 'OTHER', meaning: 'Reviewed weekly to create new codes', requires_text: true },
];

type Rpc = (fn: string, args?: Record<string, unknown>) => { data: unknown; error: unknown } | undefined;
const mockRpcs = (extra: Rpc = () => undefined) =>
  rpcMock.mockImplementation((fn: string, args?: Record<string, unknown>) => {
    const hit = extra(fn, args);
    if (hit) return Promise.resolve(hit);
    if (fn === 'pipeline_coo_board') return Promise.resolve({ data: { counts: { A: 4, pushable: 1, frozen: 2 }, can_push: true, rows: ROWS }, error: null });
    if (fn === 'pipeline_send_back_options') return Promise.resolve({ data: OPTIONS, error: null });
    if (fn === 'coo_reason_codes') return Promise.resolve({ data: COO_CODES, error: null });
    return Promise.resolve({ data: null, error: null });
  });
const sendBackCalls = () => rpcMock.mock.calls.filter((c) => c[0] === 'pipeline_send_back_to');
const rowEl = (id: string) => document.querySelector(`[data-row="${id}"]`) as HTMLElement;

describe('every COO row can be reviewed and sent back', () => {
  it('a frozen row: the Frozen badge, the reason and the return date, Review and Send back, and no push', async () => {
    setWidth(1280);
    mockRpcs();
    wrap(<CooBoard board={false} onOpen={() => {}} />);
    await screen.findByText('Fred');
    const f = rowEl('f1');
    expect(f.querySelector('[data-frozen-chip]')?.textContent).toBe('Frozen');
    expect(f.textContent).toContain('Frozen — Agent below 50% collected; returns to Agent Ops on 12 Nov');
    expect(within(f).getByRole('button', { name: 'Review' })).toBeTruthy();
    expect(within(f).getByRole('button', { name: 'Send back' })).toBeTruthy();
    expect(within(f).queryByRole('button', { name: 'Push to funders' })).toBeNull();
    // Held rows too; the pushable row keeps its push, unchanged.
    expect(within(rowEl('w1')).getByRole('button', { name: 'Send back' })).toBeTruthy();
    expect(within(rowEl('p1')).getByRole('button', { name: 'Push to funders' })).toBeTruthy();
    expect(within(rowEl('p1')).getByRole('button', { name: 'Review' })).toBeTruthy();
  });

  it('Review opens the full request with the agent’s collections, the freeze reason and the concerns above it', async () => {
    setWidth(1280);
    mockRpcs();
    const onOpen = vi.fn();
    wrap(<CooBoard board={false} onOpen={onOpen} />);
    await screen.findByText('Fred');
    fireEvent.click(within(rowEl('f1')).getByRole('button', { name: 'Review' }));
    expect(onOpen).toHaveBeenCalledWith('f1', undefined, expect.objectContaining({ facts: expect.anything() }));
    const ctx = onOpen.mock.calls[0][2] as DrawerContext;
    wrap(<>{ctx.facts}</>);
    const facts = document.querySelector('[data-coo-facts]') as HTMLElement;
    expect(facts.querySelector('[data-coo-agent]')?.textContent).toContain('46%');
    expect(facts.querySelector('[data-coo-frozen]')?.textContent).toContain('Agent below 50% collected');
    expect(facts.querySelector('[data-coo-frozen]')?.textContent).toContain('12 Nov 2026');
    expect(facts.querySelector('[data-coo-concerns]')).toBeTruthy();
  });

  it('send back a frozen row to Agent Ops: pipeline_send_back_to from the COO desk', async () => {
    setWidth(1280);
    mockRpcs((fn) => (fn === 'pipeline_send_back_to' ? { data: { ok: true, to: 'agent_ops', to_label: 'Agent Ops' }, error: null } : undefined));
    wrap(<CooBoard board={false} onOpen={() => {}} />);
    await screen.findByText('Fred');
    fireEvent.click(within(rowEl('f1')).getByRole('button', { name: 'Send back' }));
    const sheet = await screen.findByRole('dialog', { name: 'Send back — Fred' });
    await within(sheet).findByText('Agent Ops');
    fireEvent.click(sheet.querySelector('[data-office="agent_ops"]') as HTMLElement);
    fireEvent.click((await waitFor(() => sheet.querySelector('[data-reason="AGENT_FROZEN"]'))) as HTMLElement);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Send back to Agent Ops' }));
    await waitFor(() => expect(sendBackCalls()).toHaveLength(1));
    expect(sendBackCalls()[0][1]).toEqual({ p_request_id: 'f1', p_from_stage: 'coo', p_to: 'agent_ops', p_reason_code: 'AGENT_FROZEN', p_note: null });
  });
});

describe('Select mode on the COO queue', () => {
  it('select all frozen, send back selected once each; a partial failure is listed with the server’s words', async () => {
    setWidth(1280);
    mockRpcs((fn, args) =>
      fn === 'pipeline_send_back_to'
        ? args?.p_request_id === 'f2'
          ? { data: null, error: { message: 'Request is at "coo_approved", not at the coo desk', code: '22023' } }
          : { data: { ok: true, to: 'agent_ops', to_label: 'Agent Ops' }, error: null }
        : undefined,
    );
    wrap(<CooBoard board={false} onOpen={() => {}} />);
    await screen.findByText('Fred');
    expect(document.querySelector('[data-coo-select]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all frozen (2)' }));
    expect(document.querySelector('[data-coo-selected-count]')?.textContent).toBe('2 selected');
    expect((document.querySelector('[data-coo-select="f1"]') as HTMLInputElement).checked).toBe(true);
    expect((document.querySelector('[data-coo-select="p1"]') as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Send back selected' }));
    const sheet = await screen.findByRole('dialog', { name: 'Send back 2 requests' });
    await within(sheet).findByText('Agent Ops');
    fireEvent.click(sheet.querySelector('[data-destination="agent_ops"]') as HTMLElement);
    await waitFor(() => expect(sheet.querySelector('[data-coo-reason] option[value="OTHER"]')).toBeTruthy());
    fireEvent.change(sheet.querySelector('[data-coo-reason]')!, { target: { value: 'OTHER' } });
    const confirm = within(sheet).getByRole('button', { name: 'Send back 2' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(sheet.querySelector('[data-coo-note]')!, { target: { value: 'Agent collections under 50% for a month' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(sendBackCalls()).toHaveLength(2));
    expect(sendBackCalls().map((c) => c[1])).toEqual([
      { p_request_id: 'f1', p_from_stage: 'coo', p_to: 'agent_ops', p_reason_code: 'OTHER', p_note: 'Agent collections under 50% for a month' },
      { p_request_id: 'f2', p_from_stage: 'coo', p_to: 'agent_ops', p_reason_code: 'OTHER', p_note: 'Agent collections under 50% for a month' },
    ]);
    const result = await screen.findByRole('dialog', { name: 'Send back 2 requests' });
    expect((await waitFor(() => result.querySelector('[data-coo-bulk-summary]') as HTMLElement)).textContent).toBe('Done 1 · Skipped 1');
    expect(result.querySelector('[data-coo-skipped="f2"]')?.textContent).toBe('FayeRequest is at "coo_approved", not at the coo desk');
    fireEvent.click(within(result).getAllByRole('button', { name: 'Close' }).at(-1)!);
    // The one sent back leaves the selection; the skipped one stays ticked.
    await waitFor(() => expect(document.querySelector('[data-coo-selected-count]')?.textContent).toBe('1 selected'));
  });
});
