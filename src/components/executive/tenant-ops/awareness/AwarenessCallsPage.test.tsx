import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a) } }));
const csvMock = vi.fn();
const xlsxMock = vi.fn();
vi.mock('@/lib/csvExport', () => ({ downloadCsv: (...a: unknown[]) => csvMock(...a) }));
vi.mock('@/lib/xlsxExport', () => ({ downloadXlsxWorkbook: (...a: unknown[]) => xlsxMock(...a) }));
vi.mock('sonner', () => ({ toast: { loading: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import AwarenessCallsPage from './AwarenessCallsPage';

type Args = Record<string, unknown>;

const WINDOW = { start_day: '2026-10-01', end_day: '2026-10-07', days: 7, timezone: 'Africa/Kampala' };
const summary = {
  window: WINDOW, basis: 'x',
  totals: { calls: 42, answered: 27, no_answer: 9, phone_off: 4, wrong_number: 2, answered_pct: 64.3, people_called: 38, people_reached: 24, rent_plans_called: 35, callers: 5 },
  aware_30m: { knew: 6, heard: 9, did_not_know: 12, knew_pct: 22.2, heard_pct: 33.3, did_not_know_pct: 44.4 },
  aware_merchant_codes: { knew: 4, heard: 8, did_not_know: 15, knew_pct: 14.8, heard_pct: 29.6, did_not_know_pct: 55.6 },
  explained: { yes: 18, partly: 6, no: 3, yes_pct: 66.7, partly_pct: 22.2, no_pct: 11.1 },
  trend: [
    { day: '2026-10-06', calls: 20, answered: 14, people_called: 18, people_reached: 12, answered_pct: 70 },
    { day: '2026-10-07', calls: 22, answered: 13, people_called: 20, people_reached: 12, answered_pct: 59.1 },
  ],
};
const emptySummary = { ...summary, totals: { ...summary.totals, calls: 0, answered: 0, people_called: 0, people_reached: 0, rent_plans_called: 0, callers: 0, answered_pct: null }, trend: [] };
const teamRows = [
  { team: 'service_centre', calls: 10, answered: 4, answered_pct: 40, people_called: 9, people_reached: 4, rent_plans_called: 9, callers: 2, aware_30m: { knew: 1, heard: 1, did_not_know: 2 }, aware_merchant_codes: { knew: 0, heard: 1, did_not_know: 3 }, explained: { yes: 2, partly: 1, no: 1 } },
  { team: 'agent_ops', calls: 32, answered: 23, answered_pct: 71.9, people_called: 29, people_reached: 20, rent_plans_called: 26, callers: 3, aware_30m: { knew: 5, heard: 8, did_not_know: 10 }, aware_merchant_codes: { knew: 4, heard: 7, did_not_know: 12 }, explained: { yes: 16, partly: 5, no: 2 } },
  ...['tenant_ops', 'landlord_ops', 'other'].map((team) => ({ team, calls: 0, answered: 0, answered_pct: null, people_called: 0, people_reached: 0, rent_plans_called: 0, callers: 0, aware_30m: { knew: 0, heard: 0, did_not_know: 0 }, aware_merchant_codes: { knew: 0, heard: 0, did_not_know: 0 }, explained: { yes: 0, partly: 0, no: 0 } })),
];
const gaps = {
  window: WINDOW, tracking_started: '2026-10-06', basis: 'x',
  totals: { passed: 120, with_call: 30, without_call: 90, covered_pct: 25 },
  by_stage: [
    { stage: 'service_center_review', label: 'Service centre review', team: 'service_centre', passed: 20, with_call: 8, without_call: 12, covered_pct: 40 },
    { stage: 'pending', label: 'Agent Ops review', team: 'agent_ops', passed: 60, with_call: 22, without_call: 38, covered_pct: 36.7 },
  ],
  total: 90, limit: 25, offset: 0,
  rows: [{
    rent_request_id: 'rr-1', plan_code: 'aa5ee2e0', stage: 'pending', stage_label: 'Agent Ops review', team: 'agent_ops', passed_at: '2026-10-06T15:11:28Z', passed_day: '2026-10-06',
    passed_by: 'u-9', passed_by_name: 'Lawrence Nsubuga', current_status: 'agent_ops_approved', tenant_id: 't-1', tenant_name: 'Ajusi Grace', tenant_phone: '+256755727640',
    landlord_name: 'Nabitogo Margret', landlord_phone: '0700111222', agent_id: 'a-1', agent_name: 'Sub Agent One', calls_at_other_stages: 1,
  }],
};
const callerRows = [
  { caller_id: 'u-1', caller_name: 'Grace Namukasa', team: 'agent_ops', calls: 20, answered: 15, answered_pct: 75, people_called: 18, people_reached: 14, rent_plans_called: 17,
    aware_30m: { knew: 3, heard: 5, did_not_know: 7 }, aware_merchant_codes: { knew: 2, heard: 4, did_not_know: 9 }, explained: { yes: 11, partly: 3, no: 1 }, last_call_at: '2026-10-07T07:00:00Z' },
];
const logRow = (i: number) => ({
  id: `c-${i}`, rent_request_id: 'rr-1', plan_code: 'aa5ee2e0', subject_type: 'tenant', subject_name: `Person ${i}`, subject_phone: '0700111222', caller_id: 'u-1', caller_name: 'Grace Namukasa',
  caller_team: 'agent_ops', pipeline_stage: 'pending', current_status: 'funded', region: 'Central', call_result: 'answered', aware_30m: 'knew', aware_merchant_codes: 'heard', explained: 'yes',
  note: 'Called back', day: '2026-10-07', dial_started_at: '2026-10-07T07:00:00Z', recorded_at: '2026-10-07T07:05:00Z',
});
const options = {
  callers: [{ id: 'u-1', name: 'Grace Namukasa', team: 'agent_ops', calls: 20 }],
  regions: ['Central', 'Western'], districts: [{ region: 'Central', district: 'Wakiso' }, { region: 'Western', district: 'Mbarara' }],
  statuses: ['funded', 'pending', 'service_center_review'],
};

let summaryData: unknown = summary;
let summaryError: string | null = null;
let logTotal = 3;

function install() {
  rpcMock.mockImplementation((fn: string, a: Args) => {
    const ok = (data: unknown) => Promise.resolve({ data, error: null });
    switch (fn) {
      case 'awareness_calls_options': return ok(options);
      case 'awareness_calls_summary': return summaryError ? Promise.resolve({ data: null, error: { message: summaryError } }) : ok(summaryData);
      case 'awareness_calls_by_team': return ok({ window: WINDOW, rows: teamRows });
      case 'awareness_calls_by_caller': return ok({ window: WINDOW, total_callers: 1, rows: callerRows });
      case 'awareness_coverage_gaps': return ok(gaps);
      case 'awareness_calls_log': {
        const offset = Number(a.p_offset ?? 0); const limit = Number(a.p_limit ?? 25);
        const n = Math.max(0, Math.min(limit, logTotal - offset));
        return ok({ window: WINDOW, total: logTotal, limit, offset, rows: Array.from({ length: n }, (_v, i) => logRow(offset + i + 1)) });
      }
      default: return ok(null);
    }
  });
}

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};
const calls = (fn: string) => rpcMock.mock.calls.filter((c) => c[0] === fn).map((c) => c[1] as Args);
const lastSummary = () => calls('awareness_calls_summary').at(-1)!;

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
});

async function pick(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('AwarenessCallsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    summaryData = summary; summaryError = null; logTotal = 3;
    install();
  });

  it('opens on the last 7 days and reads every figure from the reports', async () => {
    render(<AwarenessCallsPage />, { wrapper });
    const cards = await screen.findByTestId('awareness-cards');
    await waitFor(() => expect(within(cards).getByText('42')).toBeInTheDocument());
    const a = calls('awareness_calls_summary')[0];
    const span = (new Date(a.p_to as string).getTime() - new Date(a.p_from as string).getTime()) / 86_400_000;
    expect(Math.round(span)).toBe(7);

    // what each card shows
    expect(within(cards).getByText('Calls made').closest('div')).toHaveTextContent('27 answered');
    expect(within(cards).getByText('People reached').closest('div')).toHaveTextContent('24');
    expect(within(cards).getByText('People reached').closest('div')).toHaveTextContent('of 38 people called');
    expect(within(cards).getByText('Answered').closest('div')).toHaveTextContent('64.3%');
    expect(within(cards).getByText('Answered').closest('div')).toHaveTextContent('9 no answer, 4 phone off, 2 wrong number');
    expect(within(cards).getByText('Rent Plans called').closest('div')).toHaveTextContent('by 5 callers');
    expect(within(cards).getByText('Knew about 30M').closest('div')).toHaveTextContent('22.2% of answered calls');
    expect(within(cards).getByText('Knew merchant codes').closest('div')).toHaveTextContent('14.8% of answered calls');
    expect(within(cards).getByText('Fully explained').closest('div')).toHaveTextContent('6 partly, 3 not explained');
    await waitFor(() => expect(within(cards).getByText('Stages without a call').closest('div')).toHaveTextContent('90'));
    expect(within(cards).getByText('Stages without a call').closest('div')).toHaveTextContent('25.0% of 120 stage moves had a call');
    expect(screen.getByText('What people told us')).toBeInTheDocument();
    expect(screen.getByText('Calls per day')).toBeInTheDocument();
  });

  it('says so, and since when calls exist, when nothing matches', async () => {
    summaryData = emptySummary;
    render(<AwarenessCallsPage />, { wrapper });
    expect(await screen.findByText('No awareness calls match these filters')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/Calls have been recorded since 06 Oct 2026/)).toBeInTheDocument());
  });

  it('By stage / team: calls per team and Rent Plans that moved past each stage with and without a call', async () => {
    const user = userEvent.setup();
    render(<AwarenessCallsPage />, { wrapper });
    await user.click(screen.getByRole('tab', { name: 'By stage / team' }));
    expect((await screen.findAllByText('Agent Ops')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Service centre review').length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getAllByText('38').length).toBeGreaterThan(0));          // Agent Ops review, without a call
    expect(screen.getAllByText('5 / 8 / 10').length).toBeGreaterThan(0);                       // Agent Ops 30M: knew / heard / did not know
  });

  it('By caller reads only when its tab is opened', async () => {
    const user = userEvent.setup();
    render(<AwarenessCallsPage />, { wrapper });
    await screen.findByTestId('awareness-cards');
    expect(calls('awareness_calls_by_caller')).toHaveLength(0);
    await user.click(screen.getByRole('tab', { name: 'By caller' }));
    expect((await screen.findAllByText('Grace Namukasa')).length).toBeGreaterThan(0);
    expect(calls('awareness_calls_by_caller')[0]).toMatchObject({ p_limit: 200 });
  });

  it('every filter reaches the reports on the server', async () => {
    const user = userEvent.setup();
    render(<AwarenessCallsPage />, { wrapper });
    await screen.findByTestId('awareness-cards');
    await pick(user, 'Team', 'Agent Ops');
    await pick(user, 'Caller', 'Grace Namukasa');
    await pick(user, 'Person type', 'Landlord');
    await pick(user, 'Call result', 'Answered');
    await pick(user, 'Answer choice', 'Knew merchant codes: Did not know');
    await pick(user, 'Region', 'Central');
    await pick(user, 'District', 'Wakiso');
    await pick(user, 'Request status', 'Funded');
    await waitFor(() => expect(lastSummary()).toMatchObject({
      p_team: 'agent_ops', p_caller: 'u-1', p_subject_type: 'landlord', p_result: 'answered', p_answer_field: 'aware_merchant_codes', p_answer: 'did_not_know',
      p_region: 'Central', p_district: 'Wakiso', p_status: 'funded',
    }));
    // the same filters go to the team report; the gaps report takes the ones that make sense for it
    expect(calls('awareness_calls_by_team').at(-1)).toMatchObject({ p_team: 'agent_ops', p_result: 'answered', p_status: 'funded' });
    expect(calls('awareness_coverage_gaps').at(-1)).toMatchObject({ p_team: 'agent_ops', p_region: 'Central', p_district: 'Wakiso', p_status: 'funded' });
    expect(calls('awareness_coverage_gaps').at(-1)).not.toHaveProperty('p_result');

    // clearing goes back to the first read (already held), so the screen resets without a new request
    await user.click(screen.getByRole('button', { name: /Clear filters \(8\)/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Clear filters' })).toBeDisabled());
    expect(screen.getByRole('combobox', { name: 'Team' })).toHaveTextContent('All teams');
    expect(screen.getByRole('combobox', { name: 'Call result' })).toHaveTextContent('Any result');
    expect(screen.getByRole('combobox', { name: 'Request status' })).toHaveTextContent('Any request status');
  });

  it('district choices follow the chosen region', async () => {
    const user = userEvent.setup();
    render(<AwarenessCallsPage />, { wrapper });
    await screen.findByTestId('awareness-cards');
    await pick(user, 'Region', 'Western');
    await user.click(screen.getByRole('combobox', { name: 'District' }));
    expect(await screen.findByRole('option', { name: 'Mbarara' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Wakiso' })).not.toBeInTheDocument();
  });

  it('Requests without a call: names, phones to tap, stage and who passed it; call-only filters are explained', async () => {
    const user = userEvent.setup();
    render(<AwarenessCallsPage />, { wrapper });
    await screen.findByTestId('awareness-cards');
    await pick(user, 'Call result', 'Answered');
    await user.click(screen.getByRole('tab', { name: 'Requests without a call' }));
    expect((await screen.findAllByText('Ajusi Grace')).length).toBeGreaterThan(0);
    expect(screen.getByText(/call result filter does not apply here/)).toBeInTheDocument();
    expect(screen.getByText(/Calls have only been recorded since 06 Oct 2026/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Call +256755727640' })[0]).toHaveAttribute('href', 'tel:+256755727640');
    expect(screen.getAllByText('Lawrence Nsubuga').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Agent Ops review').length).toBeGreaterThan(0);
    expect(calls('awareness_coverage_gaps').at(-1)).toMatchObject({ p_limit: 25, p_offset: 0 });
  });

  it('Call log pages through the calls and exports every matching call to CSV and Excel', async () => {
    logTotal = 430;
    const user = userEvent.setup();
    render(<AwarenessCallsPage />, { wrapper });
    await screen.findByTestId('awareness-cards');
    await pick(user, 'Call result', 'Answered');
    await user.click(screen.getByRole('tab', { name: 'Call log' }));
    expect((await screen.findAllByText('Person 1')).length).toBeGreaterThan(0);
    expect(screen.getByText('1 to 25 of 430 calls')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(screen.getByText('26 to 50 of 430 calls')).toBeInTheDocument());
    expect(calls('awareness_calls_log').at(-1)).toMatchObject({ p_offset: 25, p_limit: 25, p_result: 'answered' });

    await user.click(screen.getByRole('button', { name: /Export CSV/ }));
    await waitFor(() => expect(csvMock).toHaveBeenCalledTimes(1));
    const [name, headers, rows] = csvMock.mock.calls[0];
    expect(name).toMatch(/^Welile_Awareness_Calls_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
    expect(headers[0]).toBe('Day (Kampala)');
    expect(rows).toHaveLength(430);                                    // all matching calls, not only the 25 on screen
    expect(calls('awareness_calls_log').filter((c) => c.p_limit === 200).map((c) => c.p_offset)).toEqual([0, 200, 400]);

    await user.click(screen.getByRole('button', { name: /Export Excel/ }));
    await waitFor(() => expect(xlsxMock).toHaveBeenCalledTimes(1));
    expect(xlsxMock.mock.calls[0][1].map((s: { name: string }) => s.name)).toEqual(['Call log', 'Filters']);
    expect(xlsxMock.mock.calls[0][1][0].rows).toHaveLength(430);
  });

  it('shows "Not available" to someone the reports refuse', async () => {
    summaryError = 'not authorized';
    render(<AwarenessCallsPage />, { wrapper });
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Overview' })).not.toBeInTheDocument();
  });

  it('never uses the words loan, lender, ROI or interest', async () => {
    const user = userEvent.setup();
    const { container } = render(<AwarenessCallsPage />, { wrapper });
    await screen.findByTestId('awareness-cards');
    for (const tab of ['By stage / team', 'By caller', 'Requests without a call', 'Call log']) {
      await user.click(screen.getByRole('tab', { name: tab }));
    }
    expect(container.textContent).not.toMatch(/\b(loan|lender|ROI|interest)\b/i);
  });
});
