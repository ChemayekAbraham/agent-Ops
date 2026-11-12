import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/** E89: send an incomplete request back to Agent Ops, the Service Centre or the agent. */

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), message: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: h.toast }));
const fromChain = { select: () => fromChain, eq: () => fromChain, in: () => fromChain, order: () => Promise.resolve({ data: [], error: null }) };
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => h.rpc(...a), from: () => fromChain, storage: { from: () => ({ upload: vi.fn(), createSignedUrl: async () => ({ data: null, error: null }) }) } },
}));
vi.mock('@/hooks/useIdentityPhotos', () => ({ identityPhotoUrl: async () => null }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'staff-1' }, roles: ['agent_ops'] }) }));
vi.mock('@/hooks/useCrmVoiceCall', () => ({
  useCrmVoiceCall: () => ({ state: 'idle', callId: null, elapsed: 0, error: null, isEnding: false, start: vi.fn(), end: vi.fn() }),
  useHumanCallingPaused: () => ({ data: { paused: false, reason: null, paused_at: null } }),
  isTerminalCallState: () => false,
}));
vi.mock('@/components/coo/CooReasonPicker', () => ({
  useCooReasonPicker: () => ({ picker: null, askReason: vi.fn(), meaningOf: () => null }),
  useCooReasonCodes: () => ({ data: [], isLoading: false }),
}));

import { IncompleteSection, SendBackIncompleteSheet } from '../incomplete';
import { ReadyBoard } from '../ReadyBoard';
import { CooBoard, type CooRow } from '../CooBoard';
import { ReviewStatusProvider } from '../reviewStatus';
import type { BoardRow } from '../boardApi';

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
afterEach(() => setWidth(1024));

const wrap = (ui: ReactNode, qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) =>
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ReviewStatusProvider>{ui}</ReviewStatusProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

const MISSING = ['photo review (3+ approved, main photo)', 'family size'];
const MISSING_TEXT = 'Missing: photo review (3+ approved, main photo), family size';

type Answer = { data?: unknown; error?: unknown };
function serve(answers: Record<string, Answer>) {
  h.rpc.mockReset();
  h.rpc.mockImplementation((fn: string) => Promise.resolve({ data: null, error: null, ...(answers[fn] ?? {}) }));
}
const calls = (fn: string) => h.rpc.mock.calls.filter((c) => c[0] === fn);

beforeEach(() => {
  setWidth(1280);
  h.toast.success.mockReset();
});

describe('the send-back sheet', () => {
  it('three targets with the suggestion picked, an optional note, a confirm line; then one call and a toast', async () => {
    serve({ pipeline_send_back_incomplete: { data: { ok: true, sent_to: 'the Service Centre', status_now: 'service_center_review' } } });
    const onDone = vi.fn();
    const onClose = vi.fn();
    wrap(<SendBackIncompleteSheet requestId="r1" tenant="Ivy" missing={MISSING} suggest="service_centre" onDone={onDone} onClose={onClose} />);
    const sheet = screen.getByRole('dialog', { name: 'Send back Ivy' });
    const targets = within(sheet).getAllByRole('radio');
    expect(targets.map((t) => t.getAttribute('data-target'))).toEqual(['agent_ops', 'service_centre', 'agent']);
    expect(sheet.querySelector('[data-target="service_centre"]')?.getAttribute('aria-checked')).toBe('true');
    expect(sheet.querySelector('[data-target="service_centre"]')?.textContent).toContain('suggested');
    expect(sheet.querySelector('[data-confirm-line]')?.textContent).toBe(`Send back to Service Centre? ${MISSING_TEXT}`);

    fireEvent.click(within(sheet).getByRole('radio', { name: 'Agent' }));
    expect(sheet.querySelector('[data-confirm-line]')?.textContent).toBe(`Send back to Agent? ${MISSING_TEXT}`);
    fireEvent.click(within(sheet).getByRole('radio', { name: /Service Centre/ }));
    fireEvent.change(within(sheet).getByRole('textbox'), { target: { value: 'LC1 letter is the wrong village' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Send back to Service Centre' }));

    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Sent back to the Service Centre'));
    expect(calls('pipeline_send_back_incomplete')).toEqual([
      ['pipeline_send_back_incomplete', { p_request_id: 'r1', p_to: 'service_centre', p_note: 'LC1 letter is the wrong village' }],
    ]);
    expect(onDone).toHaveBeenCalledWith('Sent back to the Service Centre');
    expect(onClose).toHaveBeenCalled();
  });

  it('no suggestion: Agent Ops; an empty note goes as null; a refusal is shown as-is', async () => {
    const refusal = 'Requests on the funders board are sent back by the COO or CEO only';
    serve({ pipeline_send_back_incomplete: { error: { code: '42501', message: refusal } } });
    wrap(<SendBackIncompleteSheet requestId="r2" tenant="Bo" missing={['family size']} onClose={() => {}} />);
    const sheet = screen.getByRole('dialog', { name: 'Send back Bo' });
    expect(sheet.querySelector('[data-target="agent_ops"]')?.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Send back to Agent Ops' }));
    expect((await within(sheet).findByRole('alert')).textContent).toBe(refusal);
    expect(calls('pipeline_send_back_incomplete')[0][1]).toEqual({ p_request_id: 'r2', p_to: 'agent_ops', p_note: null });
    expect(h.toast.success).not.toHaveBeenCalled();
  });
});

const QUEUE = {
  count: 3,
  by_desk: { tenant_ops: 1, landlord_ops: 0, coo: 1, funders_board: 1 },
  items: [
    { id: 'q1', short_id: 'q1q1q1q1', desk: 'Tenant Ops', tenant: 'Ivy Incomplete', agent: 'Andy', rent: 500000, missing: MISSING, suggest_send_to: 'agent', status: 'agent_ops_approved' },
    { id: 'q2', short_id: 'q2q2q2q2', desk: 'COO', tenant: 'Cara Coo', agent: 'Ann', rent: 700000, missing: ['family size'], suggest_send_to: 'agent_ops', status: 'partner_ops_approved' },
    { id: 'q3', short_id: 'q3q3q3q3', desk: 'Funders board', tenant: 'Fred Board', agent: 'Ann', rent: 900000, missing: ['family size'], suggest_send_to: 'agent_ops', status: 'coo_approved' },
  ],
};

describe('Agent Ops "Complete missing items": Send back on each row', () => {
  it('opens the sheet with the row’s suggestion; the funders-board row only for someone who may take it off', async () => {
    serve({ pipeline_incomplete_queue: { data: QUEUE }, funders_board_can_demote: { data: false } });
    wrap(<IncompleteSection board={false} />);
    await screen.findByText(/Ivy Incomplete/);
    await waitFor(() => expect(calls('funders_board_can_demote')).toHaveLength(1));
    const row = (id: string) => document.querySelector(`[data-incomplete="${id}"]`) as HTMLElement;
    expect(within(row('q1q1q1q1')).getByRole('button', { name: 'Send back…' })).toBeTruthy();
    expect(within(row('q2q2q2q2')).getByRole('button', { name: 'Send back…' })).toBeTruthy();
    expect(within(row('q3q3q3q3')).queryByRole('button', { name: 'Send back…' })).toBeNull();

    fireEvent.click(within(row('q1q1q1q1')).getByRole('button', { name: 'Send back…' }));
    const sheet = screen.getByRole('dialog', { name: 'Send back Ivy Incomplete' });
    expect(sheet.querySelector('[data-target="agent"]')?.getAttribute('aria-checked')).toBe('true');
  });

  it('a COO / CEO who may demote sees it on the funders-board row too', async () => {
    serve({ pipeline_incomplete_queue: { data: QUEUE }, funders_board_can_demote: { data: true } });
    wrap(<IncompleteSection board={false} />);
    await screen.findByText(/Fred Board/);
    await waitFor(() =>
      expect(within(document.querySelector('[data-incomplete="q3q3q3q3"]') as HTMLElement).getByRole('button', { name: 'Send back…' })).toBeTruthy(),
    );
  });

  it('on success: toast "Sent back to {sent_to}" and the list refetches', async () => {
    serve({
      pipeline_incomplete_queue: { data: QUEUE },
      funders_board_can_demote: { data: false },
      pipeline_send_back_incomplete: { data: { ok: true, sent_to: 'the agent' } },
    });
    wrap(<IncompleteSection board={false} />);
    await screen.findByText(/Ivy Incomplete/);
    const before = calls('pipeline_incomplete_queue').length;
    fireEvent.click(within(document.querySelector('[data-incomplete="q1q1q1q1"]') as HTMLElement).getByRole('button', { name: 'Send back…' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Send back Ivy Incomplete' })).getByRole('button', { name: 'Send back to Agent' }));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Sent back to the agent'));
    await waitFor(() => expect(calls('pipeline_incomplete_queue').length).toBeGreaterThan(before));
  });
});

function row(over: Partial<BoardRow>): BoardRow {
  return {
    id: 'inc', req: 'inc', tenant: 'Ivy Incomplete', tenant_id: 't1', tenant_phone: null, agent_id: 'a1', agent: 'Andy', agent_phone: null,
    agent_grade: 'B', agent_grade_week_ago: null, agent_flags: [], landlord: 'Lucy', landlord_phone: null, rent: 500000, days_here: 1,
    rating: null, flags: { passes: 5, total: 5, hard_fail: false, soft_fail: false, failing: [], notes: [], flags: [] },
    decision: 'pass', rule_id: null, why: 'All checks pass', receiver: null, waiting: null, wait_suggest: null,
    push: { decision: 'pass', results: [], reason_code: null, note: null, target_agent_id: null }, call: null, incomplete: MISSING,
    ...over,
  };
}

describe('desk and COO rows: "Send back…" opens the same three-target sheet', () => {
  it('Landlord Ops row: sent back, toast, the card leaves the board', async () => {
    // Once sent back the request is no longer at this desk, so the refetched board leaves it out.
    let sent = false;
    h.rpc.mockReset();
    h.rpc.mockImplementation((fn: string) => {
      if (fn === 'pipeline_desk_board') return Promise.resolve({ data: { stage: 'landlord_ops', can_act: true, counts: { pass: sent ? 0 : 1 }, rows: sent ? [] : [row({})] }, error: null });
      if (fn === 'pipeline_send_back_incomplete') {
        sent = true;
        return Promise.resolve({ data: { ok: true, sent_to: 'Agent Ops' }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    wrap(<ReadyBoard stage="landlord_ops" board={false} onOpen={() => {}} />);
    await screen.findByText('Ivy Incomplete');
    fireEvent.click(screen.getByRole('button', { name: 'Send back…' }));
    const sheet = screen.getByRole('dialog', { name: 'Send back Ivy Incomplete' });
    expect(within(sheet).getAllByRole('radio')).toHaveLength(3);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Send back to Agent Ops' }));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Sent back to Agent Ops'));
    await waitFor(() => expect(document.querySelector('[data-row="inc"]')).toBeNull());
    expect(calls('pipeline_send_back_to')).toHaveLength(0);
  });

  it('COO row: the same sheet, the server call is pipeline_send_back_incomplete', async () => {
    const coo: CooRow = {
      id: 'c1', req: 'c1', tenant: 'Cara Coo', agent: 'Andy', agent_grade: 'B', landlord: 'L', landlord_verified: true, rent: 300000, days_here: 4.4,
      ratings: { agent_ops: 80, tenant_ops: null, landlord_ops: 60, average: 70, grade: 'B', partly_rated: false }, grade: 'A', avg: 80,
      flags: null, auto_forwarded: false, waiting: null, rank: 1, pushable: false, frozen: null, incomplete: ['family size'],
    };
    serve({ pipeline_coo_board: { data: { counts: {}, can_push: true, rows: [coo] } }, pipeline_send_back_incomplete: { data: { ok: true, sent_to: 'the Service Centre' } } });
    wrap(<CooBoard board={false} onOpen={() => {}} />);
    await screen.findByText('Cara Coo');
    fireEvent.click(screen.getByRole('button', { name: 'Send back…' }));
    const sheet = screen.getByRole('dialog', { name: 'Send back Cara Coo' });
    fireEvent.click(within(sheet).getByRole('radio', { name: 'Service Centre' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Send back to Service Centre' }));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Sent back to the Service Centre'));
    expect(calls('pipeline_send_back_incomplete')[0][1]).toMatchObject({ p_request_id: 'c1', p_to: 'service_centre' });
  });
});
