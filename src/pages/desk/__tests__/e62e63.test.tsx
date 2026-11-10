import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
let catalogue: unknown[] = [];
const fromChain = {
  select: () => fromChain,
  eq: () => fromChain,
  in: () => fromChain,
  maybeSingle: () => Promise.resolve({ data: null, error: null }),
  order: () => Promise.resolve({ data: catalogue, error: null }),
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

import { CONCERN_BLOCK_LINE, CooBoard, cooLines, isPushable, type CooRow } from '../CooBoard';
import { SendBackForm, deskReasons, noteNeeded, sendBackBlocked } from '../sendBack';
import { AccountabilityTile, deskSlug, normalizeTile } from '../accountability/AccountabilityTile';

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
afterEach(() => setWidth(1024));
beforeEach(() => {
  rpcMock.mockReset();
  catalogue = [];
});

const wrap = (ui: ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

const coo = (over: Partial<CooRow>): CooRow => ({
  id: 'c1', req: 'c1', tenant: 'Cara', agent: 'Andy', agent_grade: 'B', landlord: 'L', landlord_verified: true, rent: 300000, days_here: 4.4,
  ratings: { agent_ops: 80, tenant_ops: null, landlord_ops: 60, average: 70, grade: 'B', partly_rated: false }, grade: 'A', avg: 80,
  flags: null, auto_forwarded: false, waiting: null, rank: 1, pushable: true, frozen: null, ...over,
});

const OPTIONS = [
  { code: 'agent', label: 'Field agent (to correct)', hint: 'Ends this round; the agent fixes and resubmits' },
  { code: 'service_centre', label: 'Service Centre', hint: 'Items to be checked again' },
  { code: 'landlord_ops', label: 'Landlord Ops', hint: 'Landlord to be called again' },
];
const COO_CODES = [
  { code: 'LANDLORD_UNVERIFIED', meaning: 'Landlord or payout number not verified', requires_text: false },
  { code: 'OTHER', meaning: 'Reviewed weekly to create new codes', requires_text: true },
];

type Rpc = (fn: string, args?: Record<string, unknown>) => { data: unknown; error: unknown } | undefined;
const mockRpcs = (extra: Rpc = () => undefined) =>
  rpcMock.mockImplementation((fn: string, args?: Record<string, unknown>) => {
    const hit = extra(fn, args);
    if (hit) return Promise.resolve(hit);
    if (fn === 'pipeline_coo_board')
      return Promise.resolve({ data: { counts: { A: 2, pushable: 1, frozen: 0 }, can_push: true, rows: [coo({}), coo({ id: 'c2', tenant: 'Bea', pushable: false, concern_block: true })] }, error: null });
    if (fn === 'pipeline_send_back_options') return Promise.resolve({ data: OPTIONS, error: null });
    if (fn === 'coo_reason_codes') return Promise.resolve({ data: COO_CODES, error: null });
    return Promise.resolve({ data: null, error: null });
  });

/* ───────────── E62: serious concern blocks the push ───────────── */

describe('COO board — serious concern (E62)', () => {
  it('a blocked row is not pushable and carries the blocked line', () => {
    const r = coo({ concern_block: true });
    expect(isPushable(r)).toBe(false);
    expect(cooLines(r)).toEqual([CONCERN_BLOCK_LINE]);
    expect(cooLines(coo({}))).toEqual([]);
  });

  it('shows the line under the row and no push button on it', async () => {
    setWidth(1280);
    mockRpcs();
    wrap(<CooBoard board={false} onOpen={() => {}} />);
    await screen.findByText('Bea');
    const blocked = document.querySelector('[data-row="c2"]') as HTMLElement;
    expect(blocked.querySelector('[data-row-line="concern"]')?.textContent).toBe(CONCERN_BLOCK_LINE);
    expect(within(blocked).queryByRole('button', { name: 'Push to funders' })).toBeNull();
    const ok = document.querySelector('[data-row="c1"]') as HTMLElement;
    expect(within(ok).getByRole('button', { name: 'Push to funders' })).toBeTruthy();
    expect(ok.querySelector('[data-row-line]')).toBeNull();
  });

  it('375 px: the card carries the same line', async () => {
    setWidth(375);
    mockRpcs();
    wrap(<CooBoard board={false} onOpen={() => {}} />);
    await screen.findByText('Bea');
    expect(document.querySelector('[data-row="c2"] [data-row-line="concern"]')?.textContent).toBe(CONCERN_BLOCK_LINE);
  });
});

/* ───────────── E63: send back to a chosen office ───────────── */

describe('send-back rules', () => {
  it('needs an office, a reason, and a note of 10+ for OTHER / RISK_JUDGEMENT / text codes', () => {
    const other = { code: 'OTHER', meaning: null, requires_text: false };
    const plain = { code: 'DOC_MISSING', meaning: null, requires_text: false };
    expect(sendBackBlocked({ to: '', reason: plain, note: '' })).toMatch(/where/);
    expect(sendBackBlocked({ to: 'agent', reason: null, note: '' })).toMatch(/reason/);
    expect(sendBackBlocked({ to: 'agent', reason: plain, note: '' })).toBeNull();
    expect(sendBackBlocked({ to: 'agent', reason: other, note: 'too short' })).toMatch(/10 characters/);
    expect(sendBackBlocked({ to: 'agent', reason: other, note: 'long enough now' })).toBeNull();
    expect(noteNeeded({ code: 'RISK_JUDGEMENT', meaning: null, requires_text: false })).toBe(true);
    expect(noteNeeded({ code: 'DATA_ERROR', meaning: null, requires_text: true })).toBe(true);
  });

  it("a desk's reasons are its own and the shared ones, never the system's", () => {
    const all = [
      { code: 'RULE_FOLLOWED', desks: ['all'], meaning: 'auto', requires_text: false },
      { code: 'OTHER', desks: ['all'], meaning: 'o', requires_text: true },
      { code: 'LANDLORD_NO_CONSENT', desks: ['Landlord Ops'], meaning: 'n', requires_text: false },
      { code: 'TENANT_IN_ARREARS', desks: ['landlord_ops'], meaning: 'a', requires_text: false },
      { code: 'NO_SMARTPHONE', desks: ['Tenant Ops'], meaning: 's', requires_text: false },
    ];
    expect(deskReasons(all, 'landlord_ops').map((r) => r.code)).toEqual(['OTHER', 'LANDLORD_NO_CONSENT', 'TENANT_IN_ARREARS']);
  });
});

describe('COO "Send back…" sheet', () => {
  const openSheet = async () => {
    setWidth(1280);
    wrap(<CooBoard board={false} onOpen={() => {}} />);
    await screen.findByText('Cara');
    fireEvent.click(within(document.querySelector('[data-row="c1"]') as HTMLElement).getByRole('button', { name: 'More for Cara' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send back…' }));
    const sheet = await screen.findByRole('dialog', { name: 'Send back — Cara' });
    await within(sheet).findByText('Field agent (to correct)');
    await within(sheet).findByText('Landlord or payout number not verified');
    return sheet;
  };

  it('lists the offices with hints and the COO reasons, and sends with the chosen ones', async () => {
    mockRpcs((fn) => (fn === 'pipeline_send_back_to' ? { data: { ok: true, to: 'landlord_ops', to_label: 'Landlord Ops' }, error: null } : undefined));
    const sheet = await openSheet();
    expect(rpcMock).toHaveBeenCalledWith('pipeline_send_back_options', { p_from_stage: 'coo' });
    expect(within(sheet).getByText('Landlord to be called again')).toBeTruthy();
    const send = () => within(sheet).getByRole('button', { name: /^Send back to/ });
    expect((send() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(sheet.querySelector('[data-office="landlord_ops"]') as HTMLElement);
    expect(send().textContent).toBe('Send back to Landlord Ops');
    fireEvent.click(sheet.querySelector('[data-reason="OTHER"]') as HTMLElement);
    expect(within(sheet).getByText(/required, at least 10 characters/)).toBeTruthy();
    expect((send() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(sheet).getByRole('textbox'), { target: { value: 'Landlord number changed last week' } });
    expect((send() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(send());
    await within(sheet).findByText('Sent back to Landlord Ops.');
    expect(rpcMock).toHaveBeenCalledWith('pipeline_send_back_to', {
      p_request_id: 'c1',
      p_from_stage: 'coo',
      p_to: 'landlord_ops',
      p_reason_code: 'OTHER',
      p_note: 'Landlord number changed last week',
    });
    expect(rpcMock).not.toHaveBeenCalledWith('pipeline_record_review', expect.anything());
    expect(rpcMock).not.toHaveBeenCalledWith('return_rent_request_for_correction', expect.anything());
  });

  it("shows the server's message as-is when the send-back fails", async () => {
    mockRpcs((fn) => (fn === 'pipeline_send_back_to' ? { data: null, error: { message: 'Only the COO can send back from the COO desk', code: '42501' } } : undefined));
    const sheet = await openSheet();
    fireEvent.click(sheet.querySelector('[data-office="agent"]') as HTMLElement);
    fireEvent.click(sheet.querySelector('[data-reason="LANDLORD_UNVERIFIED"]') as HTMLElement);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Send back to Field agent (to correct)' }));
    expect((await within(sheet).findByRole('alert')).textContent).toBe('Only the COO can send back from the COO desk');
  });
});

describe('send-back form on another desk', () => {
  it("Tenant Ops reads its reasons from the desk's catalogue", async () => {
    catalogue = [
      { code: 'NO_SMARTPHONE', desks: ['Tenant Ops'], meaning: 'Tenant has no smartphone', requires_text: false },
      { code: 'LANDLORD_NO_CONSENT', desks: ['Landlord Ops'], meaning: 'Landlord did not confirm', requires_text: false },
    ];
    mockRpcs((fn) => (fn === 'pipeline_send_back_options' ? { data: OPTIONS.slice(0, 2), error: null } : undefined));
    wrap(<SendBackForm requestId="r9" stage="tenant_ops" onDone={() => {}} />);
    await screen.findByText('Tenant has no smartphone');
    expect(screen.queryByText('Landlord did not confirm')).toBeNull();
    expect(rpcMock).not.toHaveBeenCalledWith('coo_reason_codes', expect.anything());
    expect(rpcMock).toHaveBeenCalledWith('pipeline_send_back_options', { p_from_stage: 'tenant_ops' });
  });
});

/* ───────────── E63: the command centre tile ───────────── */

const TILE = {
  days: 7,
  total_flags: 14,
  unattributed: 2,
  by_desk: [
    { stage: 'agent_ops', label: 'Agent Ops', flags: 9, people: 3 },
    { stage: 'agent', label: 'Field agents', flags: 5, people: 4 },
  ],
  top_people: [
    { name: 'Ann Ops', staff_ref: 'WL-014', stage: 'agent_ops', flags: 6 },
    { name: 'Ben Field', staff_ref: null, stage: 'agent', flags: 3 },
  ],
  latest: [{ req: 'ab12cd34', id: 'x', label: 'Photos rejected', stage: 'agent_ops', found_at: '2026-11-08T10:00:00Z', found_on: 'landlord_ops', person: 'Ann Ops' }],
};

describe('Accountability tile', () => {
  it('maps stages to desk slugs', () => {
    expect(['service_centre', 'agent_ops', 'tenant_ops', 'landlord_ops', 'agent', 'coo'].map(deskSlug)).toEqual([
      'service-centre', 'agent-ops', 'tenant-ops', 'landlord-ops', 'agent-app', 'coo',
    ]);
    expect(normalizeTile({ top_people: Array(9).fill(TILE.top_people[0]) }).top_people).toHaveLength(5);
  });

  it('shows a skeleton, never a zero, while loading', async () => {
    rpcMock.mockImplementation(() => new Promise(() => {}));
    wrap(<AccountabilityTile board={false} />);
    expect(screen.getByRole('status', { name: 'Loading accountability' })).toBeTruthy();
    expect(document.querySelector('[data-total-flags]')).toBeNull();
  });

  it('shows the total, desk chips, top people and latest; the window asks again', async () => {
    mockRpcs((fn) => (fn === 'desk_accountability_tile' ? { data: TILE, error: null } : undefined));
    wrap(<AccountabilityTile board={false} />);
    expect((await screen.findByText('14')).hasAttribute('data-total-flags')).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith('desk_accountability_tile', { p_days: 7 });
    expect(document.querySelector('[data-desk-chip="agent_ops"]')?.textContent).toContain('9 flags');
    expect(document.querySelector('[data-desk-chip="agent_ops"]')?.textContent).toContain('3 people');
    const people = document.querySelectorAll('[data-top-person]');
    expect(people).toHaveLength(2);
    expect(people[0].textContent).toContain('WL-014');
    expect(people[0].textContent).toContain('Agent Ops');
    expect(document.querySelectorAll('[data-latest]')[0].textContent).toContain('Photos rejected');
    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('desk_accountability_tile', { p_days: 30 }));
  });

  it('a desk chip opens that desk from desk_accountability with its slug', async () => {
    mockRpcs((fn) =>
      fn === 'desk_accountability_tile'
        ? { data: TILE, error: null }
        : fn === 'desk_accountability'
          ? { data: { rows: [{ stage: 'agent', person_id: 'p1', name: 'Ben Field', staff_ref: null, passed: 10, flagged: 3, rate: 30, items: [] }] }, error: null }
          : undefined,
    );
    wrap(<AccountabilityTile board={false} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Field agents: 5 flags/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Field agents — last 7 days' });
    await within(sheet).findAllByText('Ben Field');
    expect(rpcMock).toHaveBeenCalledWith('desk_accountability', { p_desk: 'agent-app', p_days: 7 });
  });
});
