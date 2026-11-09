/**
 * Partner Returns Phase 5, open items O3 (item 17 data side), O5 and O7.
 *
 *  O3  SupportPlanExample, FunderDirectHouseListing, FunderEarningsAssumptions and
 *      FunderEarningsBreakdown price at a rate they are given (no deprecated fixed-15% helper).
 *      Public page -> the public new-partner rate; signed-in partner screens -> the viewer's own
 *      rate. At 15 (the switch-off answer) every figure and sentence is exactly today's.
 *  O5  WithdrawFlow treats a null Returns balance as unknown: never a cap, never withdrawable.
 *  O7  PartnerReturnPolicyCard shows "—" for a missing rate (never "0" or an empty cell).
 */
import type { ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...args: unknown[]) => mocks.rpc(...args) },
}));
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ enabledRoles: ['cfo'], roles: ['cfo'], user: { id: 'cfo-user' } }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/haptics', () => ({ hapticTap: () => {}, hapticSelection: () => {}, hapticImpact: () => {} }));

import { SupportPlanExample } from '@/components/support-plan/SupportPlanExample';
import { FunderEarningsAssumptions } from '@/components/supporter/FunderEarningsAssumptions';
import { FunderEarningsBreakdown } from '@/components/supporter/FunderEarningsBreakdown';
import { PartnerReturnPolicyCard } from '@/components/cfo/PartnerReturnPolicyCard';
import { calcFunderEarningsAt } from '@/lib/funderEarnings';
// Test-only use of the deprecated fixed-15% helpers: they define "today's figures" for parity.
import { calcFunderEarnings } from '@/lib/funderEarnings';
import { SUPPORT_EXAMPLE_STEPS, buildSupportPlanExampleLine } from '@/lib/supportPlanExample';
import { formatUGX } from '@/lib/rentCalculations';

/** Whitespace-normalised text (formatUGX may use a non-breaking space). */
const norm = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ');

const src = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

beforeEach(() => { cleanup(); mocks.rpc.mockReset(); });

// ---- O3: SupportPlanExample -------------------------------------------------------------------------
describe('SupportPlanExample prices at the rate it is given', () => {
  it("at 15 (switch off) it reads exactly as today's fixed example", () => {
    render(<SupportPlanExample fundingAmount={700_000} rate={15} />);
    for (const step of SUPPORT_EXAMPLE_STEPS) expect(screen.getByText(step)).toBeTruthy();
    expect(screen.getByText(buildSupportPlanExampleLine(700_000) as string)).toBeTruthy();
  });

  it('at 10 the figures follow the rate', () => {
    render(<SupportPlanExample fundingAmount={700_000} rate={10} />);
    expect(screen.getByText('You earn UGX 10,000 every month for 12 months (UGX 120,000 total).')).toBeTruthy();
    expect(screen.getByText(/earn UGX 70,000\/month/)).toBeTruthy();
  });

  it('without a rate it shows no Returns figure and hides the for-this-plan line', () => {
    const { container } = render(<SupportPlanExample fundingAmount={700_000} rate={null} />);
    expect(container.textContent).not.toMatch(/15,000|105,000|180,000/);
    expect(container.textContent).not.toContain('For this plan');
    expect(screen.getByText(/at the rate shown in the app/)).toBeTruthy();
  });

  it('the public page passes the public rate; the signed-in sales sheet passes the own rate', () => {
    const publicPage = src('pages/SupportPlanPublic.tsx');
    expect(publicPage).toContain('usePartnerReturnPolicy()');
    expect(publicPage).toContain('<SupportPlanExample fundingAmount={plan.fundingAmount} rate={newContractRate}');
    const panel = src('components/funder-new/FunderNewSelectionPanel.tsx');
    expect(panel).toContain('useOwnNewPortfolioRate()');
    expect(panel).toContain('<SupportPlanExample fundingAmount={item.amount} rate={ownRate} />');
    expect(panel).not.toMatch(/\bnewContractRate\b/);
  });
});

// ---- O3: FunderEarningsBreakdown / FunderEarningsAssumptions / FunderDirectHouseListing ----------------
describe('funder earnings components take the rate', () => {
  const start = new Date('2026-11-07T00:00:00Z');

  it("calcFunderEarningsAt at 15 equals today's fixed-15% figures", () => {
    for (const rent of [0, 1, 99_999, 250_000, 333_333, 1_250_001]) {
      const { rate: _rate, ...at } = calcFunderEarningsAt(rent, start, 15);
      expect(at).toEqual(calcFunderEarnings(rent, start));
    }
  });

  it("the breakdown at 15 shows today's rows; without a rate it shows '—'", () => {
    const earn15 = calcFunderEarningsAt(250_000, start, 15);
    const first = render(<FunderEarningsBreakdown earn={earn15} />);
    fireEvent.click(screen.getByRole('button', { name: /breakdown/i }));
    expect(screen.getByText('Rent × 15%')).toBeTruthy();
    expect(norm(first.container.textContent)).toContain(norm(formatUGX(37_500)));
    expect(norm(first.container.textContent)).toContain(norm(formatUGX(450_000)));
    cleanup();

    const second = render(<FunderEarningsBreakdown earn={calcFunderEarningsAt(250_000, start, null)} />);
    fireEvent.click(screen.getByRole('button', { name: /breakdown/i }));
    expect(screen.getAllByText('—').length).toBe(4); // monthly, 12-month, daily, weekly
    expect(norm(second.container.textContent)).toContain(norm(formatUGX(250_000))); // the rent is still known
    expect(norm(second.container.textContent)).not.toContain(norm(formatUGX(0)));
  });

  it("the assumptions note states today's 15% at 15, and no rate figure without one", () => {
    render(<FunderEarningsAssumptions startDate={start} endDate={start} daysInTerm={365} rate={15} />);
    fireEvent.click(screen.getByRole('button', { name: /how these projections/i }));
    expect(screen.getByText('Monthly earning = house monthly rent × 15%.')).toBeTruthy();
    cleanup();
    render(<FunderEarningsAssumptions startDate={start} endDate={start} daysInTerm={365} rate={null} />);
    fireEvent.click(screen.getByRole('button', { name: /how these projections/i }));
    expect(screen.queryByText(/× 15%/)).toBeNull();
  });

  it('FunderDirectHouseListing uses the own rate and the ...At helpers only', () => {
    const code = src('components/supporter/FunderDirectHouseListing.tsx');
    expect(code).toContain('useOwnNewPortfolioRate()');
    expect(code).not.toMatch(/\b(?:calcFunderEarnings|sumFunderEarnings)\(/);
    expect(code).toContain('sumFunderEarningsAt(selectedHouses.map((h) => h.monthly_rent), moveInDate, ownRate)');
    expect(code).toContain('calcFunderEarningsAt(house.monthly_rent, moveInDate, ownRate)');
    expect(code).toMatch(/<FunderEarningsAssumptions[\s\S]*?rate=\{ownRate\}/);
    expect(code).not.toMatch(/\bnewContractRate\b/);
  });

  it('none of the four files imports a deprecated fixed-15% helper', () => {
    for (const f of [
      'components/support-plan/SupportPlanExample.tsx',
      'components/supporter/FunderDirectHouseListing.tsx',
      'components/supporter/FunderEarningsAssumptions.tsx',
      'components/supporter/FunderEarningsBreakdown.tsx',
    ]) {
      expect(src(f)).not.toMatch(/\b(?:FUNDER_MONTHLY_RATE|calcFunderEarnings|sumFunderEarnings|SUPPORT_EXAMPLE_STEPS|buildSupportPlanExampleLine)\b(?!At)/);
    }
  });
});

// ---- O5: WithdrawFlow and a null Returns balance --------------------------------------------------------
describe('WithdrawFlow: a null Returns balance is unknown, never withdrawable (O5)', () => {
  const code = src('components/payments/WithdrawFlow.tsx');

  it('keeps null apart from 0 and from a cap', () => {
    expect(code).toContain("roiBalance?: number | null;");
    expect(code).toContain("const roiCap = typeof roiBalance === 'number' && Number.isFinite(roiBalance) ? roiBalance : null;");
    expect(code).toContain("const rawMax = source === 'available' ? trueAvailable : roiCap;");
    expect(code).toContain('const maxUnknown = rawMax === null;');
    expect(code).not.toMatch(/:\s*roiBalance;/);
  });

  it('both gated steps refuse while the cap is unknown', () => {
    const steps = code.slice(code.indexOf('case 1:'), code.indexOf('default: return false;'));
    expect(steps.match(/!maxUnknown &&/g)?.length).toBe(2);
  });

  it('the amount step refuses an unknown Returns cap before comparing amounts', () => {
    const at = code.indexOf('            : roiCap;');
    expect(at).toBeGreaterThan(-1);
    const after = code.slice(at, at + 300);
    expect(after).toMatch(/if \(freshMax === null\) \{[\s\S]*?return false;/);
  });

  it('FunderQuickActions passes null through (its default replaces only undefined)', () => {
    expect(src('components/supporter/FunderQuickActions.tsx')).toContain('roiBalance?: number | null;');
  });
});

// ---- O7: PartnerReturnPolicyCard ------------------------------------------------------------------------
describe('PartnerReturnPolicyCard: a missing rate shows "—" (O7)', () => {
  function renderCard(policy: Record<string, unknown>) {
    mocks.rpc.mockImplementation(async (fn: string) =>
      fn === 'get_partner_return_policy' ? { data: policy, error: null } : { data: null, error: null });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    return render(<PartnerReturnPolicyCard />, { wrapper });
  }
  const base = { enabled: false, new_contract_rate: 15, policy_rate: 10, legacy_rate: 15, enabled_at: null, updated_at: '2026-11-05T07:00:00Z' };

  it("switch off with both rates: today's figures", async () => {
    renderCard(base);
    const rateWhenOn = await screen.findByText('Rate when on');
    expect(rateWhenOn.nextElementSibling?.textContent).toBe('10%');
    expect(screen.getByText('Legacy rate (off)').nextElementSibling?.textContent).toBe('15%');
  });

  it('a missing policy or legacy rate shows "—"', async () => {
    renderCard({ ...base, policy_rate: null, legacy_rate: null });
    const rateWhenOn = await screen.findByText('Rate when on');
    expect(rateWhenOn.nextElementSibling?.textContent).toBe('—');
    expect(screen.getByText('Legacy rate (off)').nextElementSibling?.textContent).toBe('—');
  });

  it('the data expressions carry no 0 default', () => {
    const code = src('components/cfo/PartnerReturnPolicyCard.tsx');
    expect(code).not.toMatch(/\?\?\s*0\b/);
    expect(code).toContain("const policyRate = formatRatePct(rateOrNull(p?.policy_rate)) ?? '—';");
    expect(code).toContain("const newContractRatePct = formatRatePct(rateOrNull(p?.new_contract_rate)) ?? '—';");
  });
});
