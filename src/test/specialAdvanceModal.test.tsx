import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), functionsInvoke: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from, functions: { invoke: mocks.functionsInvoke } },
}));
vi.mock('@/components/cfo/UserSearchPicker', () => ({
  UserSearchPicker: ({ onSelect, selectedUser, label }: { onSelect: (u: unknown) => void; selectedUser: { full_name: string } | null; label: string }) => (
    <div>
      <span>{label}</span>
      {selectedUser ? <span>Selected: {selectedUser.full_name}</span> : null}
      <button type="button" onClick={() => onSelect({ id: 'agent-1', full_name: 'Jane Agent', phone: '256700000000' })}>pick agent</button>
    </div>
  ),
}));
import { SpecialAdvanceModal } from '@/components/cfo/SpecialAdvanceModal';
import { formatUGX } from '@/lib/agentAdvanceCalculations';

const renderModal = () => render(<SpecialAdvanceModal open onOpenChange={vi.fn()} />);
const click = (id: string) => fireEvent.click(document.getElementById(id) as HTMLElement);
const setPrincipal = (v: string) => fireEvent.change(screen.getByLabelText('Principal (UGX)'), { target: { value: v } });
const previewText = () => document.getElementById('special-advance-preview')?.textContent ?? '';

describe('SpecialAdvanceModal (preview only)', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.from.mockReset();
    mocks.functionsInvoke.mockReset();
    mocks.rpc.mockResolvedValue({ data: { labels: [], blocked: false }, error: null });
  });
  afterEach(cleanup);

  it('offers the approved rates and terms with nothing pre-selected', () => {
    renderModal();
    const rates = within(screen.getByRole('group', { name: 'Agreed access fee rate' })).getAllByRole('button');
    expect(rates.map((b) => b.textContent)).toEqual(['1% per day', '15% per month', '28% per month', 'Custom rate']);
    const terms = within(screen.getByRole('group', { name: 'Agreed term' })).getAllByRole('button');
    expect(terms.map((b) => b.textContent)).toEqual(['7 days', '14 days', '30 days', 'Custom days']);
    for (const b of [...rates, ...terms]) expect(b.getAttribute('aria-pressed')).toBe('false');
  });

  it('shows no preview until principal, agreed rate and term are all chosen', () => {
    renderModal();
    setPrincipal('500000');
    expect(document.getElementById('special-advance-preview')).toBeNull();
    expect(screen.getByText(/Choose the agreed rate, term/)).toBeTruthy();
    click('special-advance-rate-monthly-28');
    expect(document.getElementById('special-advance-preview')).toBeNull();
    click('special-advance-term-7');
    expect(document.getElementById('special-advance-preview')).not.toBeNull();
  });

  it('previews 500,000 @ 28%/month for 7 days prorated (32,667), with rate, basis and term shown', () => {
    renderModal();
    setPrincipal('500,000');
    click('special-advance-rate-monthly-28');
    click('special-advance-term-7');
    const terms = document.getElementById('special-advance-agreed-terms')?.textContent ?? '';
    expect(terms).toContain('Rate 28% per month');
    expect(terms).toContain('Basis per month');
    expect(terms).toContain('Term 7 days');
    for (const v of [32_667, 20_000, 552_667, 78_953, 78_949]) expect(previewText()).toContain(formatUGX(v));
    expect(previewText()).not.toContain(formatUGX(140_000));
    const table = within(document.getElementById('special-advance-preview') as HTMLElement);
    expect(table.getAllByRole('row')).toHaveLength(8); // header + 7 instalments
  });

  it('previews 1% per day simply (500,000 × 14 days = 70,000)', () => {
    renderModal();
    setPrincipal('500000');
    click('special-advance-rate-daily-1');
    click('special-advance-term-14');
    expect(previewText()).toContain('Rate 1% per day');
    for (const v of [70_000, 590_000, 42_143]) expect(previewText()).toContain(formatUGX(v));
  });

  it('requires an explicit basis for a custom rate and supports custom days', () => {
    renderModal();
    setPrincipal('300000');
    click('special-advance-rate-custom');
    fireEvent.change(screen.getByLabelText('Agreed rate (%)'), { target: { value: '20' } });
    click('special-advance-term-custom');
    fireEvent.change(screen.getByLabelText('Term (days)'), { target: { value: '21' } });
    expect(document.getElementById('special-advance-preview')).toBeNull();
    expect(screen.getByText(/Choose whether the agreed rate is per day or per month/)).toBeTruthy();
    click('special-advance-basis-monthly');
    expect(previewText()).toContain('Rate 20% per month');
    expect(previewText()).toContain('Term 21 days');
    for (const v of [42_000, 362_000]) expect(previewText()).toContain(formatUGX(v));
    // 20% is within the monthly limit but far above the 1% daily limit: switching the basis refuses it
    click('special-advance-basis-daily');
    expect(document.getElementById('special-advance-preview')).toBeNull();
    expect(screen.getByText(/Enter a rate above 0 and up to 1% per day/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Agreed rate (%)'), { target: { value: '0.5' } });
    expect(previewText()).toContain('Rate 0.5% per day');
    for (const v of [31_500, 351_500]) expect(previewText()).toContain(formatUGX(v)); // 300,000 × 0.5% × 21
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
  });

  it('refuses 0%, more than 2 decimals and a monthly rate above 28%', () => {
    renderModal();
    setPrincipal('300000');
    click('special-advance-rate-custom');
    click('special-advance-basis-monthly');
    click('special-advance-term-14');
    for (const bad of ['0', '28.01', '12.345']) {
      fireEvent.change(screen.getByLabelText('Agreed rate (%)'), { target: { value: bad } });
      expect(screen.getByText(/Enter a rate above 0 and up to 28% per month/)).toBeTruthy();
      expect(document.getElementById('special-advance-preview')).toBeNull();
    }
    fireEvent.change(screen.getByLabelText('Agreed rate (%)'), { target: { value: '28' } });
    expect(previewText()).toContain('Rate 28% per month');
  });

  it('uses access-fee wording and never interest/loan terminology', () => {
    renderModal();
    setPrincipal('500000');
    click('special-advance-rate-monthly-15');
    click('special-advance-term-30');
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/Access fee/);
    expect(text).not.toMatch(/\binterest\b|\bloan\b|\blender\b|\bROI\b/i);
  });

  it('has no issue/submit action', () => {
    renderModal();
    setPrincipal('500000');
    click('special-advance-rate-monthly-28');
    click('special-advance-term-7');
    const names = screen.getAllByRole('button').map((b) => (b.textContent ?? '').trim());
    expect(names.some((n) => /issue|submit|disburse|approve|confirm/i.test(n))).toBe(false);
    expect(screen.getByText(/Issuing is not connected yet/)).toBeTruthy();
  });

  it('only calls the read-only eligibility RPC, without the agreed rate — never issuance, disbursement or table writes', async () => {
    renderModal();
    setPrincipal('500000');
    click('special-advance-rate-monthly-28');
    fireEvent.click(screen.getByText('pick agent'));
    await waitFor(() => expect(screen.getByText(/No eligibility conditions raised/)).toBeTruthy());
    expect(mocks.rpc).toHaveBeenLastCalledWith('agent_advance_blocking_gates', { p_agent_id: 'agent-1', p_principal: 500_000, p_monthly_rate: null });
    for (const [fn] of mocks.rpc.mock.calls) expect(fn).toBe('agent_advance_blocking_gates');
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.functionsInvoke).not.toHaveBeenCalled();
  });

  it('treats a failed eligibility read as blocked rather than clear', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: new Error('permission denied') });
    renderModal();
    fireEvent.click(screen.getByText('pick agent'));
    expect(await screen.findByText(/permission denied/)).toBeTruthy();
    expect(screen.queryByText(/No eligibility conditions raised/)).toBeNull();
  });

  it('supports external borrowers outside Welile and does not run agent gates', async () => {
    renderModal();
    click('borrower-type-external');
    expect(screen.getByLabelText(/Full Name/)).toBeTruthy();
    expect(screen.getByLabelText(/Phone Number/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Full Name/), { target: { value: 'David Kato' } });
    fireEvent.change(screen.getByLabelText(/Phone Number/), { target: { value: '0772000111' } });
    setPrincipal('500000');
    click('special-advance-rate-monthly-28');
    click('special-advance-term-7');

    expect(previewText()).toContain('Borrower: David Kato (External)');
    // Agent blocking gates must NOT be called for external borrowers
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(screen.getByText(/External borrower outside Welile/)).toBeTruthy();
  });
});
