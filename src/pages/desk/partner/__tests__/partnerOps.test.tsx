import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: vi.fn(), storage: { from: vi.fn() }, functions: { invoke: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: [] }) }));

import { PartnerOpsBoard } from '../PartnerOpsBoard';
import { decisionChip, lastFollowUpText, partnerTiles, rankOfficers, targetProgress, toPartnerBoard, type Officer } from '../partnerApi';
import { FundersDashboard } from '../../cfo/FundersDashboard';
import { toDashboard } from '../../cfo/cfoApi';
import { fundedSplitText, isUnsold7d, sortRows } from '../../cfo/fundersView';

/* ───────────── fixtures ───────────── */

const officer = (id: string, over: Partial<Officer> = {}): Officer => ({
  agent_id: id, officer: `Officer ${id}`, phone: '+256700000000', invites: 0, signups: 0, funders: 0, funded: 0, funded_ugx: 0, contacts: 0, monthly_target: null, ...over,
});

const RAW = {
  period: '30d',
  tiles: {
    listed: { n: 24, ugx: 31_000_000 },
    welile_due: { n: 3, ugx: 2_400_000 },
    held: 4,
    frozen: 1,
    pending_portfolios: { n: 2, ugx: 5_500_000 },
    sold: { n: 18, ugx: 20_100_000, by_officers: { n: 11, ugx: 12e6 }, by_self: { n: 5, ugx: 6e6 }, by_welile: { n: 2, ugx: 2.1e6 }, avg_days_coo_to_funded: 3.26 },
    sell_through_7d: { listed_last_30d: 40, sold_within_7d: 26, pct: 65 },
  },
  listings: [
    {
      id: 'l1', req: 'aaaa0001', tenant: 'Amina', agent: 'Okello', agent_id: 'ag1', agent_phone: '+256770000001', rent: 900_000, days_on_board: 2,
      decision: 'follow_up', why: 'Two funders viewed it; nobody held it.',
      last_followup: { note: 'Agent promised new photos', at: '2026-11-06T07:30:00Z', by: 'Rita' },
    },
    { id: 'l2', req: 'aaaa0002', tenant: 'Joseph', agent: 'Achieng', agent_id: 'ag2', agent_phone: null, rent: 1_200_000, days_on_board: 8, decision: 'welile_due', why: 'Day 8 on the board.', last_followup: null },
    { id: 'l3', req: 'aaaa0003', tenant: 'Grace', agent: 'Kato', agent_id: 'ag3', agent_phone: null, rent: 500_000, days_on_board: 1, decision: 'frozen', why: 'Agent below 50%.', last_followup: null },
  ],
  pending_portfolios: [
    { portfolio_id: 'p1', code: 'PF-01', funder: 'Sarah Auma', funder_phone: '+256780000001', amount: 3_000_000, months: 6, payment_method: 'MoMo', receipt_file_url: 'https://x/r.pdf', officer: 'Officer b', created_at: '2026-11-07T08:00:00Z', hours_waiting: 30 },
  ],
  officers: [
    officer('a', { funded_ugx: 2_000_000, funded: 2 }),
    officer('b', { funded_ugx: 5_000_000, funded: 3, funders: 4, monthly_target: 8, target_unit: 'funders' }),
    officer('c', { funded_ugx: 2_000_000, funded: 4 }),
  ],
  funnel: { invites: 120, signups: 40, funded: 9, funded_ugx: 9_000_000, officers: 12, officers_active: 7, contacts: 300 },
  sold_24h: [{ id: 's1', req: 'bbbb0001', tenant: 'David', rent: 700_000, by: 'officer', funded_at: '2026-11-07T07:00:00Z', days_to_sell: 2 }],
};

function mount(ui: JSX.Element) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><div className="desk-root">{ui}</div></QueryClientProvider>);
}

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockImplementation((fn: string) =>
    Promise.resolve(
      fn === 'partner_ops_board'
        ? { data: RAW, error: null }
        : fn === 'partner_ops_note_followup'
          ? { data: { ok: true, id: 'note-1' }, error: null }
          : { data: 'ok', error: null },
    ),
  );
});

/* ───────────── tiles ───────────── */

describe('Partner Ops tiles', () => {
  it('reads every tile as words', () => {
    const t = Object.fromEntries(partnerTiles(toPartnerBoard(RAW)).map((x) => [x.key, x]));
    expect(t.listed).toMatchObject({ label: 'Listed now', value: '24', sub: 'UGX 31M · 4 held · 1 frozen' });
    expect(t.welile_due).toMatchObject({ label: 'Unsold 7+ days', value: '3', sub: 'UGX 2.4M · Partner Ops follow-up', tone: 'warn' });
    expect(t.sold).toMatchObject({ label: 'Sold', value: '18', sub: 'UGX 20.1M · Officers 11 · Self 5 · Welile 2' });
    expect(t.sell_through).toMatchObject({ label: 'Sell-through within 7 days', value: '65%', sub: '26 of 40 listed in 30 days' });
    expect(t.avg_days).toMatchObject({ label: 'Avg days to sell', value: '3.3' });
    expect(t.pending).toMatchObject({ label: 'Funder money awaiting approval', value: 'UGX 5.5M', sub: '2 portfolios', tone: 'warn' });
    expect(t.officers).toMatchObject({ label: 'Officers active', value: '7 of 12' });
  });

  it('asks for the board with the 30-day default and renders the tiles', async () => {
    mount(<PartnerOpsBoard board={false} />);
    expect(await screen.findByText('Listed now')).toBeTruthy();
    expect(rpcMock).toHaveBeenCalledWith('partner_ops_board', { p_period: '30d' });
    expect(screen.getByText('7 of 12')).toBeTruthy();
    expect(screen.getByRole('button', { name: '30 days' }).getAttribute('aria-pressed')).toBe('true');
  });
});

/* ───────────── approve / reject ───────────── */

describe('funder portfolio approvals', () => {
  it('Approve confirms first, then calls approve_pending_portfolio with the id', async () => {
    mount(<PartnerOpsBoard board={false} />);
    const row = (await screen.findByText('Sarah Auma')).closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Approve' }));
    expect(rpcMock).not.toHaveBeenCalledWith('approve_pending_portfolio', expect.anything());
    const sheet = screen.getByRole('dialog', { name: 'Approve this portfolio' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Approve UGX 3,000,000' }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('approve_pending_portfolio', { p_portfolio_id: 'p1' }));
  });

  it('Reject needs a 10+ character reason and sends it trimmed', async () => {
    mount(<PartnerOpsBoard board={false} />);
    const row = (await screen.findByText('Sarah Auma')).closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Reject…' }));
    const sheet = screen.getByRole('dialog', { name: 'Reject this portfolio' });
    const reject = within(sheet).getByRole('button', { name: 'Reject' }) as HTMLButtonElement;
    const box = within(sheet).getByRole('textbox');
    fireEvent.change(box, { target: { value: 'too short' } });
    expect(reject.disabled).toBe(true);
    fireEvent.change(box, { target: { value: '  Receipt amount does not match  ' } });
    expect(reject.disabled).toBe(false);
    fireEvent.click(reject);
    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith('reject_pending_portfolio', { p_portfolio_id: 'p1', p_reason: 'Receipt amount does not match' }),
    );
  });

  it("shows the server's refusal as-is", async () => {
    rpcMock.mockImplementation((fn: string) =>
      Promise.resolve(fn === 'partner_ops_board' ? { data: RAW, error: null } : { data: null, error: { message: 'Receipt not verified by FinOps' } }),
    );
    mount(<PartnerOpsBoard board={false} />);
    const row = (await screen.findByText('Sarah Auma')).closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Approve' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Approve UGX/ }));
    expect(await screen.findByText('Receipt not verified by FinOps')).toBeTruthy();
  });
});

/* ───────────── listings ───────────── */

describe('listings', () => {
  it('welile_due (unsold 7+ days, PO-7D) gets the neutral Partner Ops follow-up chip; frozen is greyed; follow_up can be called, shows the last note, and is noted', async () => {
    mount(<PartnerOpsBoard board={false} />);
    await screen.findByText('Joseph');
    const due = document.querySelector('li[data-decision="welile_due"]') as HTMLElement;
    const chip = within(due).getByText('Unsold 7+ days · Partner Ops follow-up');
    expect(chip.getAttribute('data-tone')).toBe('idle');
    expect(decisionChip('welile_due')).toMatchObject({ label: 'Unsold 7+ days · Partner Ops follow-up', tone: 'idle' });
    expect(document.body.textContent).not.toContain('Welile to fund');
    expect((document.querySelector('li[data-decision="frozen"]') as HTMLElement).className).toContain('opacity-60');
    const follow = document.querySelector('li[data-decision="follow_up"]') as HTMLElement;
    expect((within(follow).getByRole('button', { name: /Call Okello/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(follow).getByText(/^Last follow-up · .* · Rita: Agent promised new photos$/)).toBeTruthy();
    fireEvent.click(within(follow).getByRole('button', { name: 'Note follow-up' }));
    fireEvent.change(within(follow).getByRole('textbox'), { target: { value: 'Agent will re-shoot the photos today' } });
    fireEvent.click(within(follow).getByRole('button', { name: 'Save the note' }));
    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith('partner_ops_note_followup', { p_request_id: 'l1', p_note: 'Agent will re-shoot the photos today' }),
    );
    expect(rpcMock).not.toHaveBeenCalledWith('add_rent_request_review_note', expect.anything());
    expect(await within(follow).findByText('Follow-up noted.')).toBeTruthy();
  });

  it('a follow-up refused by the server (ok: false) shows its reason', async () => {
    rpcMock.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'partner_ops_board' ? { data: RAW, error: null } : { data: { ok: false, message: 'Only Partner Ops or the COO can note follow-ups' }, error: null },
      ),
    );
    mount(<PartnerOpsBoard board={false} />);
    await screen.findByText('Amina');
    const follow = document.querySelector('li[data-decision="follow_up"]') as HTMLElement;
    fireEvent.click(within(follow).getByRole('button', { name: 'Note follow-up' }));
    fireEvent.change(within(follow).getByRole('textbox'), { target: { value: 'Called twice, no answer yet' } });
    fireEvent.click(within(follow).getByRole('button', { name: 'Save the note' }));
    expect(await within(follow).findByText('Only Partner Ops or the COO can note follow-ups')).toBeTruthy();
  });

  it('last follow-up line, and none when there is none', () => {
    expect(lastFollowUpText({ note: 'Agent promised new photos', at: 'x', by: 'Rita' }, () => '6 Nov 10:30')).toBe('Last follow-up · 6 Nov 10:30 · Rita: Agent promised new photos');
    expect(lastFollowUpText(null, () => '')).toBeNull();
  });
});

/* ───────────── officers ───────────── */

describe('field officers', () => {
  it('rank by money funded, then plans funded; the target is a count of funders', async () => {
    expect(rankOfficers(RAW.officers).map((o) => o.agent_id)).toEqual(['b', 'c', 'a']);
    // 4 funders of a target of 8 funders — not UGX.
    expect(targetProgress(RAW.officers[1])).toBe(50);
    expect(targetProgress({ funders: 9, funders_this_month: 2, monthly_target: 8 })).toBe(25);
    expect(targetProgress(RAW.officers[0])).toBeNull();
    mount(<PartnerOpsBoard board={false} />);
    await screen.findByText('Officer b');
    expect([...document.querySelectorAll('tr[data-officer]')].map((r) => r.getAttribute('data-officer'))).toEqual(['b', 'c', 'a']);
    expect(screen.getByRole('progressbar', { name: 'Officer b: 50% of the monthly target' })).toBeTruthy();
    expect(screen.getByText('4 of 8 funders · 50%')).toBeTruthy();
    // No target, no bar.
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
  });
});

/* ───────────── Funders Dashboard ───────────── */

const FUNDED = (over: Record<string, unknown> = {}) =>
  toDashboard({
    funded: { n: 8, ugx: 9e6, by_funders: { n: 5, ugx: 6e6 }, by_welile: { n: 3, ugx: 3e6 }, ...over },
    can_fund_welile: true,
    rows: [
      { id: 'young', rent: 100, days_on_board: 2, rank_grade: 1, rank_oldest: 2, held: false },
      { id: 'due', rent: 100, days_on_board: 7, rank_grade: 2, rank_oldest: 1, held: false },
    ],
  });

describe('Funders Dashboard', () => {
  it("splits Funded into officers' funders, self and Welile, and falls back to the funders total", () => {
    expect(fundedSplitText(FUNDED({ by_officers: { n: 3, ugx: 1 }, by_self: { n: 2, ugx: 1 } }).funded)).toBe(
      "8 requests · Officers' funders 3 · Self 2 · Welile 3",
    );
    expect(fundedSplitText(FUNDED().funded)).toBe('8 requests · Funders 5 · Welile 3');
  });

  it('puts rows unsold 7+ days first with the neutral Partner Ops follow-up chip', async () => {
    const d = FUNDED();
    expect(isUnsold7d({ days_on_board: 7 })).toBe(true);
    expect(isUnsold7d({ days_on_board: 6.9 })).toBe(false);
    expect(sortRows(d.rows, 'grade').map((r) => r.id)).toEqual(['due', 'young']);
    rpcMock.mockImplementation(() =>
      Promise.resolve({
        data: {
          funded: { n: 8, ugx: 9e6, by_funders: { n: 5, ugx: 6e6 }, by_welile: { n: 3, ugx: 3e6 }, by_officers: { n: 3, ugx: 1 }, by_self: { n: 2, ugx: 1 } },
          can_fund_welile: false,
          rows: [
            { id: 'young', req: 'young001', tenant: 'Young', rent: 100, days_on_board: 2, rank_grade: 1, held: false },
            { id: 'due', req: 'due00001', tenant: 'Due', rent: 100, days_on_board: 9, rank_grade: 2, held: false },
          ],
        },
        error: null,
      }),
    );
    mount(<FundersDashboard board={false} />);
    expect(await screen.findByText("8 requests · Officers' funders 3 · Self 2 · Welile 3")).toBeTruthy();
    const bodyRows = [...document.querySelectorAll('tbody tr')];
    expect(bodyRows[0].textContent).toContain('Due');
    const chip = within(bodyRows[0] as HTMLElement).getByText('Unsold 7+ days · Partner Ops follow-up');
    expect(chip.getAttribute('data-tone')).toBe('idle');
    expect(within(bodyRows[1] as HTMLElement).queryByText('Unsold 7+ days · Partner Ops follow-up')).toBeNull();
    expect(document.body.textContent).not.toContain('Welile to fund');
  });
});
