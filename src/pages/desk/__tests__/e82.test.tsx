import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * E82: requirements re-checked at Tenant Ops, Landlord Ops and the COO push.
 * The "Missing: …" chip and blocked Pass, the "Send back…"
 * shortcut, Agent Ops' "Complete missing items" and the count card.
 */

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  upload: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), message: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: h.toast }));
const fromChain = { select: () => fromChain, eq: () => fromChain, in: () => fromChain, order: () => Promise.resolve({ data: [], error: null }) };
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...a: unknown[]) => h.rpc(...a),
    from: () => fromChain,
    storage: {
      from: (bucket: string) => ({
        upload: (path: string, file: unknown, opts: unknown) => h.upload(bucket, path, file, opts),
        createSignedUrl: async () => ({ data: null, error: null }),
      }),
    },
  },
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

import { CompleteMissingSheet, IncompleteCard, IncompleteSection, attachDocument, missingText } from '../incomplete';
import { missingChip } from '../boardRowModel';
import { passBlock } from '../passBlock';
import { ReadyBoard } from '../ReadyBoard';
import { CooBoard, type CooRow } from '../CooBoard';
import { ReviewDrawer } from '../ReviewDrawer';
import { ReviewStatusProvider } from '../reviewStatus';
import type { BoardRow } from '../boardApi';
import type { Stage } from '../reviewTypes';

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
afterEach(() => setWidth(1024));

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ReviewStatusProvider>{ui}</ReviewStatusProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

const MISSING = ['photo review (3+ approved, main photo)', 'family size'];
const MISSING_TEXT = 'Missing: photo review (3+ approved, main photo), family size';
const OPTIONS = [
  { code: 'agent', label: 'Field agent (to correct)', hint: null },
  { code: 'service_centre', label: 'Service Centre', hint: null },
  { code: 'agent_ops', label: 'Agent Ops', hint: 'Agent, items or photos to be reviewed again' },
];

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

beforeEach(() => {
  setWidth(1280);
  h.upload.mockReset();
  h.upload.mockResolvedValue({ data: { path: 'x' }, error: null });
  h.toast.success.mockReset();
});

describe('the words', () => {
  it('"Missing: …" chip, red, first; nothing when nothing is missing', () => {
    expect(missingText(MISSING)).toBe(MISSING_TEXT);
    expect(missingText([])).toBeNull();
    expect(missingChip(MISSING)).toMatchObject({ key: 'missing', text: MISSING_TEXT, tone: 'bad', strong: true });
    expect(missingChip(null)).toBeNull();
  });
  it('the drawer’s Pass says what is missing before anything else', () => {
    expect(passBlock({ incomplete: MISSING, callDesk: 'landlord', callAnswered: false, items: [], entries: {}, against: false, reasonCode: '', noteRequired: false, note: '' })).toBe(MISSING_TEXT);
  });
});

describe('desk rows: Tenant Ops and Landlord Ops', () => {
  const rows = [row({ id: 'inc', tenant: 'Ivy Incomplete', incomplete: MISSING }), row({ id: 'ok', tenant: 'Olive Okay', incomplete: [] })];

  it.each(['tenant_ops', 'landlord_ops'] as Stage[])('%s: red chip first, Pass disabled with the list, the shortcut opens Send back on Agent Ops', async (stage) => {
    serve({ pipeline_desk_board: { data: { stage, can_act: true, counts: { pass: 2 }, rows } }, pipeline_send_back_options: { data: OPTIONS } });
    wrap(<ReadyBoard stage={stage} board={false} onOpen={() => {}} />);
    await screen.findByText('Ivy Incomplete');
    const inc = document.querySelector('[data-row="inc"]') as HTMLElement;
    const firstChip = inc.querySelector('[data-tone]') as HTMLElement;
    expect(firstChip.textContent).toBe(MISSING_TEXT);
    expect(firstChip.getAttribute('data-tone')).toBe('bad');
    const pass = within(inc).getByRole('button', { name: stage === 'tenant_ops' ? 'Forward to Landlord Ops' : 'Forward to COO' });
    expect(pass).toBeDisabled();
    expect(pass.getAttribute('title')).toBe(MISSING_TEXT);
    expect((inc.querySelector('[data-missing-line]') as HTMLElement).textContent).toContain(MISSING_TEXT);
    // The complete row is untouched.
    const ok = document.querySelector('[data-row="ok"]') as HTMLElement;
    expect(ok.querySelector('[data-missing-line]')).toBeNull();
    expect(within(ok).getByRole('button', { name: stage === 'tenant_ops' ? 'Forward to Landlord Ops' : 'Forward to COO' })).toBeEnabled();
    // "Push all" leaves the incomplete row out.
    expect(screen.getByRole('button', { name: /Push all 1 ·/ })).toBeTruthy();

    // E89: the shortcut opens the three-target send-back, Agent Ops picked.
    fireEvent.click(within(inc).getByRole('button', { name: 'Send back…' }));
    const sheet = await screen.findByRole('dialog', { name: 'Send back Ivy Incomplete' });
    expect(sheet.querySelector('[data-target="agent_ops"]')?.getAttribute('aria-checked')).toBe('true');
    expect(sheet.querySelector('[data-confirm-line]')?.textContent).toBe(`Send back to Agent Ops? ${MISSING_TEXT}`);
  });

  it('Agent Ops itself: the chip, but no shortcut back to itself', async () => {
    serve({ pipeline_desk_board: { data: { stage: 'agent_ops', can_act: true, counts: { pass: 1 }, rows: [rows[0]] } } });
    wrap(<ReadyBoard stage="agent_ops" board={false} onOpen={() => {}} />);
    await screen.findByText('Ivy Incomplete');
    expect(screen.getByText(MISSING_TEXT, { selector: '[data-tone]' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send back…' })).toBeNull();
  });

  it('the drawer opened from the row says what is missing, and Pass waits', async () => {
    const refusal = 'E82_INCOMPLETE: complete these first: photo review (3+ approved, main photo), family size';
    serve({
      pipeline_review_sheet: {
        data: {
          request: {
            id: 'inc', status: 'agent_ops_approved', stage: 'tenant_ops', round: 0, rent_amount: 500000, duration_days: 30, created_at: '2026-11-01',
            tenant: { id: 't1', name: 'Ivy', phone: null, occupation: null }, agent: null, landlord: null, lc1: null, lc_letter: null, house_photos: [], gps: null, funder_visible: true,
          },
          checklist: [], history: [], score: null, recommendation: { recommended: 'pass', reason_code: null, failed: [] }, can_review: true, my_staff_ref: 'E',
        },
      },
      pipeline_record_review: { error: { code: 'P0001', message: refusal } },
    });
    wrap(<ReviewDrawer stage="tenant_ops" requestId="inc" onClose={() => {}} ctx={{ incomplete: MISSING, callAnswered: true }} />);
    const panel = (await screen.findByRole('heading', { name: 'Your decision' })).closest('section') as HTMLElement;
    fireEvent.click(within(panel).getByRole('button', { name: /^Pass/ }));
    expect(document.querySelector('[data-blocked-why]')?.textContent).toBe(MISSING_TEXT);
    expect(screen.getByRole('button', { name: 'Record the review and act' })).toBeDisabled();
  });

  it('E82_INCOMPLETE from the server, shown as-is', async () => {
    const refusal = 'E82_INCOMPLETE: complete these first: family size';
    serve({
      pipeline_review_sheet: {
        data: {
          request: {
            id: 'inc', status: 'agent_ops_approved', stage: 'tenant_ops', round: 0, rent_amount: 500000, duration_days: 30, created_at: '2026-11-01',
            tenant: { id: 't1', name: 'Ivy', phone: null, occupation: null }, agent: null, landlord: null, lc1: null, lc_letter: null, house_photos: [], gps: null, funder_visible: true,
          },
          checklist: [], history: [], score: null, recommendation: { recommended: 'pass', reason_code: null, failed: [] }, can_review: true, my_staff_ref: 'E',
        },
      },
      pipeline_record_review: { error: { code: 'P0001', message: refusal } },
    });
    wrap(<ReviewDrawer stage="tenant_ops" requestId="inc" onClose={() => {}} ctx={{ callAnswered: true }} />);
    const panel = (await screen.findByRole('heading', { name: 'Your decision' })).closest('section') as HTMLElement;
    fireEvent.click(within(panel).getByRole('button', { name: /^Pass/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Record the review and act' }));
    expect((await within(panel).findByRole('alert')).textContent).toBe(refusal);
  });
});

describe('COO board', () => {
  const coo = (over: Partial<CooRow>): CooRow => ({
    id: 'c1', req: 'c1', tenant: 'Cara', agent: 'Andy', agent_grade: 'B', landlord: 'L', landlord_verified: true, rent: 300000, days_here: 4.4,
    ratings: { agent_ops: 80, tenant_ops: null, landlord_ops: 60, average: 70, grade: 'B', partly_rated: false }, grade: 'A', avg: 80,
    flags: null, auto_forwarded: false, waiting: null, rank: 1, pushable: true, frozen: null, ...over,
  });

  it.each([375, 1280])('%i px: chip, the list, no push button; the shortcut opens Send back on Agent Ops', async (w) => {
    setWidth(w);
    serve({
      pipeline_coo_board: { data: { counts: {}, can_push: true, rows: [coo({ id: 'inc', tenant: 'Ivy Incomplete', pushable: false, incomplete: MISSING }), coo({ id: 'ok', tenant: 'Olive' })] } },
      pipeline_send_back_options: { data: OPTIONS },
    });
    wrap(<CooBoard board={false} onOpen={() => {}} />);
    await screen.findByText('Ivy Incomplete');
    const inc = document.querySelector('[data-row="inc"]') as HTMLElement;
    expect(inc.querySelector('[data-tone="bad"]')?.textContent).toBe(MISSING_TEXT);
    expect(within(inc).queryByRole('button', { name: 'Push to funders' })).toBeNull();
    expect(within(document.querySelector('[data-row="ok"]') as HTMLElement).getByRole('button', { name: 'Push to funders' })).toBeTruthy();
    fireEvent.click(within(inc).getByRole('button', { name: 'Send back…' }));
    const sheet = await screen.findByRole('dialog', { name: 'Send back Ivy Incomplete' });
    expect(sheet.querySelector('[data-target="agent_ops"]')?.getAttribute('aria-checked')).toBe('true');
  });
});

/* ───────────── Agent Ops: Complete missing items ───────────── */

const QUEUE = {
  count: 2,
  by_desk: { tenant_ops: 1, landlord_ops: 0, coo: 1, funders_board: 0 },
  items: [
    { id: 'q1', short_id: 'q1q1q1q1', desk: 'Tenant Ops', tenant: 'Ivy Incomplete', agent: 'Andy', rent: 500000, missing: MISSING },
    { id: 'q2', short_id: 'q2q2q2q2', desk: 'COO', tenant: 'Pat Photos', agent: 'Ann', rent: 700000, missing: ['photo review (3+ approved, main photo)'] },
  ],
};

describe('Agent Ops: "Complete missing items"', () => {
  it('lists each request with its desk and what is missing; tap opens the drawer', async () => {
    serve({ pipeline_incomplete_queue: { data: QUEUE } });
    wrap(<IncompleteSection board={false} />);
    expect(await screen.findByText('Complete missing items (2)')).toBeTruthy();
    expect(h.rpc).toHaveBeenCalledWith('pipeline_incomplete_queue', { p_limit: 200 });
    expect(screen.getByText('Tenant Ops 1 · COO 1')).toBeTruthy();
    const item = document.querySelector('[data-incomplete="q1q1q1q1"]') as HTMLElement;
    expect(item.textContent).toContain('At Tenant Ops');
    expect(item.textContent).toContain(MISSING_TEXT);
    fireEvent.click(within(item).getAllByRole('button')[0]);
    const sheet = screen.getByRole('dialog', { name: 'Complete Ivy Incomplete · q1q1q1q1' });
    expect(sheet.textContent).toContain('It stays there and moves on once complete.');
    expect(sheet.querySelector('[data-intake-block]')).toBeTruthy();
    expect(sheet.querySelector('[data-document-block]')).toBeTruthy();
    expect(h.rpc).toHaveBeenCalledWith('agent_ops_photo_state', { p_request_id: 'q1' });
  });

  it('family size and work go through agent_save_intake_details; a refusal is shown as-is', async () => {
    serve({ pipeline_incomplete_queue: { data: QUEUE }, agent_save_intake_details: { data: { ok: true } } });
    wrap(<CompleteMissingSheet item={QUEUE.items[0]} onClose={() => {}} />);
    const block = document.querySelector('[data-intake-block]') as HTMLElement;
    const save = within(block).getByRole('button', { name: 'Save details' });
    expect(save).toBeDisabled();
    fireEvent.change(within(block).getByLabelText('Family size'), { target: { value: '5' } });
    fireEvent.change(within(block).getByLabelText('Tenant’s work or business'), { target: { value: 'Boda boda rider, Kawempe' } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(h.rpc).toHaveBeenCalledWith('agent_save_intake_details', { p_request_id: 'q1', p_family_size: 5, p_work_business: 'Boda boda rider, Kawempe', p_work_location: null }),
    );
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Details saved'));

    serve({ pipeline_incomplete_queue: { data: QUEUE }, agent_save_intake_details: { error: { message: "Only the request's agent can add these details" } } });
    fireEvent.change(within(block).getByLabelText('Family size'), { target: { value: '4' } });
    fireEvent.click(within(block).getByRole('button', { name: 'Save details' }));
    expect((await within(block).findByRole('alert')).textContent).toBe("Only the request's agent can add these details");
  });

  it('documents: uploaded into the reviewer’s own folder, then request_attach_document with the right bucket', async () => {
    serve({ request_attach_document: { data: { ok: true } } });
    const file = new File(['x'], 'letter.JPG', { type: 'image/jpeg' });
    expect(await attachDocument('staff-1', 'q1', 'lc1_letter', file)).toEqual({ ok: true });
    const [bucket, path] = h.upload.mock.calls[0];
    expect(bucket).toBe('lc-letters');
    expect(path).toMatch(/^staff-1\/q1\/lc1_letter_\d+\.jpg$/);
    expect(h.rpc).toHaveBeenCalledWith('request_attach_document', { p_request_id: 'q1', p_kind: 'lc1_letter', p_bucket: 'lc-letters', p_path: path });

    await attachDocument('staff-1', 'q1', 'id_front', file);
    expect(h.upload.mock.calls[1][0]).toBe('tenant-ids');

    serve({ request_attach_document: { error: { message: 'Documents can only be added before the request reaches funders (status now: funded)' } } });
    expect(await attachDocument('staff-1', 'q1', 'id_back', file)).toEqual({ ok: false, message: 'Documents can only be added before the request reaches funders (status now: funded)' });
  });

  it('the drawer’s document block: pick the kind, choose the file, attach', async () => {
    serve({ pipeline_incomplete_queue: { data: QUEUE }, request_attach_document: { data: { ok: true } } });
    wrap(<CompleteMissingSheet item={QUEUE.items[0]} onClose={() => {}} />);
    const block = document.querySelector('[data-document-block]') as HTMLElement;
    fireEvent.click(within(block).getByRole('radio', { name: 'Tenant ID, back' }));
    fireEvent.change(within(block).getByLabelText('Choose the file'), { target: { files: [new File(['x'], 'back.png', { type: 'image/png' })] } });
    fireEvent.click(within(block).getByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('request_attach_document', expect.objectContaining({ p_request_id: 'q1', p_kind: 'id_back', p_bucket: 'tenant-ids' })));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Tenant ID, back attached'));
  });
});

describe('"Incomplete requests: {count}" (COO desk and Command Centre)', () => {
  it('the count, red while any is missing; tap lists them', async () => {
    serve({ pipeline_incomplete_queue: { data: QUEUE } });
    wrap(<IncompleteCard board={false} />);
    const tile = (await screen.findByText('Incomplete requests: 2')).closest('button') as HTMLElement;
    expect(tile.getAttribute('data-tone')).toBe('bad');
    fireEvent.click(tile);
    const sheet = screen.getByRole('dialog', { name: 'Incomplete requests' });
    expect(within(sheet).getAllByRole('listitem')).toHaveLength(2);
  });

  it('hidden where the server says the list is not for this viewer', async () => {
    serve({ pipeline_incomplete_queue: { error: { code: '42501', message: 'This list is for Agent Ops, the COO desk and the Command Centre' } } });
    const { container } = wrap(<IncompleteCard board={false} />);
    await waitFor(() => expect(h.rpc).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[data-incomplete-card]')).toBeNull(), { timeout: 5000 });
  });
});
