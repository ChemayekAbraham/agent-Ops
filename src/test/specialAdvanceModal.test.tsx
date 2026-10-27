import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { previewSpecialAdvance } from '@/lib/specialAdvancePreview';
import { kampalaTodayYmd } from '@/lib/kampalaDays';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(), from: vi.fn(), functionsInvoke: vi.fn(), toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  server: { issuance: true, eligibility: [] as string[], borrowerErrors: [] as string[], createError: null as null | { code: string; message: string; details?: string } },
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from, functions: { invoke: mocks.functionsInvoke } },
}));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@/components/cfo/UserSearchPicker', () => ({
  UserSearchPicker: ({ onSelect, selectedUser, label }: { onSelect: (u: unknown) => void; selectedUser: { full_name: string } | null; label: string }) => (
    <div>
      <span>{label}</span>
      {selectedUser ? <span>Selected: {selectedUser.full_name}</span> : null}
      <button type="button" onClick={() => onSelect({ id: 'user-1', full_name: 'Jane Borrower', phone: '256700000000' })}>pick borrower</button>
    </div>
  ),
}));
import { SpecialAdvanceModal } from '@/components/cfo/SpecialAdvanceModal';
import { formatUGX } from '@/lib/agentAdvanceCalculations';

// Each test waits for the debounced server quote; allow for a busy machine running the database suites in parallel.
vi.setConfig({ testTimeout: 15_000 });

/** Stand-in for the server: the same arithmetic as _special_advance_schedule (parity proven in the engine tests). */
function serverQuote(req: { terms?: Record<string, unknown>; borrower?: Record<string, unknown>; planned_payout_date?: string }) {
  const t = req.terms as { principal: number; rate_percent: number; rate_basis: 'daily' | 'monthly'; term_days: number; frequency: 'daily' | 'weekly' | 'monthly' };
  const start = req.planned_payout_date ?? kampalaTodayYmd();
  const p = previewSpecialAdvance({ principal: t.principal, ratePercent: t.rate_percent, rateBasis: t.rate_basis, termDays: t.term_days, frequency: t.frequency, issueYmd: start });
  return {
    issuance_enabled: mocks.server.issuance, dated_from: start, dated_from_is_planned: !!req.planned_payout_date, term_errors: p ? [] : ['term'],
    schedule: p && {
      calc_version: 'sa-calc-1', principal: p.principal, rate_percent: p.ratePercent, rate_basis: p.rateBasis, term_days: p.termDays, frequency: p.frequency,
      start_date: start, access_fee: p.accessFee, registration_fee: p.registrationFee, total_repayable: p.totalRepayable, instalments: p.instalments,
      instalment_amount: p.instalmentAmount, final_instalment_amount: p.finalInstalmentAmount, first_due_date: p.firstDueYmd, final_due_date: p.finalDueYmd,
      schedule: p.schedule.map((s) => ({ number: s.number, due_date: s.dueYmd, amount: s.amount, access_fee: s.accessFee, registration_fee: s.registrationFee,
        principal: s.principal, balance_after: s.balanceAfter })),
    },
    borrower_errors: req.borrower ? mocks.server.borrowerErrors : [], eligibility: req.borrower ? mocks.server.eligibility : [],
    eligible: !!req.borrower && mocks.server.borrowerErrors.length === 0 && mocks.server.eligibility.length === 0,
  };
}

const onOpenChange = vi.fn();
const renderModal = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><SpecialAdvanceModal open onOpenChange={onOpenChange} /></QueryClientProvider>);
};
const click = (id: string) => fireEvent.click(document.getElementById(id) as HTMLElement);
const setPrincipal = (v: string) => fireEvent.change(screen.getByLabelText('Principal (UGX)'), { target: { value: v } });
const previewText = () => document.getElementById('special-advance-preview')?.textContent ?? '';
const serverShown = () => waitFor(() => expect(document.getElementById('special-advance-figures-source')?.textContent).toMatch(/Server calculation/));
const calls = (fn: string) => mocks.rpc.mock.calls.filter(([f]) => f === fn).map(([, a]) => a);

async function fillValid() {
  fireEvent.click(screen.getByText('pick borrower'));
  setPrincipal('500000');
  click('special-advance-rate-monthly-28');
  click('special-advance-term-7');
  await serverShown();
  fireEvent.change(screen.getByLabelText(/Purpose of the advance/), { target: { value: 'Working capital for verified supplier stock' } });
  click('special-advance-confirm');
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks.server, { issuance: true, eligibility: [], borrowerErrors: [], createError: null });
  mocks.rpc.mockImplementation((fn: string, args: { p_request: Record<string, unknown> }) => {
    if (fn === 'special_advance_quote') return Promise.resolve({ data: serverQuote(args.p_request), error: null });
    if (fn === 'special_advance_create') {
      return Promise.resolve(mocks.server.createError ? { data: null, error: mocks.server.createError } : { data: { id: 'sa-1', reference: 'SA-000001', status: 'pending_approval' }, error: null });
    }
    return Promise.resolve({ data: null, error: { message: `unexpected ${fn}` } });
  });
});
afterEach(cleanup);

describe('SpecialAdvanceModal — agreed terms', () => {
  it('offers the approved rates and terms with nothing pre-selected', () => {
    renderModal();
    const rates = within(screen.getByRole('group', { name: 'Agreed access fee rate' })).getAllByRole('button');
    expect(rates.map((b) => b.textContent)).toEqual(['1% per day', '15% per month', '28% per month', 'Custom rate']);
    const terms = within(screen.getByRole('group', { name: 'Agreed term' })).getAllByRole('button');
    expect(terms.map((b) => b.textContent)).toEqual(['7 days', '14 days', '30 days', 'Custom days']);
    for (const b of [...rates, ...terms]) expect(b.getAttribute('aria-pressed')).toBe('false');
  });

  it('shows nothing until principal, agreed rate and term are chosen, and asks the server only then', async () => {
    renderModal();
    setPrincipal('500000');
    expect(document.getElementById('special-advance-preview')).toBeNull();
    expect(screen.getByText(/Choose the agreed rate, term/)).toBeTruthy();
    click('special-advance-rate-monthly-28');
    expect(document.getElementById('special-advance-preview')).toBeNull();
    click('special-advance-term-7');
    expect(document.getElementById('special-advance-preview')).not.toBeNull();
    await serverShown();
    expect(calls('special_advance_quote')).toHaveLength(1);
  });

  it('shows the server figures: 500,000 @ 28%/month for 7 days prorated (32,667)', async () => {
    renderModal();
    setPrincipal('500,000');
    click('special-advance-rate-monthly-28');
    click('special-advance-term-7');
    await serverShown();
    const terms = document.getElementById('special-advance-agreed-terms')?.textContent ?? '';
    expect(terms).toContain('Rate 28% per month');
    expect(terms).toContain('Term 7 days');
    for (const v of [32_667, 20_000, 552_667, 78_953, 78_949]) expect(previewText()).toContain(formatUGX(v));
    expect(previewText()).not.toContain(formatUGX(140_000));
    expect(within(document.getElementById('special-advance-preview') as HTMLElement).getAllByRole('row')).toHaveLength(8);
  });

  it('requires an explicit basis for a custom rate and applies the per-basis limit', async () => {
    renderModal();
    setPrincipal('300000');
    click('special-advance-rate-custom');
    fireEvent.change(screen.getByLabelText('Agreed rate (%)'), { target: { value: '20' } });
    click('special-advance-term-custom');
    fireEvent.change(screen.getByLabelText('Term (days)'), { target: { value: '21' } });
    expect(document.getElementById('special-advance-preview')).toBeNull();
    expect(screen.getByText(/Choose whether the agreed rate is per day or per month/)).toBeTruthy();
    click('special-advance-basis-monthly');
    await serverShown();
    for (const v of [42_000, 362_000]) expect(previewText()).toContain(formatUGX(v));
    click('special-advance-basis-daily');
    expect(document.getElementById('special-advance-preview')).toBeNull();
    expect(screen.getByText(/Enter a rate above 0 and up to 1% per day/)).toBeTruthy();
  });

  it('rejects invalid custom rate and term values', () => {
    renderModal();
    setPrincipal('300000');
    click('special-advance-rate-custom');
    click('special-advance-basis-daily');
    fireEvent.change(screen.getByLabelText('Agreed rate (%)'), { target: { value: '150' } });
    click('special-advance-term-custom');
    fireEvent.change(screen.getByLabelText('Term (days)'), { target: { value: '400' } });
    expect(screen.getByText(/Enter a rate above 0 and up to 1% per day/)).toBeTruthy();
    expect(screen.getByText(/Enter whole days between 1 and 90/)).toBeTruthy();
    expect(document.getElementById('special-advance-preview')).toBeNull();
    for (const bad of ['0', '28.01', '12.345']) {
      click('special-advance-basis-monthly');
      fireEvent.change(screen.getByLabelText('Agreed rate (%)'), { target: { value: bad } });
      expect(screen.getByText(/Enter a rate above 0 and up to 28% per month/)).toBeTruthy();
    }
  });

  it('flags a principal below UGX 10,000', () => {
    renderModal();
    setPrincipal('9999');
    expect(screen.getByText(/minimum principal is UGX 10,000/)).toBeTruthy();
  });

  it('uses access-fee wording and never interest/loan terminology', async () => {
    renderModal();
    await fillValid();
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/Access fee/);
    expect(text).not.toMatch(/\binterest\b|\bloan\b|\blender\b|\bROI\b/i);
  });
});

describe('SpecialAdvanceModal — server eligibility and recording', () => {
  it('never calls the agent eligibility RPC, and sends terms only (no fees or totals) to the quote', async () => {
    renderModal();
    await fillValid();
    expect(mocks.rpc.mock.calls.map(([f]) => f)).not.toContain('agent_advance_blocking_gates');
    const req = calls('special_advance_quote').at(-1) as { p_request: Record<string, unknown> };
    expect(req.p_request).toEqual({ borrower: { kind: 'welile_user', user_id: 'user-1' },
      terms: { principal: 500_000, rate_percent: 28, rate_basis: 'monthly', term_days: 7, frequency: 'daily' } });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('shows the server\'s eligibility result and blocks recording', async () => {
    mocks.server.eligibility = ['OVERDUE_AGENT_ADVANCE'];
    renderModal();
    await fillValid();
    expect(await screen.findByText(/overdue agent advance with a balance/)).toBeTruthy();
    expect((document.getElementById('special-advance-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('while issuance is switched off on the server, it previews only', async () => {
    mocks.server.issuance = false;
    renderModal();
    await fillValid();
    expect(screen.getByText(/Issuance is switched off on the server — preview only/)).toBeTruthy();
    expect(screen.getAllByText(/issuance is switched off on the server/i).length).toBeGreaterThan(0);
    expect((document.getElementById('special-advance-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(calls('special_advance_create')).toHaveLength(0);
  });

  it('records only after the purpose and the explicit confirmation of the server total; sends the confirmed total and a key', async () => {
    renderModal();
    fireEvent.click(screen.getByText('pick borrower'));
    setPrincipal('500000');
    click('special-advance-rate-monthly-28');
    click('special-advance-term-7');
    await serverShown();
    const submit = () => document.getElementById('special-advance-submit') as HTMLButtonElement;
    expect(submit().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Purpose of the advance/), { target: { value: 'Working capital for verified supplier stock' } });
    expect(submit().disabled).toBe(true); // not yet confirmed
    click('special-advance-confirm');
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    const body = (calls('special_advance_create')[0] as { p_request: Record<string, unknown> }).p_request;
    expect(body).toMatchObject({ borrower: { kind: 'welile_user', user_id: 'user-1' }, purpose: 'Working capital for verified supplier stock',
      terms: { principal: 500_000, rate_percent: 28, rate_basis: 'monthly', term_days: 7, frequency: 'daily' }, expected_total_repayable: 552_667 });
    expect(String(body.idempotency_key)).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(body).sort()).toEqual(['borrower', 'expected_total_repayable', 'idempotency_key', 'purpose', 'terms']);
    expect(Object.keys(body.terms as object).sort()).toEqual(['frequency', 'principal', 'rate_basis', 'rate_percent', 'term_days']);
    expect(mocks.toast.success).toHaveBeenCalledWith('SA-000001 recorded — pending approval');
  });

  it('changing the terms withdraws the confirmation (the total changed)', async () => {
    renderModal();
    await fillValid();
    expect((document.getElementById('special-advance-confirm') as HTMLElement).getAttribute('aria-checked')).toBe('true');
    click('special-advance-term-14');
    await waitFor(() => expect(previewText()).toContain(formatUGX(585_333)));
    await serverShown();
    expect((document.getElementById('special-advance-confirm') as HTMLElement).getAttribute('aria-checked')).toBe('false');
    expect((document.getElementById('special-advance-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a server refusal, stays open, and retries with the same key', async () => {
    mocks.server.createError = { code: '22023', message: 'QUOTE_CHANGED', details: '{"total_repayable": 552668}' };
    renderModal();
    await fillValid();
    fireEvent.click(document.getElementById('special-advance-submit') as HTMLElement);
    expect(await screen.findByText(/server total has changed to UGX 552,668/)).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    mocks.server.createError = null;
    fireEvent.click(document.getElementById('special-advance-submit') as HTMLElement);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    const keys = calls('special_advance_create').map((a) => (a as { p_request: { idempotency_key: string } }).p_request.idempotency_key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('external individual: NIN field, server identity check shown; entity: registration number field', async () => {
    mocks.server.borrowerErrors = ['national_id'];
    renderModal();
    click('borrower-type-external');
    expect(screen.getByLabelText(/National ID \/ NIN \*/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Full Name/), { target: { value: 'David Kato' } });
    fireEvent.change(screen.getByLabelText(/Phone Number/), { target: { value: '0772000111' } });
    setPrincipal('500000');
    click('special-advance-rate-monthly-28');
    click('special-advance-term-7');
    await serverShown();
    expect(previewText()).toContain('Borrower: David Kato (External)');
    expect(await screen.findByText(/Check the National ID \(NIN\)/)).toBeTruthy();
    const req = calls('special_advance_quote').at(-1) as { p_request: { borrower: Record<string, unknown> } };
    expect(req.p_request.borrower).toMatchObject({ kind: 'external', borrower_type: 'individual', full_name: 'David Kato', phone: '0772000111' });
    click('external-kind-entity');
    expect(screen.getByLabelText(/Company registration number/)).toBeTruthy();
  });
});
