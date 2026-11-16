import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/** E102: the arrears watch on Tenant Ops and Agent Ops, and Log call. Every count is the server's. */

const h = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => h.rpc(...a), from: vi.fn(), storage: { from: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: ['coo'] }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { TenantArrearsTab } from '../arrears/TenantArrearsTab';
import { AgentArrearsTab } from '../arrears/AgentArrearsTab';
import { CALL_ERROR_WORDS, plainError, validateCall, waHref, yesterdayKampala } from '../arrears/arrearsApi';

const ZERO = { plans: 0, agents: 0, due: 0, collected: 0, shortfall: 0, arrears_to_date: 0, new_slip: 0, new_plan: 0, behind: 0, silent: 0, tenant_called: 0, agent_called: 0 };
const TOTALS = { plans: 2, agents: 1, due: 30000, collected: 5000, shortfall: 25000, arrears_to_date: 410000, new_slip: 1, new_plan: 0, behind: 0, silent: 1, tenant_called: 1, agent_called: 0 };
const TIERS = { new_slip: 'Was paying in the 7 days before, slipped yesterday', new_plan: 'First 30 days of the plan', behind: 'Paid something in the last 8 days but under half', silent: 'Nothing paid for more than 7 days' };
const ROW = {
  rent_request_id: 'rr-1',
  tier: 'new_slip',
  frequency: 'daily',
  daily_due: 15000,
  window_due: 15000,
  collected: 5000,
  pct: 33.3,
  arrears_to_date: 60000,
  last_paid_on: '2026-11-14',
  days_since_paid: 1,
  plan_day: 42,
  tenant: { id: 't1', name: 'Amina Nakato', phone: '0772000111' },
  agent: { id: 'a1', name: 'Paul Okello', phone: '0700123456', collection_pct: 46.2, eligible: false },
  landlord: { id: 'l1', name: 'Grace L', phone: '0755000222', caretaker_name: 'Moses', caretaker_phone: '0788000333', village: 'Katabi', district: 'Wakiso' },
  funder: { name: 'No named funder (Welile pool)' },
  tenant_ops_call: { party: 'tenant', outcome: 'promised_date', promised_date: '2026-11-18', note: null, at: '2026-11-16T07:05:00Z', staff_ref: 'ST-0042' },
  agent_ops_call: null,
};
const ROW2 = { ...ROW, rent_request_id: 'rr-2', tier: 'silent', tenant: { id: 't2', name: 'Ben Kato', phone: null }, funder: { id: 'f1', name: 'Faith Funder', phone: '0711000999' }, tenant_ops_call: null, landlord: { ...ROW.landlord, caretaker_name: null, caretaker_phone: null } };
const WATCH = { day: '2026-11-15', rule: 'ARREARS-WATCH (E102): …', tiers: TIERS, totals: TOTALS, matching: 2, rows: [ROW, ROW2] };
const EMPTY = { day: '2026-11-15', rule: null, tiers: TIERS, totals: ZERO, matching: 0, rows: [] };

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
/** The element once it is there (waitFor alone would accept a null). */
const findEl = (sel: string, root: ParentNode = document) =>
  waitFor(() => {
    const el = root.querySelector(sel) as HTMLElement | null;
    expect(el).toBeTruthy();
    return el!;
  });
const answer = (map: Record<string, unknown>) =>
  h.rpc.mockImplementation((fn: string) => Promise.resolve(fn in map ? (map[fn] as object) : { data: null, error: null }));

// A Tuesday: these are the "Yesterday" screens (a Monday opens on last week, E113).
beforeEach(() => {
  h.rpc.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-17T06:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('Log call rules', () => {
  it('needs an outcome; a promised date for promised_date; a note for refused, dispute and other', () => {
    expect(validateCall({ outcome: '', note: '', promisedDate: '' })).toBe('Pick what happened on the call.');
    expect(validateCall({ outcome: 'promised_date', note: '', promisedDate: '' })).toBe(CALL_ERROR_WORDS.PROMISE_DATE_REQUIRED);
    expect(validateCall({ outcome: 'promised_date', note: '', promisedDate: '2026-11-20' })).toBeNull();
    for (const o of ['refused', 'dispute', 'other'] as const) expect(validateCall({ outcome: o, note: '  ', promisedDate: '' })).toBe(CALL_ERROR_WORDS.NOTE_REQUIRED);
    expect(validateCall({ outcome: 'no_answer', note: '', promisedDate: '' })).toBeNull();
  });
  it('server codes in plain words; an unknown code shows the server’s words', () => {
    expect(plainError({ message: 'STAFF_ID_REQUIRED: your staff ID is needed to record a call' })).toBe(CALL_ERROR_WORDS.STAFF_ID_REQUIRED);
    expect(plainError({ message: 'PROMISE_DATE_REQUIRED: enter the date they promised to pay' })).toBe('Enter the date they promised to pay.');
    expect(plainError({ message: 'NOTE_REQUIRED: say what happened' })).toBe('Write a note saying what happened.');
    expect(plainError({ message: 'CALL_PARTY_INVALID: boss' })).toBe('boss');
    expect(plainError({ message: 'statement timeout' })).toBe('statement timeout');
  });
  it('WhatsApp takes the number in full', () => {
    expect(waHref('0772 000 111')).toBe('https://wa.me/256772000111');
    expect(waHref('+256772000111')).toBe('https://wa.me/256772000111');
  });
});

describe('Tenant Ops · Arrears calls', () => {
  it('empty: the server’s zero totals and a plain empty line', async () => {
    answer({ arrears_watch: { data: EMPTY, error: null } });
    wrap(<TenantArrearsTab board={false} />);
    expect(await screen.findByText(/No plan was short for 15 Nov 2026/)).toBeTruthy();
    expect(screen.getByText('Tenants called 0 / agents called 0')).toBeTruthy();
    expect(h.rpc).toHaveBeenCalledWith('arrears_watch', { p_day: yesterdayKampala(), p_tier: null, p_search: null, p_limit: 50, p_offset: 0 });
  });

  it('sample: totals, tier chips with the server’s counts, progress, and the tenant cards', async () => {
    answer({ arrears_watch: { data: WATCH, error: null } });
    wrap(<TenantArrearsTab board={false} />);
    const card = await findEl('[data-tenant-card="rr-1"]');
    expect(screen.getByText('Tenants called 1 / agents called 0')).toBeTruthy();
    expect(document.querySelector('[data-tier-chip="new_slip"]')?.textContent).toBe('New slip1');
    expect(document.querySelector('[data-tier-chip="silent"]')?.textContent).toBe('Silent1');
    expect(document.querySelector('[data-tier-chip="all"]')?.textContent).toBe('All2');
    // The tile shortens money; the full figure is its label.
    expect(screen.getByLabelText('UGX 25,000')).toBeTruthy();

    // Contacts: tenant with WhatsApp, agent with collection %, landlord, caretaker, and the pool funder without a button.
    const c = within(card);
    expect(c.getByRole('link', { name: 'Call tenant Amina Nakato' }).getAttribute('href')).toBe('tel:0772000111');
    expect(c.getByRole('link', { name: 'WhatsApp tenant Amina Nakato' }).getAttribute('href')).toBe('https://wa.me/256772000111');
    expect(card.querySelector('[data-contact="agent"]')?.textContent).toContain('46% collected');
    expect(card.querySelector('[data-contact="agent"]')?.textContent).toContain('Below 50%');
    expect(c.getByRole('link', { name: 'Call landlord Grace L' })).toBeTruthy();
    expect(c.getByRole('link', { name: 'Call caretaker Moses' })).toBeTruthy();
    expect(card.querySelector('[data-contact="funder"]')?.textContent).toContain('No named funder (Welile pool)');
    expect(card.querySelector('[data-contact="funder"] a')).toBeNull();
    // A named funder has a button; no caretaker, no caretaker line.
    const card2 = document.querySelector('[data-tenant-card="rr-2"]') as HTMLElement;
    expect(within(card2).getByRole('link', { name: 'Call funder Faith Funder' })).toBeTruthy();
    expect(card2.querySelector('[data-contact="caretaker"]')).toBeNull();

    // Figures and the last calls.
    const figures = card.querySelector('[data-figures]')!.textContent!;
    for (const t of ['UGX 15,000', 'UGX 5,000', '33%', 'UGX 60,000', '14 Nov 2026', '42', 'daily']) expect(figures).toContain(t);
    expect(card.querySelector('[data-last-call="Tenant Ops"]')?.textContent).toContain('Promised a date (18 Nov 2026)');
    expect(card.querySelector('[data-last-call="Tenant Ops"]')?.textContent).toContain('ST-0042');
    expect(card.querySelector('[data-last-call="Agent Ops"]')?.textContent).toContain('No call yet');

    // The tier badge explains itself from payload.tiers.
    fireEvent.click(card.querySelector('[data-tier-badge]')!);
    expect(card.querySelector('[data-tier-why]')?.textContent).toBe(TIERS.new_slip);
  });

  it('a tier chip asks the server for that tier', async () => {
    answer({ arrears_watch: { data: WATCH, error: null } });
    wrap(<TenantArrearsTab board={false} />);
    fireEvent.click(await findEl('[data-tier-chip="silent"]'));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('arrears_watch', expect.objectContaining({ p_tier: 'silent', p_offset: 0 })));
  });

  it('Log call: the form stops what the server would refuse, then sends the call; a server refusal reads in plain words', async () => {
    answer({ arrears_watch: { data: WATCH, error: null }, arrears_log_call: { data: { ok: true }, error: null } });
    wrap(<TenantArrearsTab board={false} />);
    const card = await findEl('[data-tenant-card="rr-1"]');
    fireEvent.click(within(card).getByRole('button', { name: 'Log call' }));
    const sheet = await screen.findByRole('dialog', { name: 'Log call · Amina Nakato' });
    const save = within(sheet).getByRole('button', { name: 'Save call' });
    const calls = () => h.rpc.mock.calls.filter((c) => c[0] === 'arrears_log_call');

    fireEvent.click(save);
    expect(within(sheet).getByRole('alert').textContent).toBe('Pick what happened on the call.');
    fireEvent.change(sheet.querySelector('[data-outcome]')!, { target: { value: 'promised_date' } });
    fireEvent.click(save);
    expect(within(sheet).getByRole('alert').textContent).toBe('Enter the date they promised to pay.');
    fireEvent.change(sheet.querySelector('[data-outcome]')!, { target: { value: 'refused' } });
    fireEvent.click(save);
    expect(within(sheet).getByRole('alert').textContent).toBe('Write a note saying what happened.');
    expect(calls()).toHaveLength(0);

    fireEvent.change(sheet.querySelector('[data-outcome]')!, { target: { value: 'promised_date' } });
    fireEvent.change(sheet.querySelector('[data-promised-date]')!, { target: { value: '2026-11-20' } });
    fireEvent.change(sheet.querySelector('[data-promised-amount]')!, { target: { value: '15,000' } });
    fireEvent.click(save);
    await waitFor(() => expect(calls()).toHaveLength(1));
    expect(calls()[0][1]).toEqual({
      p_party: 'tenant',
      p_outcome: 'promised_date',
      p_rent_request_id: 'rr-1',
      p_note: null,
      p_promised_date: '2026-11-20',
      p_promised_amount: 15000,
      p_desk: 'tenant-ops',
      p_day: yesterdayKampala(),
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Log call · Amina Nakato' })).toBeNull());

    // The server still refuses: its code in plain words.
    h.rpc.mockImplementation((fn: string) =>
      Promise.resolve(fn === 'arrears_log_call' ? { data: null, error: { code: '42501', message: 'STAFF_ID_REQUIRED: your staff ID is needed to record a call' } } : { data: WATCH, error: null }),
    );
    fireEvent.click(within(card).getByRole('button', { name: 'Log call' }));
    const again = await screen.findByRole('dialog', { name: 'Log call · Amina Nakato' });
    fireEvent.click(again.querySelector('[data-party="landlord"]')!);
    fireEvent.change(again.querySelector('[data-outcome]')!, { target: { value: 'no_answer' } });
    fireEvent.click(within(again).getByRole('button', { name: 'Save call' }));
    expect((await within(again).findByRole('alert')).textContent).toBe(CALL_ERROR_WORDS.STAFF_ID_REQUIRED);
    expect(calls()[1][1]).toEqual(expect.objectContaining({ p_party: 'landlord', p_outcome: 'no_answer' }));
  });

  it('a refused screen shows the server’s words', async () => {
    answer({ arrears_watch: { data: null, error: { code: '42501', message: 'ARREARS_WATCH_DENIED: Agent Ops, Tenant Ops, the COO and the CEO only' } } });
    wrap(<TenantArrearsTab board={false} />);
    expect((await screen.findByRole('alert', {}, { timeout: 4000 })).textContent).toBe(CALL_ERROR_WORDS.ARREARS_WATCH_DENIED);
  });
});

describe('Agent Ops · Arrears calls', () => {
  const AGENT = {
    agent_id: 'a1',
    name: 'Paul Okello',
    phone: '0700123456',
    tenants_short: 2,
    shortfall: 25000,
    arrears_to_date: 410000,
    new_slip: 1,
    new_plan: 0,
    behind: 0,
    silent: 1,
    collection_pct: 46.2,
    eligible: false,
    agent_ops_call: { outcome: 'no_answer', at: '2026-11-16T08:00:00Z', staff_ref: 'ST-0007' },
  };

  it('empty', async () => {
    answer({ arrears_watch_agents: { data: { day: '2026-11-15', agents: [] }, error: null } });
    wrap(<AgentArrearsTab board={false} />);
    expect(await screen.findByText(/No agent had a tenant short for 15 Nov 2026/)).toBeTruthy();
    expect(h.rpc).toHaveBeenCalledWith('arrears_watch_agents', { p_day: yesterdayKampala() });
  });

  it('sample: the agent row; expanding loads their tenants by phone (up to 500); Log call goes to the agent', async () => {
    answer({
      arrears_watch_agents: { data: { day: '2026-11-15', agents: [AGENT] }, error: null },
      arrears_watch: { data: WATCH, error: null },
      arrears_log_call: { data: { ok: true }, error: null },
    });
    wrap(<AgentArrearsTab board={false} />);
    const row = await findEl('[data-agent-row="a1"]');
    const r = within(row);
    expect(r.getByRole('link', { name: 'Call agent Paul Okello' }).getAttribute('href')).toBe('tel:0700123456');
    expect(r.getByRole('link', { name: 'WhatsApp agent Paul Okello' })).toBeTruthy();
    expect(row.querySelector('[data-tenants-short]')?.textContent).toContain('2');
    expect(row.querySelector('[data-shortfall]')?.textContent).toContain('UGX 25,000');
    expect(row.querySelector('[data-tier-counts]')?.textContent).toBe('New slip 1New plan 0Behind 0Silent 1');
    expect(row.textContent).toContain('46% collected');
    expect(row.textContent).toContain('Below 50%');
    expect(row.querySelector('[data-last-call="Agent Ops today"]')?.textContent).toContain('No answer');

    fireEvent.click(row.querySelector('[data-expand]')!);
    await waitFor(() => expect(row.querySelector('[data-tenant-card="rr-1"]')).toBeTruthy());
    expect(h.rpc).toHaveBeenCalledWith('arrears_watch', { p_day: yesterdayKampala(), p_tier: null, p_search: '0700123456', p_limit: 500, p_offset: 0 });

    // The agent's own button comes before the tenant cards'.
    fireEvent.click(r.getAllByRole('button', { name: 'Log call' })[0]);
    const sheet = await screen.findByRole('dialog', { name: 'Log call · Paul Okello' });
    expect(sheet.querySelector('[data-party]')).toBeNull();
    fireEvent.change(sheet.querySelector('[data-outcome]')!, { target: { value: 'will_pay_today' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save call' }));
    await waitFor(() => expect(h.rpc.mock.calls.some((c) => c[0] === 'arrears_log_call')).toBe(true));
    expect(h.rpc.mock.calls.find((c) => c[0] === 'arrears_log_call')![1]).toEqual({
      p_party: 'agent',
      p_outcome: 'will_pay_today',
      p_agent_id: 'a1',
      p_note: null,
      p_promised_date: null,
      p_promised_amount: null,
      p_desk: 'agent-ops',
      p_day: yesterdayKampala(),
    });
  });
});
