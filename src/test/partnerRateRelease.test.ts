/**
 * Partner Returns RELEASE GATE (design v2 §8.5 #3, §10.2). Expected RED until the screen work in
 * design v2 §6.2 has landed; the release checklist runs it before the release migration sets
 * release_ready, together with the Deno release scan (§8.5 #2 agreements, T1.11b):
 *
 *   PARTNER_RATE_RELEASE_GATE=1 npx vitest run src/test/partnerRateRelease.test.ts
 *   deno test --allow-read supabase/functions/_shared/releaseScan_test.ts
 *
 * Skipped in a normal test run so the red gate does not block unrelated work.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const rel = (full: string) => relative(SRC, full).split(sep).join('/');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === '__snapshots__' || name === 'tests') continue;
      out.push(...files(full));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * A fixed partner Returns rate in screen code: "15%", 0.15, 15/100, a `?? 15` / `|| 15` fallback, or a
 * RATE constant of 10/15. The D8 sentence about the 360 engine's partner leg ("sets aside 15% for
 * Partner Returns") is allowed: it describes the plan, not anyone's rate.
 */
const FIXED_RATE = /\b15\s*%|\b0?\.15\b|(?<![\w.])\.15\b|\b15\s*\/\s*100\b|(?:\?\?|\|\|)\s*15\b|\b[A-Z_]*RATE\s*=\s*(?:0?\.1|0?\.15|10|15)\b/;
const D8_SENTENCE = /sets aside 15% for Partner Returns/g;
/** fixedRateLines over a text (label = the file name in each hit). `strip` removes look-alike tokens first. */
function fixedRateLinesIn(text: string, label: string, strip: (line: string) => string = (l) => l): string[] {
  return text
    .split(/\r?\n/)
    .map((raw, i) => ({ raw, line: strip(raw.replace(D8_SENTENCE, '')), n: i + 1 }))
    .filter(({ line }) => {
      const t = line.trim();
      // Comments (incl. JSX `{/* … */}`) are not shown to anyone.
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('{/*') && FIXED_RATE.test(line);
    })
    .map(({ raw, n }) => `${label}:${n}: ${raw.trim().slice(0, 120)}`);
}
const fixedRateLines = (f: string): string[] => fixedRateLinesIn(read(f), f);

/** Signed-in partner screens: own next-portfolio figures come from useOwnNewPortfolioRate (§6.1). */
const OWN_RATE_SCREENS = [
  'components/partner/SelfPortfolioDeployDialog.tsx',
  'components/funder-new/FunderNewCalculatorDialog.tsx',
  'components/funder-new/FunderNewSelectionPanel.tsx',
  'components/supporter/FundAccountDialog.tsx',
  'components/dashboards/SupporterDashboard.tsx',
  'components/supporter/FunderBookedHousesPanel.tsx',
  'components/supporter/InvestmentCalculator.tsx',
  'components/supporter/InvestmentPackageSheet.tsx',
  'components/supporter/FundRentDialog.tsx',
  'components/partner/SelfPortfolioFundingCard.tsx',
  // The rent-facilitation reward a supporter earns by funding a rent request is stamped at their own
  // rate (rent_facilitation_reward_rates), the rate useOwnNewPortfolioRate quotes.
  'components/supporter/PayLandlordDialog.tsx',
  'components/supporter/RentCategoryFeed.tsx',
  'pages/MyWatchlist.tsx',
];

/** Signed-in partner areas (all behind the supporter RoleGuard) where the PUBLIC rate must not price
 *  the viewer's own figures. */
const SIGNED_IN_DIRS = ['components/supporter', 'components/funder-new', 'components/funder-preview', 'components/partner'];
const SIGNED_IN_PAGES = ['components/dashboards/SupporterDashboard.tsx', 'pages/FunderDashboardNew.tsx', 'pages/FunderLandingPreview.tsx', 'pages/MyWatchlist.tsx'];

/** Public, share or agent components that may use the PUBLIC rate (newContractRate). Extend with care. */
const PUBLIC_RATE_ALLOWED = new Set<string>([
  'components/partner/PlanShareButton.tsx',
  'components/partner/SelfPortfolioPlanDetailSheet.tsx',
]);

/** Deprecated src/lib exports (hard-coded 15%) that must have no importer at release. */
const DEPRECATED: Record<string, string[]> = {
  funderEarnings: ['FUNDER_MONTHLY_RATE', 'calcFunderEarnings', 'sumFunderEarnings'],
  planShareLink: ['SHARE_ROI_RATE', 'planShareDescription'],
  houseSupportShare: ['HOUSE_SHARE_ROI_RATE', 'houseMonthlyReturn', 'houseShareMessage'],
  supportPlanExample: ['EXAMPLE_MONTHLY_RATE', 'EXAMPLE_MONTHLY_RETURN', 'EXAMPLE_TWELVE_MONTH_TOTAL', 'SUPPORT_EXAMPLE_STEPS', 'exampleMonthlyReturn', 'buildSupportPlanExampleLine'],
  rentCalculations: ['calculateSupporterReward'],
};

/**
 * Agent and public screens that quote a partner Returns rate (Phase 6 audit, Gemini item 3): they show
 * the PUBLIC new-partner rate (usePartnerReturnPolicy().newContractRate, getPublicPartnerRate, or the
 * rate an RPC quoted) or a sentence with no figure; never a fixed 15% and never a per-person rate.
 * Claude wired the data lines (figures, share text); what the gate still lists is copy for Gemini.
 */
export const AGENT_PUBLIC_FILES = [
  'components/agent/PromissoryNoteDialog.tsx',
  'components/agent/EmptyHouseOpportunitiesSheet.tsx',
  'components/agent/EmptyHouseDetailSheet.tsx',
  'components/agent/SupportModeChooserDialog.tsx',
  'components/agent/ProxySupportOpportunities.tsx',
  'components/dashboards/AgentDashboard.tsx',
  'components/dashboards/AgentDashboardBk.tsx',
  'components/angel-pool/CapitalOpportunityEntry.tsx',
  'components/angel-pool/InvestmentSelectionSheet.tsx',
  'pages/AngelPool.tsx',
  'pages/Auth.tsx',
  'pages/BecomeSupporter.tsx',
  'pages/Benefits.tsx',
  'pages/Calculator.tsx',
  'pages/TryCalculator.tsx',
  'pages/Onboarding.tsx',
  'pages/SelectRole.tsx',
  'pages/SupportPlanPublic.tsx',
  'pages/RentMoney.tsx',
];
/**
 * Tokens that only look like a rate: SVG path data, opacity and line-height values. They are removed
 * from the line before the check rather than the whole line being dropped, so copy that shares a line
 * with a `leading-[1.15]` class or an `opacity="0.15"` attribute is still checked.
 */
const STYLE_TOKENS = /\bd=(?:"[^"]*"|'[^']*')|\b(?:fill-?|stroke-?|stop-?)?[oO]pacity=(?:"[^"]*"|'[^']*'|\{[^}]*\})|\bopacity:\s*0?\.\d+|leading-\[[^\]]*\]/g;
const stripStyleTokens = (line: string) => line.replace(STYLE_TOKENS, '');
const agentPublicRateLinesIn = (text: string, label: string) => fixedRateLinesIn(text, label, stripStyleTokens);
const agentPublicRateLines = (f: string) => agentPublicRateLinesIn(read(f), f);

/** Nexa components (§6.2 #6): no fixed rate; the one that prices figures passes the live public rate. */
const NEXA_FILES = ['components/ai-chat/ShareWelileAIBanner.tsx', 'components/ai-chat/NexaInquirySignupBar.tsx', 'components/ai-chat/roleLanding.ts', 'components/ai-chat/NexaSalesHub.tsx'];
const NEXA_RATE_LITERAL = /\b(?:10|15|20)\s*%/;

const gate = process.env.PARTNER_RATE_RELEASE_GATE === '1';

describe.runIf(gate)('Partner Returns release gate (browser)', () => {
  it('signed-in partner screens quote their own rate (§6.2 #10)', () => {
    const missing = OWN_RATE_SCREENS.filter((f) => !/\buseOwnNewPortfolioRate\b/.test(read(f)));
    expect(missing).toEqual([]);
  });

  it('signed-in partner screens state no fixed rate (§6.1 rule: null -> no number)', () => {
    expect(OWN_RATE_SCREENS.flatMap(fixedRateLines)).toEqual([]);
  });

  it('signed-in partner components do not use the public rate for their own projections', () => {
    const offenders = SIGNED_IN_DIRS
      .flatMap((d) => files(join(SRC, d)))
      .map(rel)
      .concat(SIGNED_IN_PAGES)
      .filter((f) => !PUBLIC_RATE_ALLOWED.has(f) && /\bnewContractRate\b/.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('no importer of the deprecated hard-coded-15% helpers', () => {
    const offenders: string[] = [];
    for (const full of files(SRC)) {
      const f = rel(full);
      const text = read(f);
      for (const [mod, names] of Object.entries(DEPRECATED)) {
        if (f === `lib/${mod}.ts` || !text.includes(mod)) continue;
        const re = new RegExp(`(?:import|export)\\s+(?:type\\s+)?(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*['"][^'"]*\\b${mod}['"]`, 'g');
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          for (const n of m[1].split(',').map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0])) {
            if (names.includes(n)) offenders.push(`${f}: ${n}`);
          }
        }
        if (new RegExp(`import\\s+\\*\\s+as\\s+\\w+\\s+from\\s*['"][^'"]*\\b${mod}['"]`).test(text)) offenders.push(`${f}: * as ${mod}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('agent screens show no per-partner rate, fixed 15% or "ROI" (§6.2 #3)', () => {
    const f = 'components/agent/AgentInvestForPartnerDialog.tsx';
    expect(read(f)).not.toMatch(/\(15%\)|\bROI\b/);
    expect(fixedRateLines(f)).toEqual([]);
  });

  it('agent and public screens state no fixed 15% (Phase 6 audit; Gemini item 3)', () => {
    expect(AGENT_PUBLIC_FILES.flatMap(agentPublicRateLines)).toEqual([]);
  });

  it('Nexa components state no fixed rate, and the sales hub passes the live public rate (§6.2 #6)', () => {
    const literals = NEXA_FILES.flatMap((f) =>
      read(f).split(/\r?\n/).map((line, i) => (NEXA_RATE_LITERAL.test(line) ? `${f}:${i + 1}: ${line.trim().slice(0, 100)}` : null)).filter(Boolean),
    );
    expect(literals).toEqual([]);
    expect(read('components/ai-chat/NexaSalesHub.tsx')).toMatch(/usePartnerReturnPolicy|getPublicPartnerRate|newContractRate/);
  });

  it('share sheets use the description the database composed (§6.2 #9)', () => {
    for (const f of ['components/partner/PlanShareButton.tsx', 'components/funder-preview/FunderPreviewHomeSheet.tsx', 'components/partner/SelfPortfolioPlanDetailSheet.tsx']) {
      expect(read(f), f).toMatch(/planShareFallbackDescription|\.description\b/);
    }
  });

  it('the promissory-note activation page shows the stored rate, never a fixed 15% (§6.2 #1, Phase 4 merge)', () => {
    expect(fixedRateLines('pages/ActivatePartner.tsx')).toEqual([]);
  });

  it('the public partner registration page (submit-partner-form) quotes the live public rate, never a fixed 15%', () => {
    const f = 'pages/RegisterPartnerPublic.tsx';
    expect(fixedRateLines(f)).toEqual([]);
    expect(read(f)).toMatch(/\busePartnerReturnPolicy\b|\bgetPublicPartnerRate\b/);
  });
});

describe.skipIf(gate)('Partner Returns release gate (browser)', () => {
  it('is opt-in: set PARTNER_RATE_RELEASE_GATE=1 to run it', () => {
    expect(gate).toBe(false);
  });
});

/**
 * The AGENT_PUBLIC_FILES check itself (always on): it must catch a fixed 15% wherever one is added to
 * those files, and must not be fooled by SVG / opacity / line-height values. Without these the gate
 * could pass by never matching anything.
 */
describe('Partner Returns release gate: the agent and public check catches a fixed 15%', () => {
  it('every listed file exists and is not empty (a renamed file must not pass by reading nothing)', () => {
    const missing = AGENT_PUBLIC_FILES.filter((f) => {
      try {
        return read(f).trim().length === 0;
      } catch {
        return true;
      }
    });
    expect(missing).toEqual([]);
    expect(new Set(AGENT_PUBLIC_FILES).size).toBe(AGENT_PUBLIC_FILES.length);
  });

  it.each([
    ['copy', '<p>Earn 15% monthly Returns</p>'],
    ['copy with a space', '<span>Supporters earn 15 % a month</span>'],
    ['template text', 'const text = `Partner with Welile and earn 15% monthly Returns! ${link}`;'],
    ['arithmetic', 'const monthly = amount * 0.15;'],
    ['arithmetic, no leading zero', 'const monthly = amount * .15;'],
    ['a fraction', 'const monthly = (amount * 15 / 100);'],
    ['a ?? fallback', 'const rate = newContractRate ?? 15;'],
    ['a || fallback', 'const rate = policy.rate || 15;'],
    ['a RATE constant', 'const ROI_RATE = 0.15;'],
    ['a RATE constant in percent', 'const HOUSE_MONTHLY_ROI_RATE = 15;'],
    ['copy sharing a line with a line-height class', '<p className="leading-[1.15]">Earn 15% monthly</p>'],
    ['copy sharing a line with an opacity value', '<g opacity="0.15"><text>15% a month</text></g>'],
  ])('catches %s', (_name, line) => {
    expect(agentPublicRateLinesIn(line, 'x.tsx')).toEqual([`x.tsx:1: ${line}`]);
  });

  it.each([
    ['SVG path data', '<path d="M0 0.15 L10 1.15 Z" />'],
    ['an opacity attribute', '<stop offset="0" stopOpacity="0.15" />'],
    ['a JSX opacity value', '<circle opacity={0.15} r={2} />'],
    ['an inline-style opacity', "style={{ opacity: 0.15 }}"],
    ['a line-height class', '<h1 className="text-4xl leading-[1.15] font-black">Turn rent into an asset</h1>'],
    ['a line comment', '// 15% while the switch has never been on'],
    ['a JSX comment', '{/* 15% here was the old fixed rate */}'],
    ['a block-comment line', ' * the PUBLIC new-partner rate (15 while the switch has never been on, so 15% today)'],
    ['the D8 plan sentence', '<p>The plan sets aside 15% for Partner Returns.</p>'],
    ['a rate read from the database', 'const monthly = monthlyReturnFor(amount, newContractRate);'],
    ['the rate label', '`earn ${newRatePct} monthly Returns!`'],
    ['115% and 0.155', 'const x = 115; const y = 0.155; const label = "115%";'],
  ])('does not flag %s', (_name, line) => {
    expect(agentPublicRateLinesIn(line, 'x.tsx')).toEqual([]);
  });

  it('a fixed 15% added to any listed file is caught, at that file and line', () => {
    for (const f of AGENT_PUBLIC_FILES) {
      const text = read(f);
      const before = agentPublicRateLinesIn(text, f);
      const lines = text.split(/\r?\n/);
      const injected = `${text}${text.endsWith('\n') ? '' : '\n'}const fallbackShare = \`Earn 15% monthly Returns\`;`;
      const after = agentPublicRateLinesIn(injected, f);
      const n = text.endsWith('\n') ? lines.length : lines.length + 1;
      expect(after, f).toEqual([...before, `${f}:${n}: const fallbackShare = \`Earn 15% monthly Returns\`;`]);
    }
  });

  it('a fixed rate in arithmetic added to a rewired screen is caught', () => {
    const f = 'components/angel-pool/CapitalOpportunityEntry.tsx';
    const text = read(f);
    const swapped = text.replace('(amount * rate) / 100', 'amount * 0.15');
    expect(swapped).not.toBe(text);
    expect(agentPublicRateLinesIn(swapped, f).length).toBe(agentPublicRateLinesIn(text, f).length + 1);
  });
});
