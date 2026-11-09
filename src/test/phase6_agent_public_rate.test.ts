/**
 * Partner Returns, Phase 6 fix round (audit W1): the agent and public screens' DATA lines quote the
 * public new-partner rate (or the rate an RPC quoted), never a fixed 15%. Runs in every test run: the
 * copy that still says "15%" is Gemini item 3 and is checked by the opt-in release gate
 * (partnerRateRelease.test.ts, AGENT_PUBLIC_FILES).
 *
 * Switch-off parity: while the switch has never been on the public rate is 15, and these helpers give
 * exactly today's figures.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatRatePct, monthlyReturnFor } from '@/lib/partnerReturnPolicy';

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

/** A fixed rate in arithmetic: `* 0.15`, `0.15 *`, `* 1.15`, `* 0.005` (15%/30), or a RATE constant. */
const FIXED_RATE_MATH = /[*/]\s*[01]?\.(?:15|005)\b|\b0?\.15\s*[*/]|\b[A-Z_]*ROI_RATE\b|\bHOUSE_MONTHLY_ROI_RATE\b/;

const WIRED: Record<string, RegExp> = {
  'components/agent/PromissoryNoteDialog.tsx': /usePartnerReturnPolicy\(\)/,
  'components/agent/EmptyHouseOpportunitiesSheet.tsx': /returns_rate_pct/,
  'components/agent/EmptyHouseDetailSheet.tsx': /usePartnerReturnPolicy\(\)[\s\S]*useOwnNewPortfolioRate\(\)/,
  'components/agent/SupportModeChooserDialog.tsx': /usePartnerReturnPolicy\(\)/,
  'components/agent/ProxySupportOpportunities.tsx': /usePartnerReturnPolicy\(\)/,
  'components/dashboards/AgentDashboard.tsx': /getPublicPartnerRate\(\)/,
  'components/dashboards/AgentDashboardBk.tsx': /getPublicPartnerRate\(\)/,
  'components/angel-pool/CapitalOpportunityEntry.tsx': /usePartnerReturnPolicy\(\)/,
  'pages/AngelPool.tsx': /usePartnerReturnPolicy\(\)/,
  'pages/Calculator.tsx': /usePartnerReturnPolicy\(\)/,
  'pages/TryCalculator.tsx': /usePartnerReturnPolicy\(\)/,
  'pages/Onboarding.tsx': /usePartnerReturnPolicy\(\)/,
  'pages/SupportPlanPublic.tsx': /usePartnerReturnPolicy\(\)/,
};

describe('Phase 6: agent and public screens price at the public rate', () => {
  it.each(Object.entries(WIRED))('%s reads the rate from the database', (file, source) => {
    expect(read(file)).toMatch(source);
  });

  it('no fixed-rate arithmetic remains in those files', () => {
    const offenders = Object.keys(WIRED).flatMap((f) =>
      read(f)
        .split(/\r?\n/)
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => {
          const t = line.trim();
          return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && FIXED_RATE_MATH.test(line);
        })
        .map(({ line, n }) => `${f}:${n}: ${line.trim().slice(0, 100)}`),
    );
    expect(offenders).toEqual([]);
  });

  it('an agent quotes the public rate, a partner in partner mode their own (empty-house list)', () => {
    const code = read('components/agent/EmptyHouseOpportunitiesSheet.tsx');
    expect(code).toMatch(/\.\.\.\(isPartner \? \{ p_quote_for: 'me' \} : \{\}\)/);
    expect(code).toMatch(/isPartner \? 'me' : 'public'\]/);
  });

  it('the agent dashboards build the partner invite from the public rate, with no figure when unknown', () => {
    for (const f of ['components/dashboards/AgentDashboard.tsx', 'components/dashboards/AgentDashboardBk.tsx']) {
      const code = read(f);
      expect(code, f).toContain('earn ${newRatePct} monthly Returns!');
      expect(code, f).toContain('earn monthly Returns! Register here');
      expect(code, f).not.toMatch(/earn 15% monthly Returns/);
    }
  });

  it('switch-off parity: at 15 the helpers give exactly the old figures', () => {
    expect(formatRatePct(15)).toBe('15%');
    for (const amount of [0, 1, 999, 1010, 9997, 50_000, 150_000, 333_333, 1_250_000, 2_999_999]) {
      expect(monthlyReturnFor(amount, 15)).toBe(Math.round(amount * 0.15));
    }
    // The calculators divide the percentage by 100: the same double as the old 0.15 literal.
    expect(15 / 100).toBe(0.15);
    expect(1 + 15 / 100).toBe(1.15);
    expect(15 / 3000).toBe(0.005);
  });

  it('unknown rate -> no figure (never a guessed 15)', () => {
    expect(formatRatePct(null)).toBeNull();
    expect(monthlyReturnFor(100_000, null)).toBeNull();
  });
});

/**
 * Switch never on (public rate 15): every figure and share text on the rewired screens equals what the
 * screen showed before Phase 6. Each case first pins the exact expression the screen now uses (so a
 * later edit to the formula re-opens the question), then checks it against the old expression.
 */
describe('Phase 6: with the switch never on, the rewired screens show exactly the old figures', () => {
  // The three exhaustive loops take about 2 s each alone; give them room under a full parallel run.
  const RATE = 15; // get_partner_return_policy().newContractRate while the switch has never been on

  /** The old compact format (useCurrency().formatAmountCompact) at a display-currency rate. */
  const compact = (ugx: number, fx: number) => {
    const v = ugx * fx;
    if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
    return v.toFixed(0);
  };
  const FX = [1, 0.029, 1 / 3650, 0.00025, 0.69, 0.42]; // UGX, KES, USD, EUR, TZS, NGN fallback rates

  it('CapitalOpportunityEntry (TenantPreview): monthly and daily figures display as before', () => {
    const code = read('components/angel-pool/CapitalOpportunityEntry.tsx');
    expect(code).toContain('const monthlyReturn = rate === null ? null : (amount * rate) / 100;');
    expect(code).toContain('const dailyReturn = rate === null ? null : (amount * rate) / 3000;');
    // The doubles can differ in the last bit (3 * 0.15 = 0.44999999999999996, 3 * 15 / 100 = 0.45),
    // but never in what formatAmountCompact prints. Every amount to 2,000,000, then every share step
    // (20,000) to the 50,000,000 slider maximum, with odd amounts around each step.
    let checked = 0;
    for (const fx of FX) {
      const check = (a: number) => {
        const nm = (a * RATE) / 100;
        const nd = (a * RATE) / 3000;
        if (nm !== a * 0.15 && compact(nm, fx) !== compact(a * 0.15, fx)) throw new Error(`monthly ${a} @${fx}`);
        if (nd !== a * 0.005 && compact(nd, fx) !== compact(a * 0.005, fx)) throw new Error(`daily ${a} @${fx}`);
        checked++;
      };
      for (let a = 0; a <= 2_000_000; a++) check(a);
      for (let a = 2_000_000; a <= 50_000_000; a += 20_000) [a, a + 1, a + 7, a + 9_999].forEach(check);
    }
    expect(checked).toBeGreaterThan(12_000_000);
  }, 60_000);

  it('AngelPool: the 5,000,000 hero figure is the same double', () => {
    const code = read('pages/AngelPool.tsx');
    expect(code).toContain('const myInvestment = 5_000_000;');
    expect(code).toContain('(myInvestment * heroRate) / 100');
    expect((5_000_000 * RATE) / 100).toBe(5_000_000 * 0.15);
  });

  it('Calculator, TryCalculator and Onboarding use rate / 100: the same double as the old 0.15', () => {
    for (const f of ['pages/Calculator.tsx', 'pages/TryCalculator.tsx', 'pages/Onboarding.tsx']) {
      expect(read(f), f).toContain('const monthlyRate = ratePct === null ? null : ratePct / 100;');
    }
    expect(read('pages/Calculator.tsx')).toContain('Math.ceil(desiredEarnings / monthlyRate)');
    expect(read('pages/Onboarding.tsx')).toContain('bal = bal * (1 + r);');
    const r = RATE / 100;
    expect(Object.is(r, 0.15)).toBe(true);
    expect(Object.is(1 + r, 1.15)).toBe(true);
    for (const d of [1, 999, 10_000, 150_000, 1_234_567]) {
      expect(Math.ceil(d / r)).toBe(Math.ceil(d / 0.15));
    }
  });

  it('EmptyHouse list and detail, ProxySupportOpportunities: the old Math.round(rent * 0.15)', () => {
    expect(read('components/agent/EmptyHouseOpportunitiesSheet.tsx')).toContain('monthlyReturnFor(amount, quoteRate)');
    expect(read('components/agent/EmptyHouseDetailSheet.tsx')).toContain('monthlyReturnFor(rent, returnsRate)');
    expect(read('components/agent/ProxySupportOpportunities.tsx')).toContain('monthlyReturnFor(rent, rate)');
    for (let rent = 0; rent <= 3_000_000; rent++) {
      if (monthlyReturnFor(rent, RATE) !== Math.round(rent * 0.15)) throw new Error(`rent ${rent}`);
      // ProxySupportOpportunities used Math.round(rent * HOUSE_MONTHLY_ROI_RATE / 100), the constant being 15.
      if (monthlyReturnFor(rent, RATE) !== Math.round((rent * 15) / 100)) throw new Error(`proxy rent ${rent}`);
    }
  }, 60_000);

  it('PromissoryNoteDialog preview: the same UGX text as the old unrounded formatUGX(amount * 0.15)', () => {
    expect(read('components/agent/PromissoryNoteDialog.tsx')).toContain('monthlyReturnFor(parsedAmount, newContractRate)');
    const ugx = new Intl.NumberFormat('en-UG', { style: 'currency', currency: 'UGX', currencyDisplay: 'code', minimumFractionDigits: 0, maximumFractionDigits: 0 });
    for (let a = 0; a <= 1_000_000; a++) {
      if (ugx.format(monthlyReturnFor(a, RATE) as number) !== ugx.format(a * 0.15)) throw new Error(`amount ${a}`);
    }
  }, 60_000);

  /** Fill a template from the source the way JS would, for the named variables. */
  const fill = (template: string, vars: Record<string, string>) =>
    template.replace(/\$\{(\w+)\}/g, (m, name: string) => (name in vars ? vars[name] : m));
  const templateOn = (code: string, marker: string) => {
    const line = code.split(/\r?\n/).find((l) => l.includes(marker));
    expect(line, marker).toBeDefined();
    return /`([^`]*)`/.exec(line as string)![1];
  };

  it('share texts at 15% are word for word the old ones', () => {
    const L = 'https://wel.ile/x';
    for (const f of ['components/dashboards/AgentDashboard.tsx', 'components/dashboards/AgentDashboardBk.tsx']) {
      const t = templateOn(read(f), 'earn ${newRatePct} monthly Returns!');
      expect(fill(t, { newRatePct: formatRatePct(RATE)!, partnerFormLink: L }), f).toBe(`🤝 Partner with Welile and earn 15% monthly Returns! Register here: ${L}`);
    }
    const pn = templateOn(read('components/agent/PromissoryNoteDialog.tsx'), 'start earning ${newRatePct} Returns!');
    expect(fill(pn, { partnerName: 'Amina', newRatePct: '15%', activationLink: L })).toBe(`Hi Amina, activate your Welile funding account and start earning 15% Returns! ${L}`);

    const sp = read('pages/SupportPlanPublic.tsx');
    const earn = /ratePct \? `([^`]*)`/.exec(sp)![1];
    const msg = templateOn(sp, 'keep their home. Support their rent on Welile and ${earn}');
    expect(fill(msg, { who: 'Amina', earn: fill(earn, { ratePct: '15%' }), link: L })).toBe(
      `Help Amina keep their home. Support their rent on Welile and earn 15% of the rent monthly for 12 months, with Welile's operational guarantee. See the plan: ${L}`,
    );
    expect(fill(templateOn(sp, 'once and earn ${newRatePct} of their rent'), { newRatePct: '15%' })).toBe(
      "Turn rent into an asset. Support this tenant's rent once and earn 15% of their rent every month for 12 months.",
    );

    expect(fill(templateOn(read('pages/Calculator.tsx'), 'Monthly Returns: ${ratePctLabel}'), { ratePctLabel: '15%' })).toBe('📈 Monthly Returns: 15%\\n');
    expect(fill(templateOn(read('pages/TryCalculator.tsx'), 'doc.text(`Monthly Returns: ${ratePctLabel}`'), { ratePctLabel: '15%' })).toBe('Monthly Returns: 15%');

    const eh = read('components/agent/EmptyHouseOpportunitiesSheet.tsx');
    expect(eh).toContain("const homes = `${picked.length} home${picked.length === 1 ? '' : 's'}`;");
    const ehText = fill(templateOn(eh, 'and earn ${quoteRatePct} of that rent every month'), { partnerName: 'Amina', homes: '2 homes', quoteRatePct: '15%', link: L });
    // Old: formatUGX(rentTotal) and formatUGX(monthlyReturn); at 15 the monthly figure is a number, so
    // formatUGXOrDash prints what formatUGX printed.
    expect(ehText).toBe(
      `Hi Amina, you are supporting 2 homes on Welile. You contribute one month of rent (\${formatUGX(rentTotal)}) and earn 15% of that rent every month for 12 months — \${formatUGXOrDash(monthlyReturn)} per month. Activate here: ${L}`,
    );
  });

  it('the one wording change: the TryCalculator share text now says "Returns" (was "returns")', () => {
    expect(read('pages/TryCalculator.tsx')).toContain("Want to earn ${ratePctLabel ? `${ratePctLabel} monthly Returns` : 'monthly Returns'}?");
  });
});
