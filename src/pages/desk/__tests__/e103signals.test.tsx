import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/** E103–E107: the COO signals on the Command Centre, the pre-mortem, and Landlord Ops' referral landlords. */

const h = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => h.rpc(...a), from: vi.fn(), storage: { from: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: ['coo'] }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/getPublicOrigin', () => ({ getPublicOrigin: () => 'https://welile.example', CANONICAL_ORIGIN: 'https://welile.example' }));

import { ArrearsTile, BalanceMeter, CohortBoard, DemandAlarm } from '../coo/cooSignals';
import { PremortemTab } from '../coo/PremortemTab';
import { ReferralLandlords, referralMessage } from '../ReferralLandlords';

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

beforeEach(() => h.rpc.mockReset());

const TODAY = {
  day: '2026-11-15',
  weekday: 'Sun',
  submissions: 9,
  same_weekday_avg_4w: 20.5,
  daily_avg_28d: 18,
  pct: 44,
  last_7_days: 110,
  weekly_avg_prev_4w: 130.25,
  pct_7d: 84,
  fired: true,
  rule: 'DEMAND-ALARM (E103): …',
};

describe('Demand alarm', () => {
  it('red when today fired; the figures as the server sends them; Acknowledge calls coo_alarm_ack', async () => {
    answer({
      coo_alarms_view: {
        data: {
          today: TODAY,
          alarms: [
            { id: 7, day: '2026-11-15', kind: 'demand_drop', value: 9, baseline: 20.5, pct: 44, acknowledged: false, acknowledged_by: null, acknowledged_at: null },
            { id: 6, day: '2026-11-08', kind: 'demand_drop', value: 12, baseline: 21, pct: 57, acknowledged: true, acknowledged_by: 'ST-0001', acknowledged_at: '2026-11-08T09:00:00Z' },
          ],
        },
        error: null,
      },
      coo_alarm_ack: { data: { ok: true }, error: null },
    });
    wrap(<DemandAlarm board={false} />);
    const banner = await findEl('[data-demand-alarm]');
    expect(banner.getAttribute('data-demand-alarm')).toBe('fired');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.querySelector('[data-demand-today]')?.textContent).toBe('Demand alarm: 9 rent requests on Sun 15 Nov 2026 vs 20.5 same-weekday average (44%)');
    expect(banner.querySelector('[data-demand-7d]')?.textContent).toBe('Last 7 days: 110 vs 130.25 weekly average (84%)');
    expect(banner.querySelector('[data-alarm="6"]')?.textContent).toContain('Acknowledged by ST-0001');
    fireEvent.click(within(banner.querySelector('[data-alarm="7"]') as HTMLElement).getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('coo_alarm_ack', { p_id: 7 }));
  });

  it('quiet when it did not fire, and nothing to acknowledge', async () => {
    answer({ coo_alarms_view: { data: { today: { ...TODAY, fired: false }, alarms: [] }, error: null } });
    wrap(<DemandAlarm board={false} />);
    const banner = await findEl('[data-demand-alarm]');
    expect(banner.getAttribute('data-demand-alarm')).toBe('quiet');
    expect(within(banner).queryByRole('button')).toBeNull();
  });
});

describe('Balance meter', () => {
  it('the ratio and state as sent; a tap shows the rule', async () => {
    answer({
      balance_meter: {
        data: { ratio: 1.35, state: 'tenants_short', verified_waiting: 12, verified_waiting_rent: 7200000, frozen_waiting: 4, frozen_waiting_rent: 2000000, funder_money_ready: 9720000, funders_with_money: 6, rule: 'BALANCE-METER (E104): the rule' },
        error: null,
      },
    });
    wrap(<BalanceMeter board={false} />);
    const meter = await findEl('[data-balance-meter]');
    expect(meter.getAttribute('data-balance-meter')).toBe('tenants_short');
    expect(meter.querySelector('[data-ratio]')?.textContent).toBe('1.35×');
    expect(meter.textContent).toContain('Tenants short');
    expect(meter.textContent).toContain('12 · UGX 7,200,000');
    expect(meter.textContent).toContain('UGX 9,720,000');
    fireEvent.click(meter);
    expect((await findEl('[data-meter-rule]')).textContent).toBe('BALANCE-METER (E104): the rule');
  });
  it('empty: no ratio from the server reads "—"', async () => {
    answer({ balance_meter: { data: { ratio: null, state: 'empty', verified_waiting: 0, verified_waiting_rent: 0, frozen_waiting: 0, funder_money_ready: 0, funders_with_money: 0 }, error: null } });
    wrap(<BalanceMeter board={false} />);
    expect((await findEl('[data-ratio]')).textContent).toBe('—');
    expect(screen.getByText('Nothing waiting')).toBeTruthy();
  });
});

describe('Cohort board', () => {
  it('newest month first as sent, % coloured by the 50% rule', async () => {
    answer({
      cohort_board: {
        data: {
          cohorts: [
            { month: 'Nov 2026', month_start: '2026-11-01', plans: 40, rent_funded: 24000000, due: 3000000, collected: 2700000, pct: 90, repaying: 38, silent_7d: 2, completed: 0 },
            { month: 'Oct 2026', month_start: '2026-10-01', plans: 55, rent_funded: 33000000, due: 12000000, collected: 7200000, pct: 60, repaying: 50, silent_7d: 6, completed: 1 },
            { month: 'Sep 2026', month_start: '2026-09-01', plans: 30, rent_funded: 18000000, due: 14000000, collected: 5600000, pct: 40, repaying: 25, silent_7d: 9, completed: 2 },
          ],
          rule: 'COHORT (E105): …',
        },
        error: null,
      },
    });
    wrap(<CohortBoard board={false} />);
    const table = await findEl('[data-cohort-board]');
    expect(Array.from(table.querySelectorAll('[data-cohort]')).map((r) => r.getAttribute('data-cohort'))).toEqual(['Nov 2026', 'Oct 2026', 'Sep 2026']);
    expect(Array.from(table.querySelectorAll('[data-pct-tone]')).map((c) => c.getAttribute('data-pct-tone'))).toEqual(['ok', 'warn', 'bad']);
    expect(table.querySelector('[data-cohort="Oct 2026"]')?.textContent).toContain('UGX 33,000,000');
  });
  it('empty', async () => {
    answer({ cohort_board: { data: { cohorts: [] }, error: null } });
    wrap(<CohortBoard board={false} />);
    expect(await screen.findByText('No plan funded in the last 6 months.')).toBeTruthy();
  });
});

describe('Arrears tile', () => {
  it('the totals and tier counts from arrears_watch(p_limit 1)', async () => {
    answer({ arrears_watch: { data: { day: '2026-11-15', totals: { plans: 37, agents: 12, due: 1, collected: 0, shortfall: 410000, arrears_to_date: 2900000, new_slip: 5, new_plan: 3, behind: 9, silent: 20, tenant_called: 4, agent_called: 2 }, rows: [] }, error: null } });
    wrap(<ArrearsTile board={false} />);
    const tile = await findEl('[data-arrears-tile]');
    expect(h.rpc).toHaveBeenCalledWith('arrears_watch', { p_limit: 1 });
    expect(tile.textContent).toContain('37 plans short · 12 agents');
    expect(tile.textContent).toContain('UGX 410,000');
    expect(tile.textContent).toContain('New slip 5');
    expect(tile.textContent).toContain('Silent 20');
    expect(tile.textContent).toContain('Tenants called 4 / agents called 2');
  });
  it('a viewer the server refuses sees nothing', async () => {
    answer({ arrears_watch: { data: null, error: { code: '42501', message: 'ARREARS_WATCH_DENIED: …' } } });
    const { container } = wrap(<ArrearsTile board={false} />);
    await waitFor(() => expect(container.querySelector('[aria-label="Arrears watch"]')).toBeNull(), { timeout: 4000 });
  });
});

describe('Pre-mortem', () => {
  const GATES = [
    { gate: 'G1', date: '2026-11-20' },
    { gate: 'G2', date: '2026-12-04' },
  ];
  it('empty: each gate with no risks yet, and the add form', async () => {
    answer({ premortem_list: { data: { gates: GATES, open_by_gate: {}, items: [], rule: 'PRE-MORTEM (E106): …' }, error: null } });
    wrap(<PremortemTab board={false} />);
    expect(await screen.findByText('No risk raised for G1 yet.')).toBeTruthy();
    expect(screen.getByText('No risk raised for G2 yet.')).toBeTruthy();
    expect(document.querySelector('[data-add-risk]')).toBeTruthy();
  });

  it('grouped by gate with the server’s open counts; an answered risk is locked; answer and add call their RPCs', async () => {
    answer({
      premortem_list: {
        data: {
          gates: GATES,
          open_by_gate: { G1: 1 },
          items: [
            { id: 1, gate: 'G1', desk: 'coo', risk: 'Agents stop collecting once paid', likelihood: 'high', raised_by: 'ST-0001', raised_at: '2026-11-10T08:00:00Z', answer: null, answered_by: null, answered_at: null },
            { id: 2, gate: 'G1', desk: 'cfo', risk: 'Funders run out of float', likelihood: 'medium', raised_by: 'ST-0002', raised_at: '2026-11-10T08:00:00Z', answer: 'Partner Ops tops up weekly', answered_by: 'ST-0003', answered_at: '2026-11-11T08:00:00Z' },
          ],
        },
        error: null,
      },
      premortem_answer: { data: { ok: true }, error: null },
      premortem_add: { data: { ok: true, id: 3 }, error: null },
    });
    wrap(<PremortemTab board={false} />);
    const g1 = await findEl('[data-gate="G1"]');
    expect(screen.getByRole('region', { name: 'Gate G1' }).textContent).toContain('1 open');
    expect(screen.getByRole('region', { name: 'Gate G2' }).textContent).toContain('0 open');
    const answered = g1.querySelector('[data-risk="2"]') as HTMLElement;
    expect(answered.querySelector('[data-locked]')?.textContent).toContain('Partner Ops tops up weekly');
    expect(answered.querySelector('textarea')).toBeNull();

    fireEvent.change(g1.querySelector('[data-answer-input="1"]')!, { target: { value: 'Collections are checked daily by Agent Ops' } });
    fireEvent.click(within(g1.querySelector('[data-risk="1"]') as HTMLElement).getByRole('button', { name: 'Save answer' }));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('premortem_answer', { p_id: 1, p_answer: 'Collections are checked daily by Agent Ops' }));

    fireEvent.change(document.querySelector('[data-add-gate]')!, { target: { value: 'G2' } });
    fireEvent.change(document.querySelector('[data-add-likelihood]')!, { target: { value: 'high' } });
    fireEvent.change(document.querySelector('[data-add-risk-text]')!, { target: { value: 'Landlords refuse OTP payouts' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add risk' }));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('premortem_add', { p_gate: 'G2', p_risk: 'Landlords refuse OTP payouts', p_likelihood: 'high' }));
  });

  it('a short answer comes back in plain words', async () => {
    h.rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'premortem_list'
          ? { data: { gates: GATES, open_by_gate: { G1: 1 }, items: [{ id: 1, gate: 'G1', desk: 'coo', risk: 'Agents stop collecting', likelihood: 'low', raised_by: null, raised_at: null, answer: null, answered_by: null, answered_at: null }] }, error: null }
          : { data: null, error: { message: 'ANSWER_TOO_SHORT: say what the plan does about this risk' } },
      ),
    );
    wrap(<PremortemTab board={false} />);
    const g1 = await findEl('[data-gate="G1"]');
    fireEvent.change(g1.querySelector('[data-answer-input="1"]')!, { target: { value: 'ok' } });
    fireEvent.click(within(g1).getByRole('button', { name: 'Save answer' }));
    expect((await within(g1).findByRole('alert')).textContent).toBe('Say what the plan does about this risk in at least 10 characters.');
  });
});

describe('Landlord Ops · Referral landlords', () => {
  it('empty', async () => {
    answer({ landlord_referral_candidates: { data: { landlords: [], rule: 'LANDLORD-CHANNEL (E107): …' }, error: null } });
    wrap(<ReferralLandlords board={false} />);
    expect(await screen.findByText(/No landlord's tenants have paid 80%/)).toBeTruthy();
    expect(h.rpc).toHaveBeenCalledWith('landlord_referral_candidates', { p_min_pct: 80 });
  });

  it('sample: the landlord, Call, and Share code with the code and the apply link', async () => {
    answer({
      landlord_referral_candidates: {
        data: { landlords: [{ landlord_id: 'l1', name: 'Grace L', phone: '0755000222', village: 'Katabi', district: 'Wakiso', plans: 6, pct: 92.4, code: 'LAB12CD34', referred: 2 }] },
        error: null,
      },
    });
    wrap(<ReferralLandlords board={false} />);
    const row = await findEl('[data-landlord="l1"]');
    expect(within(row).getByRole('link', { name: 'Call landlord Grace L' }).getAttribute('href')).toBe('tel:0755000222');
    for (const t of ['Katabi, Wakiso', '6', '92%', 'LAB12CD34', 'Referred 2']) expect(row.textContent).toContain(t);
    fireEvent.click(within(row).getByRole('button', { name: 'Share code' }));
    const sheet = await screen.findByRole('dialog', { name: 'Share code LAB12CD34' });
    const text = 'Welile: thank you, your tenants pay well. Share code LAB12CD34 with people who need rent support — they apply at https://welile.example/tenants-onboarding?ref=LAB12CD34.';
    expect(sheet.querySelector('[data-share-text]')?.textContent).toBe(text);
    expect(sheet.querySelector('[data-share-sms]')?.getAttribute('href')).toBe(`sms:0755000222?body=${encodeURIComponent(text)}`);
    expect(sheet.querySelector('[data-share-whatsapp]')?.getAttribute('href')).toBe(`https://wa.me/256755000222?text=${encodeURIComponent(text)}`);
    expect(referralMessage('LX', 'https://a.b')).toContain('https://a.b/tenants-onboarding?ref=LX');
  });
});

describe('Where they sit', () => {
  it('the three desk tabs and the Command Centre pieces are wired, keeping what is there', () => {
    const page = readFileSync(resolve(__dirname, '../DeskPage.tsx'), 'utf8');
    expect(page).toContain("'agent-ops': 'Arrears calls'");
    expect(page).toContain("'tenant-ops': 'Arrears calls'");
    expect(page).toContain("'landlord-ops': 'Referral landlords'");
    const cc = readFileSync(resolve(__dirname, '../CommandCentre.tsx'), 'utf8');
    for (const s of ['<DemandAlarm board={false} />', '<BalanceMeter board={false} />', '<ArrearsTile board={false} />', '<CohortBoard board={false} />', '<PremortemTab board={board} />', '<ConcernsTab board={board} />', '<Boardroom onClose']) {
      expect(cc).toContain(s);
    }
  });
});
