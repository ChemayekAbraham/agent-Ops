import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/*
 * Funders Dashboard (/desk/cfo): each row's Ref and what funders see under the
 * rent; a tap opens the read-only plan drawer; Recall (E86) only for staff who
 * may demote, only while the money is with the agent.
 */

const ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const h = vi.hoisted(() => ({ rpc: vi.fn(), tables: {} as Record<string, unknown[]>, toast: { success: vi.fn(), error: vi.fn() } }));

const chain = (rows: unknown[]) => {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'order', 'limit']) c[m] = () => c;
  c.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null });
  (c as { then: unknown }).then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok, bad);
  return c;
};
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...a: unknown[]) => h.rpc(...a),
    from: (t: string) => chain(h.tables[t] ?? []),
    storage: { from: () => ({ createSignedUrl: () => Promise.resolve({ data: { signedUrl: 'https://files.test/lc1.pdf' }, error: null }) }) },
  },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: ['coo'] }) }));
vi.mock('@/hooks/useIdentityPhotos', () => ({ identityPhotoUrl: () => Promise.resolve(null) }));
vi.mock('sonner', () => ({ toast: h.toast }));

import { FundersDashboard } from '../FundersDashboard';
import {
  RECALL_LEVELS,
  RECALL_REASONS,
  canRecall,
  funderLine,
  pickFrom,
  recallConfirmText,
  recallToastText,
  refText,
} from '../planDrawerApi';

const ROW = {
  id: ID, req: ID.slice(0, 8), tenant: 'Amina Nakato', tenant_location: 'Kireka', agent: 'Paul Okello', landlord: 'Grace L', landlord_phone: '0772000001',
  lc1: 'Mr Ssali', rent: 650000, funding_amount: 650000, gps: { lat: 0.35, lng: 32.6 }, photos: ['https://img.test/h1.jpg'], days_on_board: 2, held: false,
  hold_expires_at: null, grade: 'A', average: 4.5, ratings: { agent_ops: 5, tenant_ops: 4, landlord_ops: 4.5 }, rank_grade: 1, rank_oldest: 1,
};
const DASH = {
  generated_at: '2026-11-12T08:00:00Z', period: 'today', fund_today: { n: 1, ugx: 650000 }, held_by_funders: { n: 0, ugx: 0 },
  funded: { n: 0, ugx: 0, by_funders: { n: 0, ugx: 0 }, by_welile: { n: 0, ugx: 0 } }, headline: {}, rows: [ROW],
};
const BOARD = {
  items: [{ kind: 'rent_request', id: ID, tag: 'verified', request_kind: 'renewal', incomplete: ['family size'], house_category: 'Self-contained', city: 'Kampala', rent_amount: 650000, photos: [] }],
  counts: {},
};
const SHEET = {
  request: {
    id: ID, status: 'coo_approved', stage: null, round: 0, rent_amount: 650000, duration_days: 30, created_at: '2026-11-01T00:00:00Z',
    tenant: { id: 't', name: 'Amina Nakato', phone: '0700111222', occupation: null }, agent: { id: 'a', name: 'Paul Okello', phone: '0700333444' },
    landlord: { id: 'l', name: 'Grace L', phone: '0772000001', verified: true }, lc1: { name: 'Mr Ssali' }, lc_letter: { bucket: 'rent-documents', path: 'x/lc1.pdf' },
    house_photos: ['https://img.test/h1.jpg', 'https://img.test/h2.jpg'], gps: null, funder_visible: true,
  },
  checklist: [], history: [], score: null, recommendation: null, can_review: false, my_staff_ref: null,
};
const flow = (stage: string | null) => ({
  released: { count: 1, ugx: 650000 }, with_agent: { count: 1, ugx: 650000, oldest_hours: 3 }, part_paid: { count: 0, ugx_paid: 0, ugx_left: 0 }, live: { count: 0, ugx: 0 },
  items: stage ? [{ rent_request_id: ID, tenant: 'Amina Nakato', agent: 'Paul Okello', landlord: 'Grace L', amount: 650000, paid_out: 0, stage, hours_since_release: 3 }] : [],
});

let answers: Record<string, unknown> = {};
const setAnswers = (over: Record<string, unknown> = {}) => {
  answers = {
    funders_dashboard: { data: DASH, error: null },
    funders_board_items: { data: BOARD, error: null },
    get_self_support_fee_policy: { data: { enabled: true, rate: 0.05, round_to: 100 }, error: null },
    pipeline_review_sheet: { data: SHEET, error: null },
    funded_money_flow: { data: flow(null), error: null },
    funders_board_can_demote: { data: false, error: null },
    request_identity_photos: { data: { tenant: null, agent: null, flags: {} }, error: null },
    request_desk_history: { data: { desks: [], calls: [], moves: [], concerns: [], other_actions: [] }, error: null },
    ...over,
  };
  h.rpc.mockImplementation((fn: string) => Promise.resolve(answers[fn] ?? { data: null, error: null }));
};

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  h.rpc.mockReset();
  h.toast.success.mockReset();
  h.tables = { partner_self_plan_claims: [], profiles: [] };
  setAnswers();
});

const openDrawer = async () => {
  wrap(<FundersDashboard board={false} />);
  const name = await screen.findAllByRole('button', { name: /Open the plan for Amina Nakato/ });
  fireEvent.click(name[0]);
  return screen.findByRole('dialog', { name: `Rent Plan ${refText(ID)}` });
};

describe('helpers', () => {
  it('Ref is the first 8 of the id, upper case', () => {
    expect(refText(ID)).toBe('Ref 3FA85F64');
  });
  it('what funders see uses the card’s pay(rent) and its fallbacks', () => {
    const f = { houseCategory: 'Self-contained', city: 'Kampala', rentAmount: 650000, requestKind: null, incomplete: null };
    expect(funderLine(f, (r) => Math.round(r * 1.05))).toBe('Self-contained in Kampala · UGX 682,500');
    expect(funderLine({ ...f, houseCategory: null, city: null }, (r) => r)).toBe('House in Uganda · UGX 650,000');
  });
  it('a confirmed pick wins over a hold; a lapsed hold is no pick', () => {
    const now = Date.parse('2026-11-12T08:00:00Z');
    expect(pickFrom([{ status: 'held', partner_id: 'p1', claimed_at: 'a', expires_at: '2026-11-12T07:00:00Z' }], now)).toBeNull();
    expect(pickFrom([{ status: 'held', partner_id: 'p1', claimed_at: 'a', expires_at: '2026-11-12T09:00:00Z' }, { status: 'confirmed', partner_id: 'p2', claimed_at: 'b', confirmed_at: 'c' }], now)).toMatchObject({ partnerId: 'p2', status: 'confirmed', at: 'c' });
  });
  it('Recall: only with demote rights and money still with the agent', () => {
    expect(canRecall(true, 'with_agent')).toBe(true);
    expect(canRecall(false, 'with_agent')).toBe(false);
    expect(canRecall(true, 'part_paid')).toBe(false);
    expect(canRecall(true, 'live')).toBe(false);
    expect(canRecall(true, undefined)).toBe(false);
  });
  it('Recall reasons, levels and words', () => {
    expect(RECALL_REASONS.map((r) => r.code)).toEqual(['FB_PHOTOS_POOR', 'FB_DETAILS_WRONG', 'FB_NOT_QUALIFIED', 'FB_NOT_AVAILABLE', 'FB_DUPLICATE']);
    expect(RECALL_LEVELS.map((l) => [l.value, l.label])).toEqual([
      ['board', 'Keep on funders board'], ['coo', 'COO desk'], ['landlord_ops', 'Landlord Ops'], ['tenant_ops', 'Tenant Ops'],
      ['agent_ops', 'Agent Ops'], ['service_centre', 'Service Centre'], ['reject', 'Reject'],
    ]);
    expect(recallConfirmText(650000, 'Paul Okello', 'Jane Funder')).toBe("Take UGX 650,000 back from Paul Okello's landlord float and refund Jane Funder's wallet?");
    expect(recallToastText({ floatRecalled: 650000, funderRefunded: 682500 })).toBe('Recalled: UGX 650,000 back, funder refunded UGX 682,500');
  });
});

describe('the row', () => {
  it('shows Ref and, under the rent, what funders see (rent + fee)', async () => {
    wrap(<FundersDashboard board={false} />);
    expect((await screen.findAllByText('Ref 3FA85F64')).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getAllByText('Self-contained in Kampala · UGX 682,500').length).toBeGreaterThan(0));
  });
});

describe('the plan drawer', () => {
  it('a tap anywhere on the row opens it; Escape closes it', async () => {
    const { container } = wrap(<FundersDashboard board={false} />);
    await screen.findAllByText('Ref 3FA85F64');
    const row = container.querySelector(`[data-row="${ID}"]`) as HTMLElement;
    fireEvent.click(row.querySelector('[data-ref]') as HTMLElement);
    expect(await screen.findByRole('dialog', { name: 'Rent Plan Ref 3FA85F64' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rent Plan Ref 3FA85F64' })).toBeNull());
  });

  it('opens on a tap with people and phones, kind, missing, pick, money and desk history; read-only', async () => {
    const d = await openDrawer();
    const w = within(d);
    expect(w.getByText('Ref 3FA85F64')).toBeTruthy();
    await w.findByText('0700111222');
    expect(w.getByText('0700333444')).toBeTruthy();
    expect(w.getByText('0772000001')).toBeTruthy();
    expect(d.querySelector('[data-kind="renewal"]')).toBeTruthy();
    expect(w.getByText('Missing: family size')).toBeTruthy();
    expect(w.getByText('Self-contained in Kampala · UGX 682,500')).toBeTruthy();
    expect(await w.findByText('No funder has picked this yet.')).toBeTruthy();
    expect(await w.findByText(/Not released/)).toBeTruthy();
    expect(d.querySelectorAll('[data-house-photos] img')).toHaveLength(2);
    expect(await w.findByText('Open the LC1 letter')).toBeTruthy();
    expect(d.querySelector('[data-identity-photos]')).toBeTruthy();
    expect(d.querySelector('[data-plan-history]')).toBeTruthy();
    expect(w.queryByRole('button', { name: 'Recall' })).toBeNull();
    // Nothing writes while just looking.
    expect(h.rpc.mock.calls.map((c) => c[0])).not.toContain('funded_recall');
  });

  it('when the review sheet refuses, the people come from the tables the CFO may read', async () => {
    setAnswers({ pipeline_review_sheet: { data: null, error: { code: '42501', message: 'This desk is not assigned to you (HR: People → Desks)' } } });
    h.tables = {
      rent_requests: [{ id: ID, tenant_id: 't', agent_id: 'a', assigned_agent_id: null, landlord_id: 'l', lc1_id: null, lc_letter_path: null, house_image_urls: ['https://img.test/h1.jpg'] }],
      profiles: [{ id: 't', full_name: 'Amina Nakato', phone: '0700111222' }, { id: 'a', full_name: 'Paul Okello', phone: '0700333444' }],
      landlords: [{ id: 'l', name: 'Grace L', phone: '0772000001', verified: false }],
      partner_self_plan_claims: [],
    };
    const d = await openDrawer();
    expect(await within(d).findByText('0700111222')).toBeTruthy();
    expect(within(d).getByText('0700333444')).toBeTruthy();
    expect(within(d).getByText('No LC1 letter on file.')).toBeTruthy();
  });

  it('a funder’s pick shows who and when; the money stage shows the chip', async () => {
    h.tables = {
      partner_self_plan_claims: [{ partner_id: 'p9', status: 'confirmed', claimed_at: '2026-11-11T06:00:00Z', confirmed_at: '2026-11-11T07:00:00Z' }],
      profiles: [{ id: 'p9', full_name: 'Jane Funder' }],
    };
    setAnswers({ funded_money_flow: { data: flow('part_paid'), error: null } });
    const d = await openDrawer();
    expect(await within(d).findByText('Jane Funder')).toBeTruthy();
    expect(d.querySelector('[data-funder-pick="confirmed"]')?.textContent).toMatch(/^Picked by Jane Funder · /);
    expect(await within(d).findByText('Part paid')).toBeTruthy();
  });
});

describe('Recall (E86)', () => {
  const ready = async () => {
    h.tables = {
      partner_self_plan_claims: [{ partner_id: 'p9', status: 'confirmed', claimed_at: '2026-11-11T06:00:00Z', confirmed_at: '2026-11-11T07:00:00Z' }],
      profiles: [{ id: 'p9', full_name: 'Jane Funder' }],
    };
    setAnswers({ funders_board_can_demote: { data: true, error: null }, funded_money_flow: { data: flow('with_agent'), error: null } });
    const d = await openDrawer();
    await within(d).findByText('Jane Funder');
    fireEvent.click(await within(d).findByRole('button', { name: 'Recall' }));
    const sheet = await screen.findByRole('dialog', { name: 'Recall this funded tenant' });
    return within(sheet);
  };

  it('is hidden without demote rights, and once the landlord is paid', async () => {
    setAnswers({ funders_board_can_demote: { data: true, error: null }, funded_money_flow: { data: flow('live'), error: null } });
    const d = await openDrawer();
    await within(d).findByText('LIVE');
    expect(within(d).queryByRole('button', { name: 'Recall' })).toBeNull();
  });

  it('needs a reason and a 10+ character note; confirm names amount, agent and funder; calls funded_recall', async () => {
    const s = await ready();
    const go = s.getByRole('button', { name: 'Recall…' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(s.getByRole('button', { name: /Photos not good enough/ }));
    fireEvent.change(s.getByPlaceholderText('What went wrong with this funding'), { target: { value: 'short' } });
    expect(go.disabled).toBe(true);
    fireEvent.change(s.getByPlaceholderText('What went wrong with this funding'), { target: { value: 'House photos were of a different house' } });
    fireEvent.click(s.getByRole('button', { name: 'Tenant Ops' }));
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    expect(s.getByText("Take UGX 650,000 back from Paul Okello's landlord float and refund Jane Funder's wallet?")).toBeTruthy();

    answers.funded_recall = { data: { ok: true, float_recalled: 650000, funder_refunded: 682500 }, error: null };
    await act(async () => {
      fireEvent.click(s.getByRole('button', { name: 'Yes, recall' }));
    });
    expect(h.rpc).toHaveBeenCalledWith('funded_recall', {
      p_rent_request_id: ID, p_reason_code: 'FB_PHOTOS_POOR', p_note: 'House photos were of a different house', p_level: 'tenant_ops',
    });
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Recalled: UGX 650,000 back, funder refunded UGX 682,500'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Recall this funded tenant' })).toBeNull());
  });

  it('shows the server’s refusal word for word and keeps the sheet open', async () => {
    const s = await ready();
    fireEvent.click(s.getByRole('button', { name: /Same house listed/ }));
    fireEvent.change(s.getByPlaceholderText('What went wrong with this funding'), { target: { value: 'Listed twice by the agent' } });
    fireEvent.click(s.getByRole('button', { name: 'Recall…' }));
    const refusal = 'RECALL_LANDLORD_PAID: the agent has already paid the landlord (fully or partly) — this is a recovery case, not a recall';
    answers.funded_recall = { data: null, error: { code: 'P0001', message: refusal } };
    await act(async () => {
      fireEvent.click(s.getByRole('button', { name: 'Yes, recall' }));
    });
    expect(await s.findByText(refusal)).toBeTruthy();
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.rpc.mock.calls.find((c) => c[0] === 'funded_recall')?.[1]).toMatchObject({ p_level: 'board', p_reason_code: 'FB_DUPLICATE' });
  });

  it('the drawer reuses Op 5’s DeskHistory unchanged, and the only write is the funded_recall RPC', () => {
    const drawer = readFileSync(resolve(__dirname, '../FundersPlanDrawer.tsx'), 'utf8');
    expect(drawer).toContain("import { DeskHistory, when } from '../deskHistory'");
    const api = readFileSync(resolve(__dirname, '../planDrawerApi.ts'), 'utf8');
    expect(api).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    expect(api).toContain("rpc('funded_recall'");
  });
});
