import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * Staff who are also agents see their own requests on the desks. The server
 * refuses a decision on them, so the desks show them read-only with a grey note.
 */

const ME = 'staff-agent-1';
const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), message: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: h.toast }));
const fromChain = { select: () => fromChain, eq: () => fromChain, in: () => fromChain, order: () => Promise.resolve({ data: [], error: null }) };
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...a: unknown[]) => h.rpc(...a),
    from: () => fromChain,
    storage: { from: () => ({ upload: vi.fn(), createSignedUrl: async () => ({ data: null, error: null }) }) },
  },
}));
vi.mock('@/hooks/useIdentityPhotos', () => ({ identityPhotoUrl: async () => null }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'staff-agent-1' }, roles: ['agent_ops', 'agent'] }) }));
vi.mock('@/hooks/useCrmVoiceCall', () => ({
  useCrmVoiceCall: () => ({ state: 'idle', callId: null, elapsed: 0, error: null, isEnding: false, start: vi.fn(), end: vi.fn() }),
  useHumanCallingPaused: () => ({ data: { paused: false, reason: null, paused_at: null } }),
  isTerminalCallState: () => false,
}));
vi.mock('@/components/coo/CooReasonPicker', () => ({
  useCooReasonPicker: () => ({ picker: null, askReason: vi.fn(), meaningOf: () => null }),
  useCooReasonCodes: () => ({ data: [], isLoading: false }),
}));

import { ReadyBoard } from '../ReadyBoard';
import { ReviewDrawer } from '../ReviewDrawer';
import { ReviewStatusProvider } from '../reviewStatus';
import { asIs } from '../deskActions';
import { readableError } from '../reviewApi';
import { plainError } from '../arrears/arrearsApi';
import { OWN_REQUEST_NOTE, isOwnRequest } from '../ownRequest';
import type { BoardRow } from '../boardApi';
import { shortPrimary } from '../boardRowModel';

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
afterEach(() => setWidth(1024));
beforeEach(() => setWidth(1280));

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ReviewStatusProvider>{ui}</ReviewStatusProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

function row(over: Partial<BoardRow>): BoardRow {
  return {
    id: 'r1', req: 'r1', tenant: 'Tina', tenant_id: 't1', tenant_phone: null, agent_id: 'a1', agent: 'Andy', agent_phone: null,
    agent_grade: 'B', agent_grade_week_ago: null, agent_flags: [], landlord: 'Lucy', landlord_phone: null, rent: 500000, days_here: 1,
    rating: null, flags: { passes: 5, total: 5, hard_fail: false, soft_fail: false, failing: [], notes: [], flags: [] },
    decision: 'pass', rule_id: null, why: 'All checks pass', receiver: null, waiting: null, wait_suggest: null,
    push: { decision: 'pass', results: [], reason_code: null, note: null, target_agent_id: null }, call: null,
    ...over,
  };
}

type Answer = { data?: unknown; error?: unknown };
function serve(answers: Record<string, Answer>) {
  h.rpc.mockReset();
  h.rpc.mockImplementation((fn: string) => Promise.resolve({ data: null, error: null, ...(answers[fn] ?? {}) }));
}

const ROWS = [
  row({ id: 'own', req: 'own', tenant: 'Ian Own Tenant', agent_id: ME, agent: 'Ian Muhwezi' }),
  row({ id: 'other', req: 'other', tenant: 'Olga Other', agent_id: 'a2', agent: 'Ann' }),
];
const rowEl = (id: string) => document.querySelector(`[data-row="${id}"]`) as HTMLElement;

describe('Agent Ops board: own request', () => {
  it.each([1280, 375])('%i px: own request — no action buttons and the note; someone else’s — actions as now', async (w) => {
    setWidth(w);
    serve({ pipeline_desk_board: { data: { stage: 'agent_ops', can_act: true, counts: { pass: 2 }, rows: ROWS } } });
    wrap(<ReadyBoard stage="agent_ops" board={false} onOpen={() => {}} />);
    await screen.findByText('Ian Own Tenant');
    const own = rowEl('own');
    expect(own.querySelector('[data-own-request]')?.textContent).toBe(OWN_REQUEST_NOTE);
    expect(within(own).queryByRole('button', { name: /Forward|Pass|Send back|Push|Transfer|Retry/ })).toBeNull();
    // Read-only, not hidden: the row and its review stay.
    fireEvent.click(within(own).getByRole('button', { name: 'More for Ian Own Tenant' }));
    const menu = screen.getByRole('dialog', { name: 'More for Ian Own Tenant' });
    expect(within(menu).getAllByRole('button').map((b) => b.textContent?.trim()).filter((t) => t && t !== 'Close')).toEqual(['Open the review']);
    fireEvent.keyDown(document, { key: 'Escape' });

    const other = rowEl('other');
    expect(other.querySelector('[data-own-request]')).toBeNull();
    const label = shortPrimary(ROWS[1], 'agent_ops')!.label;
    expect(within(other).getByRole('button', { name: label })).toBeEnabled();
    // The same button is not on the own row.
    expect(within(own).queryByRole('button', { name: label })).toBeNull();
    // "Push all" counts only the request this officer may decide.
    expect(screen.getByRole('button', { name: /Push all 1 ·/ })).toBeTruthy();
  });
});

const sheet = (agentId: string | null) => ({
  data: {
    request: {
      id: 'q1', status: 'pending', stage: 'agent_ops', round: 0, rent_amount: 500000, duration_days: 30, created_at: '2026-11-01',
      tenant: { id: 't1', name: 'Ivy', phone: null, occupation: null }, agent: agentId ? { id: agentId, name: 'Ian Muhwezi', phone: null } : null,
      landlord: null, lc1: null, lc_letter: null, house_photos: [], gps: null, funder_visible: true,
    },
    checklist: [], history: [], score: null, recommendation: { recommended: 'pass', reason_code: null, failed: [] }, can_review: true, my_staff_ref: 'E',
  },
});

describe('the review drawer', () => {
  it('own request: "Your decision" holds only the note — no Pass, Send back or Push', async () => {
    serve({ pipeline_review_sheet: sheet(ME) });
    wrap(<ReviewDrawer stage="agent_ops" requestId="q1" onClose={() => {}} />);
    const panel = (await screen.findByRole('heading', { name: 'Your decision' })).closest('section') as HTMLElement;
    expect(panel.querySelector('[data-own-request]')?.textContent).toBe(OWN_REQUEST_NOTE);
    expect(within(panel).queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Record the review and act' })).toBeNull();
  });

  it('someone else’s request: the decisions as now', async () => {
    serve({ pipeline_review_sheet: sheet('a2') });
    wrap(<ReviewDrawer stage="agent_ops" requestId="q1" onClose={() => {}} />);
    const panel = (await screen.findByRole('heading', { name: 'Your decision' })).closest('section') as HTMLElement;
    expect(panel.querySelector('[data-own-request]')).toBeNull();
    expect(within(panel).getByRole('button', { name: /^Pass/ })).toBeTruthy();
  });
});

describe('the server refusal, if it still happens, in plain words', () => {
  const refusal = { code: '42501', message: 'You cannot decide on a request you registered or are assigned to' };
  it('every desk error helper says it the same way', () => {
    expect(asIs(refusal)).toBe(OWN_REQUEST_NOTE);
    expect(readableError(refusal)).toBe(OWN_REQUEST_NOTE);
    expect(plainError(refusal)).toBe(OWN_REQUEST_NOTE);
    // Anything else is unchanged.
    expect(asIs({ message: 'Request is at "coo_approved", not at the coo desk' })).toBe('Request is at "coo_approved", not at the coo desk');
  });

  it('who counts as the agent', () => {
    expect(isOwnRequest(ME, ME)).toBe(true);
    expect(isOwnRequest(ME, null, ME)).toBe(true);
    expect(isOwnRequest(ME, 'a2')).toBe(false);
    expect(isOwnRequest(null, null)).toBe(false);
    expect(isOwnRequest(undefined, undefined)).toBe(false);
  });
});
