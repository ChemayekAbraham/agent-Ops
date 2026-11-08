import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: vi.fn(), storage: { from: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: [] }) }));

import { drawerStartFor, eligibilityChip, opensDrawer, primaryLabel, type BoardRow } from '../boardApi';
import { PhotoReview, photoSaveBlocked, previewPhotos } from '../PhotoReview';
import { orderOptions, type TransferOption } from '../TransferPicker';
import { CooBoard, cooTopLine, frozenText, isPushable, pushPlan, type CooRow } from '../CooBoard';
import { matchesFilter, pctTrend, type RankingRow } from '../AgentRanking';
import { intakeBlocked } from '../IntakeForm';

/* ───────────────────────── fixtures ───────────────────────── */

function boardRow(over: Partial<BoardRow>): BoardRow {
  return {
    id: 'r', req: 'r', tenant: 'T', tenant_id: null, tenant_phone: null, agent_id: 'a', agent: 'A', agent_phone: null,
    agent_grade: 'C', agent_grade_week_ago: null, agent_flags: [], landlord: null, landlord_phone: null, rent: 1, days_here: 1,
    rating: null, flags: { passes: 0, total: 0, hard_fail: false, soft_fail: false, failing: [], notes: [], flags: [] },
    decision: 'pass', rule_id: null, why: null, receiver: null, waiting: null, wait_suggest: null, push: null, call: null,
    ...over,
  };
}

function cooRow(over: Partial<CooRow>): CooRow {
  return {
    id: 'c', req: 'c', tenant: 'T', agent: 'A', agent_grade: 'B', landlord: 'L', landlord_verified: true, rent: 100_000,
    days_here: 2, ratings: null, grade: 'A', avg: 80, flags: null, auto_forwarded: false, waiting: null, rank: 1,
    pushable: true, frozen: null, ...over,
  };
}

const URLS = ['https://x/1.jpg', 'https://x/2.jpg', 'https://x/3.jpg', 'https://x/4.jpg'];

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockImplementation((fn: string) => {
    if (fn === 'agent_ops_photo_state')
      return Promise.resolve({ data: { all_photos: URLS, current: URLS, reviewed: false, main: null, approved: [], rejected: [], ok: false }, error: null });
    if (fn === 'funder_card_preview')
      return Promise.resolve({
        data: { house_category: 'single-room', location: 'Kireka, Wakiso', rent: 300000, main_photo: URLS[0], photos: URLS, gps: null, badge: 'Verified tenant' },
        error: null,
      });
    return Promise.resolve({ data: null, error: null });
  });
});

function mountPhotos() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <div className="desk-root">
        <PhotoReview requestId="req-1" />
      </div>
    </QueryClientProvider>,
  );
}

/* ───────────────────────── tests ───────────────────────── */

describe('Agent Ops board decisions', () => {
  it('labels for every Agent Ops decision', () => {
    expect(primaryLabel(boardRow({ decision: 'complete' }), 'agent_ops')).toBe('Call and fill');
    expect(primaryLabel(boardRow({ decision: 'review_photos' }), 'agent_ops')).toBe('Review photos');
    expect(primaryLabel(boardRow({ decision: 'pass' }), 'agent_ops')).toBe('Pass');
    expect(primaryLabel(boardRow({ decision: 'send_back' }), 'agent_ops')).toBe('Send back');
    expect(primaryLabel(boardRow({ decision: 'reject' }), 'agent_ops')).toBe('Reject');
    expect(
      primaryLabel(boardRow({ decision: 'transfer', receiver: { agent_id: 'b', name: 'Bena', grade: 'B', km: 2.4, score: 70, pct: 81.6 } }), 'agent_ops'),
    ).toBe('Transfer → Bena (82%, 2.4 km)');
    expect(primaryLabel(boardRow({ decision: 'complete' }), 'tenant_ops')).toBe('Finish checks');
  });

  it('complete and review_photos open the drawer on the form or the photos tab', () => {
    expect(opensDrawer('complete')).toBe(true);
    expect(opensDrawer('review_photos')).toBe(true);
    expect(drawerStartFor('complete')).toBe('complete');
    expect(drawerStartFor('review_photos')).toBe('photos');
    expect(drawerStartFor('pass')).toBeUndefined();
  });

  it('eligibility chip text', () => {
    expect(eligibilityChip({ eligible: true, pct: 62, new: false, open: 1 })).toEqual({ text: '62% collected ✓', tone: 'ok' });
    expect(eligibilityChip({ eligible: false, pct: 31, new: false, open: 0 })).toEqual({ text: '31% — below 50%', tone: 'bad' });
    expect(eligibilityChip({ eligible: true, pct: null, new: true, open: 2 })).toEqual({ text: 'New agent · 2 open (limit 3)', tone: 'idle' });
    expect(eligibilityChip({ eligible: false, pct: null, new: true, open: 11 })?.text).toBe('New agent · 11 open (limit 3)');
    expect(eligibilityChip({ eligible: false, pct: null, new: true, open: 4 })?.tone).toBe('bad');
    expect(eligibilityChip(null)).toBeNull();
  });

  it('intake form rules', () => {
    const blank = { familySize: '', workBusiness: '', workLocation: '', lc1: '' };
    expect(intakeBlocked(blank)).toMatch(/at least one/);
    expect(intakeBlocked({ ...blank, familySize: '31' })).toMatch(/1 to 30/);
    expect(intakeBlocked({ ...blank, familySize: '4' })).toBeNull();
    expect(intakeBlocked({ ...blank, lc1: 'short' })).toMatch(/10 characters/);
    expect(intakeBlocked({ ...blank, lc1: 'LC1 Mr Okello 0772000000 confirmed' })).toBeNull();
  });
});

describe('photo review', () => {
  it('needs 3 approved and a main among them', () => {
    expect(photoSaveBlocked(URLS.slice(0, 2), URLS[0])).toMatch(/at least 3/);
    expect(photoSaveBlocked(URLS.slice(0, 3), null)).toMatch(/main photo/);
    expect(photoSaveBlocked(URLS.slice(0, 3), URLS[3])).toMatch(/one of the approved/);
    expect(photoSaveBlocked(URLS.slice(0, 3), URLS[1])).toBeNull();
    expect(previewPhotos(null, URLS[2], URLS.slice(0, 3))).toEqual([URLS[2], URLS[0], URLS[1]]);
  });

  it('Save stays off until 3 are approved and a main is starred', async () => {
    mountPhotos();
    const save = await screen.findByRole('button', { name: 'Save the photo review' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    const approve = screen.getAllByRole('button', { name: /Approve/ });
    fireEvent.click(approve[0]);
    fireEvent.click(approve[1]);
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(approve[2]);
    expect((save as HTMLButtonElement).disabled).toBe(true); // 3 approved, no main yet
    fireEvent.click(screen.getByRole('button', { name: 'Make photo 2 the main photo' }));
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith('agent_ops_review_photos', {
        p_request_id: 'req-1',
        p_main_url: URLS[1],
        p_approved: URLS.slice(0, 3),
        p_rejected: [],
      }),
    );
  });

  it('the funders card preview follows the main photo before saving', async () => {
    mountPhotos();
    const preview = await screen.findByTestId('funder-preview');
    fireEvent.click(screen.getByRole('button', { name: 'Make photo 3 the main photo' }));
    expect(preview.getAttribute('data-main')).toBe(URLS[2]);
    expect(within(preview).getAllByRole('img')[0].getAttribute('src')).toBe(URLS[2]);
    fireEvent.click(screen.getByRole('button', { name: 'Make photo 4 the main photo' }));
    expect(preview.getAttribute('data-main')).toBe(URLS[3]);
    expect(within(preview).getByText(/Verified tenant/)).toBeTruthy();
    expect(rpcMock).not.toHaveBeenCalledWith('agent_ops_review_photos', expect.anything());
  });
});

describe('transfer picker', () => {
  it('within 25 km first, server order kept inside each group', () => {
    const opt = (id: string, within: boolean): TransferOption => ({
      agent_id: id, agent: id, phone: null, pct: 70, new_agent: false, open_requests: 0, plans: 1, km: within ? 3 : 40, within_25km: within, transfers_7d: 0, grade: 'B',
    });
    expect(orderOptions([opt('far1', false), opt('near1', true), opt('far2', false), opt('near2', true)]).map((o) => o.agent_id)).toEqual([
      'near1', 'near2', 'far1', 'far2',
    ]);
  });
});

describe('COO board — frozen rows', () => {
  const rows = [
    cooRow({ id: 'p1', rank: 1, rent: 100_000 }),
    cooRow({ id: 'f1', rank: 2, rent: 900_000, pushable: false, frozen: { reason: 'Agent below 50%', since: '2026-11-01', returns_to_agent_ops_at: '2026-11-12T09:00:00Z' } }),
    cooRow({ id: 'p2', rank: 3, rent: 200_000 }),
    cooRow({ id: 'np', rank: 4, rent: 50_000, pushable: false }),
  ];

  it('frozen and unpushable rows are never in Push top N', () => {
    expect(pushPlan(rows, 10).rows.map((r) => r.id)).toEqual(['p1', 'p2']);
    expect(pushPlan(rows, 10).totalUgx).toBe(300_000);
    expect(isPushable(rows[1])).toBe(false);
  });

  it('renders the pushable / frozen chips and the frozen row as kit chips', async () => {
    rpcMock.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'pipeline_coo_board'
          ? { data: { counts: { A: 1, B: 0, C: 1, D: 0, unrated: 0, waiting: 0, pushable: 2, frozen: 1 }, can_push: true, rows }, error: null }
          : { data: null, error: null },
      ),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <CooBoard board={false} onOpen={() => {}} />
      </QueryClientProvider>,
    );
    const pushable = await screen.findByText('2 pushable');
    expect(pushable.getAttribute('data-tone')).toBe('ok');
    expect(screen.getByText('1 frozen').getAttribute('data-tone')).toBe('idle');
    // The chip stays short ("Frozen", the sentence in its tooltip); the sentence has its own line.
    const frozenChip = screen.getByText('Frozen');
    expect(frozenChip.getAttribute('data-tone')).toBe('idle');
    expect(frozenChip.getAttribute('title')).toMatch(/^Frozen — Agent below 50%/);
    expect(frozenChip.closest('li')?.getAttribute('data-frozen')).toBe('true');
    expect(screen.getByText(/^Frozen — Agent below 50%; back to Agent Ops on 12 Nov$/)).toBeTruthy();
  });

  it('top line and frozen wording', () => {
    expect(cooTopLine({ A: 20, B: 40, C: 30, D: 23, unrated: 0, waiting: 0, pushable: 38, frozen: 75 })).toBe('38 pushable · 75 frozen · A 20 · B 40 · C 30 · D 23');
    expect(frozenText(rows[1].frozen!)).toBe('Frozen — Agent below 50%; back to Agent Ops on 12 Nov');
  });
});

describe('agent ranking', () => {
  const r = (over: Partial<RankingRow>): RankingRow => ({
    agent_id: 'a', agent: 'A', phone: null, eligible: true, pct: 70, pct_week_ago: 60, due: 1, collected: 1, plans: 1,
    new_agent: false, open_requests: 0, open: null, grade: 'B', ...over,
  });
  it('filters and trend', () => {
    expect(matchesFilter(r({}), 'eligible')).toBe(true);
    expect(matchesFilter(r({ eligible: false, pct: 31 }), 'below_50')).toBe(true);
    expect(matchesFilter(r({ new_agent: true, pct: null }), 'below_50')).toBe(false);
    expect(matchesFilter(r({ new_agent: true }), 'new')).toBe(true);
    expect(pctTrend(70, 60)).toBe('up');
    expect(pctTrend(40, 60)).toBe('down');
    expect(pctTrend(40, null)).toBeNull();
  });
});
