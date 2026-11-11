import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Every decision button on the Service Centre, Agent Ops, Tenant Ops, Landlord
 * Ops and COO desks, against the server as it is now:
 * - pipeline_record_review moves the request itself on a pass (E64) and on a
 *   reject (E69) at Agent / Tenant / Landlord Ops, so nothing writes
 *   rent_requests from the browser (row security refuses it anyway);
 * - Pass says why it cannot go yet, right under it;
 * - Transfer is ops_transfer_pipeline_request_agent, then the pass;
 * - Wait on… is pipeline_set_waiting; server messages show as-is.
 */

const h = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), message: vi.fn() });
  return { toast, rpc: vi.fn(), from: vi.fn(), update: vi.fn(), reasons: [] as unknown[] };
});
vi.mock('sonner', () => ({ toast: h.toast }));
vi.mock('@/integrations/supabase/client', () => {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    limit: () => Promise.resolve({ data: [], error: null }),
    order: () => Promise.resolve({ data: h.reasons, error: null }),
    update: (...a: unknown[]) => {
      h.update(...a);
      return chain;
    },
  });
  return {
    supabase: {
      rpc: (...a: unknown[]) => h.rpc(...a),
      from: (...a: unknown[]) => {
        h.from(...a);
        return chain;
      },
      storage: { from: vi.fn() },
    },
  };
});
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: [] }) }));
vi.mock('@/hooks/useCrmVoiceCall', () => ({
  useCrmVoiceCall: () => ({ state: 'idle', callId: null, elapsed: 0, error: null, isEnding: false, start: vi.fn(), end: vi.fn() }),
  useHumanCallingPaused: () => ({ data: { paused: false, reason: null, paused_at: null } }),
  isTerminalCallState: () => false,
}));
vi.mock('@/components/coo/CooReasonPicker', () => ({
  useCooReasonPicker: () => ({ picker: null, askReason: vi.fn(), meaningOf: () => null }),
  useCooReasonCodes: () => ({ data: [], isLoading: false }),
}));

import { passBlock } from '../passBlock';
import { answeredCallOnFile, stageSince } from '../callOnFile';
import { PASS_SENT_TO, SENT_BACK_TO_AGENT, TRANSFER_PASS_REASON, runMove } from '../deskActions';
import { ReviewDrawer } from '../ReviewDrawer';
import { ReviewStatusProvider } from '../reviewStatus';
import { WaitOnForm } from '../waitOn';
import { STAGE_DECISIONS, type Stage } from '../reviewTypes';

/* ───────────── request 06df1e3b: Odenyo Elly at Landlord Ops, 3 of 8 checks answered ───────────── */

/** The eight Landlord Ops checks as the production catalogue has them. */
const LO_CHECKS: [string, string, 'amount' | null][] = [
  ['lo_reachable', 'Landlord reachable', null],
  ['lo_number_is_landlord', "Number is the landlord's", null],
  ['lo_knows_tenant', 'Knows the tenant', null],
  ['lo_uses_otp_dashboard', 'Will use OTP / dashboard', null],
  ['lo_accepts_deposit', 'Accepts deposit, no charges', null],
  ['lo_rent_confirmed', 'Rent confirmed by the landlord', 'amount'],
  ['lo_tenant_no_arrears', 'Tenant not in rent arrears', null],
  ['lo_value_prop', 'Value proposition offered', null],
];
const loItem = ([code, label, value_kind]: (typeof LO_CHECKS)[number]) => ({
  code, stage: 'landlord_ops', label, question: `${label}?`, method: 'call', weight: 1, required: true, on_fail: 'reject',
  value_kind, assumption: null, system_said: null, system_detail: null, last: null,
});
const LO_ITEMS = LO_CHECKS.map(loItem);
const answered = (codes: string[], extra: Record<string, unknown> = {}) =>
  Object.fromEntries(codes.map((c) => [c, { code: c, result: 'pass' as const, ...(extra[c] !== undefined ? { value: extra[c] } : {}) }]));
const base = { callDesk: 'landlord' as const, callAnswered: true, items: LO_ITEMS, against: false, reasonCode: '', noteRequired: false, note: '' };

describe('Pass says why it cannot go yet (06df1e3b, Landlord Ops, 3 of 8 checks)', () => {
  it('the call comes first', () => {
    expect(passBlock({ ...base, callAnswered: false, entries: answered(['lo_reachable', 'lo_number_is_landlord', 'lo_knows_tenant']) })).toBe(
      'Log an answered landlord call first',
    );
  });
  it('3 of 8 answered: "Answer 5 more checks"; 7 of 8: "Answer 1 more check"', () => {
    expect(passBlock({ ...base, entries: answered(['lo_reachable', 'lo_number_is_landlord', 'lo_knows_tenant']) })).toBe('Answer 5 more checks');
    expect(passBlock({ ...base, entries: answered(LO_CHECKS.slice(0, 7).map((c) => c[0])) })).toBe('Answer 1 more check');
  });
  it('all eight ticked but no rent typed: "Enter the rent the landlord states"', () => {
    expect(passBlock({ ...base, entries: answered(LO_CHECKS.map((c) => c[0])) })).toBe('Enter the rent the landlord states');
  });
  it('going against the system: "Choose a reason code", then the note', () => {
    const entries = answered(LO_CHECKS.map((c) => c[0]), { lo_rent_confirmed: 700000 });
    expect(passBlock({ ...base, entries, against: true })).toBe('Choose a reason code');
    expect(passBlock({ ...base, entries, against: true, reasonCode: 'RISK_JUDGEMENT', noteRequired: true, note: 'short' })).toBe(
      'Write at least 10 characters in the note',
    );
    expect(passBlock({ ...base, entries, against: true, reasonCode: 'RISK_JUDGEMENT', noteRequired: true, note: 'Landlord confirmed twice' })).toBeNull();
  });
  it('nothing left: Pass can go', () => {
    expect(passBlock({ ...base, entries: answered(LO_CHECKS.map((c) => c[0]), { lo_rent_confirmed: 700000 }) })).toBeNull();
  });
});

/* ───────────── no table writes, and the server's words ───────────── */

describe('the second call never writes rent_requests', () => {
  beforeEach(() => {
    h.rpc.mockReset();
    h.rpc.mockResolvedValue({ data: null, error: null });
    h.from.mockReset();
    h.update.mockReset();
  });

  it('pass and reject at Agent / Tenant / Landlord Ops: the review already moved it, no further call', async () => {
    for (const stage of ['agent_ops', 'tenant_ops', 'landlord_ops'] as const) {
      expect(await runMove({ requestId: 'r1', stage, decision: 'pass', userId: 'u1', note: '' })).toEqual({ ok: true, message: PASS_SENT_TO[stage] });
      expect(await runMove({ requestId: 'r1', stage, decision: 'reject', userId: 'u1', note: 'Landlord refused the deposit' })).toEqual({
        ok: true,
        message: SENT_BACK_TO_AGENT,
      });
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('no decision at any desk touches a table', async () => {
    for (const stage of Object.keys(STAGE_DECISIONS) as Stage[]) {
      for (const decision of STAGE_DECISIONS[stage]) {
        await runMove({ requestId: 'r1', stage, decision, userId: 'u1', note: 'a note of ten+ characters', targetAgentId: 'a2', proxyAgentId: 'p1' });
      }
    }
    expect(h.from).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('Service Centre pass: its own RPC, "Sent to Agent Ops"; a refusal comes back word for word', async () => {
    expect(await runMove({ requestId: 'r1', stage: 'service_centre', decision: 'pass', userId: 'u1', note: '' })).toEqual({ ok: true, message: 'Sent to Agent Ops' });
    expect(h.rpc).toHaveBeenCalledWith('service_center_review_rent_request', { p_request_id: 'r1', p_decision: 'verify', p_comment: '' });
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'Not authorized for this Service Centre request' } });
    expect(await runMove({ requestId: 'r1', stage: 'service_centre', decision: 'pass', userId: 'u1', note: '' })).toEqual({
      ok: false,
      message: 'Not authorized for this Service Centre request',
    });
  });
});

/* ───────────── the drawer ───────────── */

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReviewStatusProvider>{ui}</ReviewStatusProvider>
    </QueryClientProvider>,
  );
}

const person = (id: string, name: string) => ({ id, name, phone: '+256700000001' });
const sheet = (stage: Stage, checklist: unknown[], recommended: string | null) => ({
  request: {
    id: '06df1e3b-94f7-4efb-af5b-ea8fcccb6997', status: 'tenant_ops_approved', stage, round: 0, rent_amount: 700000, duration_days: 30, created_at: '2026-11-01',
    tenant: { ...person('t1', 'Odenyo Elly'), occupation: null }, agent: person('a1', 'Andy Agent'), landlord: { ...person('l1', 'Lucy Landlord'), verified: true },
    lc1: null, lc_letter: null, house_photos: [], gps: null, funder_visible: true,
  },
  checklist,
  history: [],
  score: null,
  recommendation: recommended ? { recommended, reason_code: null, failed: [] } : null,
  can_review: true,
  my_staff_ref: 'EMP-1',
});

function serve(s: unknown, extra: Record<string, unknown> = {}) {
  h.rpc.mockReset();
  h.rpc.mockImplementation((fn: string) => {
    if (fn === 'pipeline_review_sheet') return Promise.resolve({ data: s, error: null });
    if (fn in extra) return Promise.resolve({ data: extra[fn], error: null });
    if (/_list$|_calls$|suggest_agents|waiting_list/.test(fn)) return Promise.resolve({ data: [], error: null });
    return Promise.resolve({ data: null, error: null });
  });
}

/** Log an answered landlord call in the drawer's call log. */
async function logAnsweredLandlordCall() {
  const pick = (legend: RegExp, option: string) => {
    const fs = screen.getAllByRole('group').find((g) => legend.test(g.querySelector('legend')?.textContent ?? '')) as HTMLElement;
    fireEvent.click(within(fs).getByRole('button', { name: option }));
  };
  pick(/How did the call go/, 'Answered');
  pick(/Knew Welile pays rent/, 'Knew');
  pick(/Consent to the deposit/, 'Consents');
  pick(/payout code/, 'Knew');
  pick(/explain it fully/, 'Yes');
  fireEvent.click(screen.getByRole('button', { name: 'Save the call' }));
  await screen.findByText('Answered call logged.');
}

/** The "Your decision" panel: its own Pass chip, note and buttons (the check rows have Pass buttons too). */
const decisionPanel = () => screen.getByRole('heading', { name: 'Your decision' }).closest('section') as HTMLElement;
const passChip = () => within(decisionPanel()).getByRole('button', { name: /^Pass/ }) as HTMLButtonElement;
const decisionNote = () => within(decisionPanel()).getByPlaceholderText(/What you saw/);

const tick = (label: string, result: 'Pass' | 'Fail' = 'Pass') =>
  fireEvent.click(within(screen.getByText(label).closest('li') as HTMLElement).getByRole('button', { name: result }));

describe('Landlord Ops drawer, request 06df1e3b', () => {
  beforeEach(() => {
    h.toast.success.mockReset();
    h.update.mockReset();
    serve(sheet('landlord_ops', LO_ITEMS, 'pass'));
  });

  it('Pass says why right under it, until it can go; then one review call, a toast, no table write', async () => {
    wrap(<ReviewDrawer stage="landlord_ops" requestId="06df1e3b-94f7-4efb-af5b-ea8fcccb6997" onClose={() => {}} />);
    await screen.findByText('Rent confirmed by the landlord');

    // No answered call yet: the Pass chip is off and says so under the chips.
    expect(passChip().disabled).toBe(true);
    expect(document.querySelector('[data-pass-why]')?.textContent).toBe('Pass: Log an answered landlord call first');

    await logAnsweredLandlordCall();
    expect(passChip().disabled).toBe(false);
    expect(document.querySelector('[data-pass-why]')).toBeNull();

    // Three of the eight answered, then Pass.
    tick('Landlord reachable');
    tick("Number is the landlord's");
    tick('Knows the tenant');
    fireEvent.click(passChip());
    const submit = screen.getByRole('button', { name: 'Record the review and act' }) as HTMLButtonElement;
    const why = () => document.querySelector('[data-blocked-why]');
    expect(submit.disabled).toBe(true);
    expect(why()?.textContent).toBe('Answer 5 more checks');
    // Right under the button it disables.
    expect(submit.compareDocumentPosition(why() as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    for (const [, label] of LO_CHECKS.slice(3)) tick(label);
    expect(why()?.textContent).toBe('Enter the rent the landlord states');

    const rentRow = screen.getByText('Rent confirmed by the landlord').closest('li') as HTMLElement;
    fireEvent.change(within(rentRow).getByRole('spinbutton'), { target: { value: '700000' } });
    expect(why()).toBeNull();
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Sent to the COO'));
    const reviews = h.rpc.mock.calls.filter((c) => c[0] === 'pipeline_record_review');
    expect(reviews).toHaveLength(1);
    expect(reviews[0][1]).toMatchObject({ p_stage: 'landlord_ops', p_decision: 'pass' });
    expect(reviews[0][1].p_results).toContainEqual({ code: 'lo_rent_confirmed', result: 'pass', value: 700000 });
    expect(h.update).not.toHaveBeenCalled();
  }, 20_000); // a long walk through the drawer: slow under a loaded machine

  it('a refused pass shows the server message as-is', async () => {
    serve(sheet('landlord_ops', LO_ITEMS, 'pass'));
    const refusal = 'Request is at "partner_ops_approved", not at the landlord_ops desk';
    const inner = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation((fn: string, args: unknown) =>
      fn === 'pipeline_record_review' ? Promise.resolve({ data: null, error: { code: 'P0001', message: refusal } }) : inner(fn, args),
    );
    wrap(<ReviewDrawer stage="landlord_ops" requestId="06df1e3b-94f7-4efb-af5b-ea8fcccb6997" onClose={() => {}} />);
    await screen.findByText('Rent confirmed by the landlord');
    await logAnsweredLandlordCall();
    for (const [, label] of LO_CHECKS) tick(label);
    fireEvent.change(within(screen.getByText('Rent confirmed by the landlord').closest('li') as HTMLElement).getByRole('spinbutton'), { target: { value: '700000' } });
    fireEvent.click(passChip());
    fireEvent.click(screen.getByRole('button', { name: 'Record the review and act' }));
    expect((await screen.findByRole('alert')).textContent).toBe(refusal);
  });
});

describe('Agent Ops drawer: Transfer', () => {
  const AO = [
    { code: 'ao_agent_performance', stage: 'agent_ops', label: 'Agent performance', question: 'Agent collects?', method: 'review', weight: 1, required: true, on_fail: 'transfer', value_kind: null, assumption: null, system_said: null, system_detail: null, last: null },
  ];
  const AGENTS = [{ agent_id: 'a2', agent_name: 'Grace Strong', km: 1.2, in_window_pct: 0.92, active_tenants: 14 }];

  beforeEach(() => {
    h.toast.success.mockReset();
    serve(sheet('agent_ops', AO, 'transfer'), { pipeline_suggest_agents: AGENTS });
  });

  it('transfers first, then records the pass (the server moves it); toast says where', async () => {
    wrap(<ReviewDrawer stage="agent_ops" requestId="06df1e3b-94f7-4efb-af5b-ea8fcccb6997" onClose={() => {}} />);
    await screen.findByText('Agent performance');
    tick('Agent performance', 'Fail');
    fireEvent.click(screen.getByRole('button', { name: /^Transfer to another agent/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Grace Strong/ }));
    fireEvent.change(decisionNote(), { target: { value: 'Old agent is below 50% collected' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record the review and act' }));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Transferred to Grace Strong. Sent to Tenant Ops'));
    const calls = h.rpc.mock.calls.map((c) => c[0]).filter((f) => f === 'ops_transfer_pipeline_request_agent' || f === 'pipeline_record_review');
    expect(calls).toEqual(['ops_transfer_pipeline_request_agent', 'pipeline_record_review']);
    const pass = h.rpc.mock.calls.find((c) => c[0] === 'pipeline_record_review')![1];
    expect(pass).toMatchObject({ p_decision: 'pass', p_stage: 'agent_ops', p_reason_code: TRANSFER_PASS_REASON, p_target_agent_id: null });
  });

  it('a refused transfer records nothing and shows the server message as-is', async () => {
    const refusal = 'That agent already received 5 transfers in 7 days (cap 5): choose another agent';
    const inner = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation((fn: string, args: unknown) =>
      fn === 'ops_transfer_pipeline_request_agent' ? Promise.resolve({ data: null, error: { message: refusal } }) : inner(fn, args),
    );
    wrap(<ReviewDrawer stage="agent_ops" requestId="06df1e3b-94f7-4efb-af5b-ea8fcccb6997" onClose={() => {}} />);
    await screen.findByText('Agent performance');
    tick('Agent performance', 'Fail');
    fireEvent.click(screen.getByRole('button', { name: /^Transfer to another agent/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Grace Strong/ }));
    fireEvent.change(decisionNote(), { target: { value: 'Old agent is below 50% collected' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record the review and act' }));
    expect((await screen.findByRole('alert')).textContent).toBe(refusal);
    expect(h.rpc.mock.calls.some((c) => c[0] === 'pipeline_record_review')).toBe(false);
  });
});

describe('Wait on…', () => {
  beforeEach(() => {
    h.reasons = [{ code: 'LANDLORD_UNREACHABLE', desks: ['Landlord Ops'], meaning: 'Landlord not reachable', requires_text: false }];
  });

  it('is one pipeline_set_waiting call; a refusal is shown as the server wrote it', async () => {
    const refusal = 'You cannot act on this desk for this request';
    h.rpc.mockReset();
    h.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: refusal } });
    wrap(<WaitOnForm requestId="r1" desk="landlord_ops" deskTag="Landlord Ops" onDone={() => {}} />);
    const [owner, reason] = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.change(owner, { target: { value: (owner.options[1] as HTMLOptionElement).value } });
    await waitFor(() => expect(Array.from(reason.options).some((o) => o.value === 'LANDLORD_UNREACHABLE')).toBe(true));
    fireEvent.change(reason, { target: { value: 'LANDLORD_UNREACHABLE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set the wait' }));
    expect((await screen.findByRole('alert')).textContent).toBe(refusal);
    expect(h.rpc).toHaveBeenCalledWith('pipeline_set_waiting', expect.objectContaining({ p_request_id: 'r1', p_desk: 'landlord_ops', p_reason_code: 'LANDLORD_UNREACHABLE' }));
  });
});

/* ───────────── an answered call already on file (06df1e3b: 2 answered calls on record) ───────────── */

/** The two answered calls rent_pipeline_awareness_calls holds for 06df1e3b. */
const CALLS_ON_FILE = [
  { subject_type: 'tenant', call_result: 'answered', recorded_at: '2026-11-10T10:20:11.220Z', caller_name: 'Tom Caller' },
  { subject_type: 'landlord', call_result: 'answered', recorded_at: '2026-11-10T07:58:49.794Z', caller_name: 'Sarah Caller' },
];
/** Tenant Ops passed it at 10:20 — when it reached Landlord Ops. */
const TENANT_OPS_REVIEW = {
  stage: 'tenant_ops', decision: 'pass', recommended: 'pass', followed: true, reason_code: null, note: null, failed: null, by: 'Tess', staff_ref: 'E-2', at: '2026-11-10T10:20:29.744Z',
};

describe('answered call on file: the server rule', () => {
  it("counts the landlord's answered call from before Tenant Ops' review (the server allows a day)", () => {
    expect(answeredCallOnFile(CALLS_ON_FILE, 'landlord', TENANT_OPS_REVIEW.at)).toEqual({ at: '2026-11-10T07:58:49.794Z', by: 'Sarah Caller' });
  });
  it('ignores other subjects, unanswered calls, and calls more than a day before the request reached the desk', () => {
    expect(answeredCallOnFile([{ ...CALLS_ON_FILE[1], subject_type: 'tenant' }], 'landlord', null)).toBeNull();
    expect(answeredCallOnFile([{ ...CALLS_ON_FILE[1], call_result: 'no_answer' }], 'landlord', null)).toBeNull();
    expect(answeredCallOnFile(CALLS_ON_FILE, 'landlord', '2026-11-12T08:00:00Z')).toBeNull();
  });
  it('since: the previous desk’s last review, else the request’s creation', () => {
    const s = { ...sheet('landlord_ops', LO_ITEMS, 'pass'), history: [TENANT_OPS_REVIEW] } as never;
    expect(stageSince(s, 'landlord_ops')).toBe(TENANT_OPS_REVIEW.at);
    expect(stageSince(sheet('landlord_ops', LO_ITEMS, 'pass') as never, 'landlord_ops')).toBe('2026-11-01');
  });
});

describe('Landlord Ops drawer, 06df1e3b with an answered call on file', () => {
  beforeEach(() => {
    h.toast.success.mockReset();
    serve({ ...sheet('landlord_ops', LO_ITEMS, 'pass'), history: [TENANT_OPS_REVIEW] }, { get_awareness_calls_for_request: { rows: CALLS_ON_FILE } });
  });

  it('Pass is on without logging a call here, with the call named above the buttons', async () => {
    wrap(<ReviewDrawer stage="landlord_ops" requestId="06df1e3b-94f7-4efb-af5b-ea8fcccb6997" onClose={() => {}} />);
    await screen.findByText('Rent confirmed by the landlord');
    await waitFor(() => expect(passChip().disabled).toBe(false));
    const line = document.querySelector('[data-call-on-file]') as HTMLElement;
    expect(line.textContent).toBe('Answered call on file — 10 Nov, 10:58, Sarah Caller');
    // Above the decision buttons.
    expect(line.compareDocumentPosition(passChip()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector('[data-pass-why]')).toBeNull();

    // Pass with checks still open: why, right under the buttons.
    fireEvent.click(passChip());
    expect(document.querySelector('[data-pass-why]')?.textContent).toBe('Pass: Answer 8 more checks');
    for (const [, label] of LO_CHECKS) tick(label);
    fireEvent.change(within(screen.getByText('Rent confirmed by the landlord').closest('li') as HTMLElement).getByRole('spinbutton'), { target: { value: '700000' } });
    expect(document.querySelector('[data-pass-why]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Record the review and act' }));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Sent to the COO'));
  });

  it("opened from the board: the row's answered call turns Pass on before the history loads", async () => {
    serve(sheet('landlord_ops', LO_ITEMS, 'pass'));
    wrap(<ReviewDrawer stage="landlord_ops" requestId="06df1e3b-94f7-4efb-af5b-ea8fcccb6997" onClose={() => {}} ctx={{ callAnswered: true }} />);
    await screen.findByText('Rent confirmed by the landlord');
    expect(passChip().disabled).toBe(false);
    expect(document.querySelector('[data-call-on-file]')?.textContent).toBe('Answered call on file');
  });

  it('no answered landlord call on file: Pass stays off and says why under the buttons', async () => {
    serve(sheet('landlord_ops', LO_ITEMS, 'pass'), { get_awareness_calls_for_request: { rows: [CALLS_ON_FILE[0]] } });
    wrap(<ReviewDrawer stage="landlord_ops" requestId="06df1e3b-94f7-4efb-af5b-ea8fcccb6997" onClose={() => {}} />);
    await screen.findByText('Rent confirmed by the landlord');
    await waitFor(() => expect(h.rpc.mock.calls.some((c) => c[0] === 'get_awareness_calls_for_request')).toBe(true));
    expect(passChip().disabled).toBe(true);
    expect(document.querySelector('[data-pass-why]')?.textContent).toBe('Pass: Log an answered landlord call first');
    expect(document.querySelector('[data-call-on-file]')).toBeNull();
  });
});
