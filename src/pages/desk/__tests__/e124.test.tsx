import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/** E124: fake-request flags on Agent Ops; the face-photo FLAG on Tenant Ops; unassigned Service Centre requests on the desk. */

const h = vi.hoisted(() => ({ rpc: vi.fn() }));
const fromChain = { select: () => fromChain, eq: () => fromChain, in: () => fromChain, order: () => Promise.resolve({ data: [], error: null }) };
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...a: unknown[]) => h.rpc(...a),
    from: () => fromChain,
    storage: { from: () => ({ createSignedUrl: (p: string) => Promise.resolve({ data: { signedUrl: `https://signed/${p}` }, error: null }) }) },
  },
}));
vi.mock('@/hooks/useIdentityPhotos', () => ({ identityPhotoUrl: async (p: string | null) => (p ? `https://signed/identity/${p}` : null) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: ['tenant_ops'] }) }));
vi.mock('@/hooks/useCrmVoiceCall', () => ({
  useCrmVoiceCall: () => ({ state: 'idle', callId: null, elapsed: 0, error: null, isEnding: false, start: vi.fn(), end: vi.fn() }),
  useHumanCallingPaused: () => ({ data: { paused: false, reason: null, paused_at: null } }),
  isTerminalCallState: () => false,
}));
vi.mock('@/components/coo/CooReasonPicker', () => ({
  useCooReasonPicker: () => ({ picker: null, askReason: vi.fn(), meaningOf: () => null }),
  useCooReasonCodes: () => ({ data: [], isLoading: false }),
}));

import { FakeRequestFlagsCard } from '../fakeFlags';
import { facePhotoFlag } from '../photoFlag';
import { ReviewDrawer } from '../ReviewDrawer';
import { ReadyBoard } from '../ReadyBoard';
import { ReviewStatusProvider } from '../reviewStatus';
import type { BoardRow } from '../boardApi';
import type { Stage } from '../reviewTypes';

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
afterEach(() => setWidth(1024));
beforeEach(() => h.rpc.mockReset());

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ReviewStatusProvider>{ui}</ReviewStatusProvider>
    </QueryClientProvider>,
  );

/* ───────────── 1. Fake-request flags ───────────── */

describe('Agent Ops · Fake-request flags', () => {
  it('each flagged agent: name, Call, how many fakes, posted in the window, last fake', async () => {
    h.rpc.mockResolvedValue({
      data: {
        rule: 'FAKE-FLAG (E124 D3): …',
        agents: [
          { agent_id: 'a1', name: 'Paul Okello', phone: '0700123456', fakes: 5, last_at: '2026-11-15T09:00:00Z', posted_in_window: 9 },
          { agent_id: 'a2', name: 'Grace A', phone: null, fakes: 3, last_at: '2026-11-10T09:00:00Z', posted_in_window: 3 },
        ],
      },
      error: null,
    });
    wrap(<FakeRequestFlagsCard board={false} />);
    const a1 = await waitFor(() => {
      const el = document.querySelector('[data-fake-agent="a1"]') as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    expect(h.rpc).toHaveBeenCalledWith('fake_request_flags', { p_days: 30, p_min: 3 });
    expect(within(a1).getByRole('link', { name: 'Call agent Paul Okello' }).getAttribute('href')).toBe('tel:0700123456');
    expect(a1.textContent).toContain('5 fake');
    expect(a1.textContent).toContain('9 posted in 30 days');
    expect(a1.textContent).toContain('last 15 Nov 2026');
    expect(document.querySelector('[data-fake-agent="a2"]')?.textContent).toContain('No phone');
  });

  it('hidden when nobody is flagged, and for a viewer the server refuses', async () => {
    h.rpc.mockResolvedValue({ data: { agents: [] }, error: null });
    const a = wrap(<FakeRequestFlagsCard board={false} />);
    await waitFor(() => expect(h.rpc).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(a.container.querySelector('[aria-label="Fake-request flags"]')).toBeNull();
    a.unmount();
    h.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'FAKE_FLAGS_DENIED' } });
    const b = wrap(<FakeRequestFlagsCard board={false} />);
    await new Promise((r) => setTimeout(r, 1200));
    expect(b.container.textContent).toBe('');
  });

  it('sits on the Agent Ops desk', () => {
    const page = readFileSync(resolve(__dirname, '../DeskPage.tsx'), 'utf8');
    expect(page).toContain("{desk.id === 'agent-ops' && <FakeRequestFlagsCard board={board} />}");
  });
});

/* ───────────── 2. The face-photo FLAG on Tenant Ops ───────────── */

const CHECK = (detail: string | null) => ({
  code: 'to_passport_is_tenant', stage: 'tenant_ops', label: 'Passport photo is the TENANT', question: 'Is the photo the tenant?', method: 'judgement', weight: 1,
  required: true, on_fail: 'send_back', value_kind: null, assumption: null, system_said: detail ? 'warn' : null, system_detail: detail, last: null,
});
const SHEET = (stage: Stage, detail: string | null) => ({
  request: {
    id: 'r1', status: 'x', stage, round: 0, rent_amount: 700000, duration_days: 30, created_at: '2026-11-01',
    tenant: { id: 't1', name: 'Odenyo Elly', phone: null, occupation: null }, agent: { id: 'a1', name: 'Andy Agent', phone: null },
    landlord: { id: 'l1', name: 'Lucy', phone: null, verified: true }, lc1: null, lc_letter: null, house_photos: [], gps: null, funder_visible: true,
  },
  checklist: [CHECK(detail)], history: [], score: null, recommendation: null, can_review: true, my_staff_ref: 'E',
});
const serveDrawer = (stage: Stage, detail: string | null) =>
  h.rpc.mockImplementation((fn: string) => {
    if (fn === 'pipeline_review_sheet') return Promise.resolve({ data: SHEET(stage, detail), error: null });
    if (fn === 'request_identity_photos') return Promise.resolve({ data: { tenant: { name: 'Odenyo Elly', passport_photo_url: null, id_front: null, id_back: null }, agent: null, flags: {} }, error: null });
    if (/_list$|_calls$|waiting_list|concerns/.test(fn)) return Promise.resolve({ data: [], error: null });
    return Promise.resolve({ data: null, error: null });
  });

describe('Tenant Ops · the face-photo FLAG', () => {
  it('the flag from the system detail, from "FLAG:" on', () => {
    expect(facePhotoFlag([CHECK("Matched by fingerprint. FLAG: the tenant photo is the agent's own profile photo")] as never)).toBe(
      "FLAG: the tenant photo is the agent's own profile photo",
    );
    expect(facePhotoFlag([CHECK('Looks fine')] as never)).toBeNull();
    expect(facePhotoFlag([])).toBeNull();
  });

  it('a red warning line above the photos', async () => {
    setWidth(1280);
    serveDrawer('tenant_ops', "FLAG: the tenant photo is the agent's own profile photo");
    wrap(<ReviewDrawer stage="tenant_ops" requestId="r1" onClose={() => {}} />);
    const flag = await screen.findByText("FLAG: the tenant photo is the agent's own profile photo");
    expect(flag.getAttribute('role')).toBe('alert');
    expect(flag.hasAttribute('data-photo-flag')).toBe(true);
    const panel = await screen.findByRole('region', { name: 'Identity photos' });
    expect(flag.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('no line without a FLAG', async () => {
    setWidth(1280);
    serveDrawer('tenant_ops', 'Same face as the ID');
    wrap(<ReviewDrawer stage="tenant_ops" requestId="r1" onClose={() => {}} />);
    await screen.findByRole('region', { name: 'Identity photos' });
    expect(document.querySelector('[data-photo-flag]')).toBeNull();
  });
});

/* ───────────── 3. Unassigned Service Centre requests ───────────── */

const scRow = (id: string, tenant: string): BoardRow => ({
  id, req: id.slice(0, 8), tenant, tenant_id: null, tenant_phone: null, agent_id: 'a1', agent: 'Andy', agent_phone: null,
  agent_grade: null, agent_grade_week_ago: null, agent_flags: [], landlord: null, landlord_phone: null, rent: 400000, days_here: 1,
  rating: null, flags: { passes: 4, total: 4, hard_fail: false, soft_fail: false, failing: [], notes: [], flags: [] },
  decision: 'pass', rule_id: 'SC-1', why: 'items complete', receiver: null, waiting: null, wait_suggest: null,
  push: { decision: 'pass', results: [], reason_code: null, note: 'SC-1', target_agent_id: null }, call: null,
});

describe('Service Centre desk · requests with no named manager', () => {
  it('the desk shows every request the server returns, the unassigned ones included (no manager filter on the page)', async () => {
    setWidth(1280);
    const store = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: () => {}, clear: () => store.clear(), key: () => null, length: 0 },
    });
    // As the live board answers Service Centre staff: two requests with no manager, one with.
    h.rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'pipeline_desk_board'
          ? { data: { stage: 'service_centre', can_act: true, staff_ref: 'E', sc_only: false, counts: { pass: 3 }, scope: 'new', scope_counts: { new: 3, batch: 0 }, rows: [scRow('3b8965f9-x', 'Unassigned One'), scRow('333c87cf-x', 'Unassigned Two'), scRow('9b483db5-x', 'Named Manager')] }, error: null }
          : { data: null, error: null },
      ),
    );
    wrap(<ReadyBoard stage="service_centre" board={false} onOpen={() => {}} />);
    expect(await screen.findByText('Unassigned One')).toBeTruthy();
    expect(screen.getByText('Unassigned Two')).toBeTruthy();
    expect(screen.getByText('Named Manager')).toBeTruthy();
    expect(h.rpc).toHaveBeenCalledWith('pipeline_desk_board', { p_stage: 'service_centre', p_limit: 300, p_scope: 'new' });
  });
});
