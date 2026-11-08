/**
 * Partner Returns Phase 5 (supporter screens, Claude data lines): switch-off parity of the rated helpers
 * the screens now use, and the wiring rules each screen's data code must keep (gemini_tasks.md items 9,
 * 10, 11a, 14). While the switch has never been on, partner_quote_rate('me') answers the legacy 15, so
 * every figure must equal what the old hard-coded 15% code printed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { calculateSupporterRewardAt, sumSupporterRewardsAt } from '@/lib/rentCalculations';
import { monthlyReturnFor } from '@/lib/partnerReturnPolicy';

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
/** Source without comments, so a comment that mentions 15% never counts. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((l) => (l.trim().startsWith('//') ? '' : l))
    .join('\n');

const LEGACY = 15;
const AMOUNTS = [0, 1, 7, 99, 150, 333, 12_345, 50_000, 99_999, 150_001, 333_333, 1_234_567, 9_999_999];

describe('switch-off parity of the rated helpers (legacy 15)', () => {
  it('rent-facilitation reward: calculateSupporterRewardAt(rent, 15) == the old Math.round(rent * 0.15)', () => {
    for (const a of AMOUNTS) expect(calculateSupporterRewardAt(a, LEGACY)).toBe(Math.round(a * 0.15));
  });

  it('a tier / watchlist total: sumSupporterRewardsAt == the old per-request rounded loop', () => {
    let old = 0;
    for (const a of AMOUNTS) old += Math.round(a * 0.15);
    expect(sumSupporterRewardsAt(AMOUNTS, LEGACY)).toBe(old);
  });

  it('FundRentDialog 12-month total: monthlyReturnFor(amount * 12, 15) == the old Math.round(amount * 0.15 * 12)', () => {
    for (const a of AMOUNTS) expect(monthlyReturnFor(a * 12, LEGACY)).toBe(Math.round(a * 0.15 * 12));
  });

  it('calculator / package sheet fractions: 15 / 100 is exactly the old 0.15', () => {
    expect(LEGACY / 100).toBe(0.15);
  });

  it('no rate: every figure is null, never a default', () => {
    expect(calculateSupporterRewardAt(100_000, null)).toBeNull();
    expect(sumSupporterRewardsAt([100_000, 200_000], null)).toBeNull();
    expect(monthlyReturnFor(100_000, null)).toBeNull();
  });
});

/** Signed-in partner screens whose figures are priced in data code (items 10 and 14). */
const OWN_RATE_FILES = [
  'components/supporter/PayLandlordDialog.tsx',
  'components/supporter/RentCategoryFeed.tsx',
  'pages/MyWatchlist.tsx',
  'components/partner/SelfPortfolioDeployDialog.tsx',
  'components/funder-new/FunderNewCalculatorDialog.tsx',
  'components/supporter/FundAccountDialog.tsx',
  'components/dashboards/SupporterDashboard.tsx',
  'components/supporter/FunderBookedHousesPanel.tsx',
  'components/supporter/InvestmentCalculator.tsx',
  'components/supporter/InvestmentPackageSheet.tsx',
  'components/supporter/FundRentDialog.tsx',
  'components/partner/SelfPortfolioFundingCard.tsx',
  'components/partner/SelfPortfolioPlanDetailSheet.tsx',
];

describe('own-rate wiring (items 10 and 14)', () => {
  it.each(OWN_RATE_FILES)('%s reads the own rate from useOwnNewPortfolioRate, never the public rate', (f) => {
    const text = code(f);
    expect(text).toMatch(/import \{ useOwnNewPortfolioRate \} from '@\/hooks\/usePartnerQuoteRate'/);
    expect(text).not.toMatch(/\bnewContractRate\b|\busePartnerReturnPolicy\b/);
  });

  it.each(OWN_RATE_FILES)('%s has no fixed-rate arithmetic or fallback in code', (f) => {
    const text = code(f);
    expect(text).not.toMatch(/\*\s*0?\.15\b|\b15\s*\/\s*100\b|(?:\?\?|\|\|)\s*(?:10|15)\b|\b[A-Z_]*RATE\s*=\s*(?:0?\.1|0?\.15|10|15)\b/);
    expect(text).not.toMatch(/\bcalculateSupporterReward\b(?!At)/);
  });

  it('RentCategoryFeed: a new cache key, rents in the cache, and the reward priced at render', () => {
    const text = code('components/supporter/RentCategoryFeed.tsx');
    expect(text).toMatch(/const CACHE_KEY = 'welile_rent_categories_v2'/);
    expect(text).toMatch(/removeItem\(LEGACY_CACHE_KEY\)/);
    expect(text).toMatch(/sumSupporterRewardsAt\(c\.rents, ownRate\)/);
    // The dialogs read the tier's priced reward, not a fixed share of the total rent.
    expect(text).not.toMatch(/cat\.totalRent \*/);
  });
});

describe('share sheets use the text the database composed (item 9)', () => {
  it.each([
    'components/partner/PlanShareButton.tsx',
    'components/funder-preview/FunderPreviewHomeSheet.tsx',
    'components/partner/SelfPortfolioPlanDetailSheet.tsx',
    'pages/SupportHouse.tsx',
  ])('%s imports no deprecated 15%% share helper', (f) => {
    expect(code(f)).not.toMatch(/\b(?:planShareDescription|SHARE_ROI_RATE|HOUSE_SHARE_ROI_RATE|houseShareMessage|houseMonthlyReturn)\b(?!For|At)/);
  });

  it('FunderPreviewHomeSheet: link.description, else the figure-free fallback', () => {
    const text = code('components/funder-preview/FunderPreviewHomeSheet.tsx');
    expect(text).toMatch(/houseShareMessageFor\([\s\S]*?link\.description/);
    expect(text).toMatch(/link\.description \?\? planShareFallbackDescription\(plan\)/);
  });

  it('SupportHouse (public) states the public new-partner rate', () => {
    expect(code('pages/SupportHouse.tsx')).toMatch(/usePartnerReturnPolicy\(\)/);
  });
});

describe('trust lines keep null (item 11a)', () => {
  it.each([
    ['components/agent/AgentVouchHighlightCard.tsx', /borrowing_limit_ugx \?\? 0|score \?\? 0/],
    ['components/agent/AgentTenantHealthCard.tsx', /borrowing_limit_ugx \?\? 0/],
    ['components/vouch/agent/BorrowerProfileSheet.tsx', /Number\(trust\?\.score\) \|\| 0/],
    ['components/vouch/agent/BorrowerTrustScorePanel.tsx', /Number\(profile\.trust\?\.(?:score|borrowing_limit_ugx)\) \|\| 0/],
    ['components/ai-id/VouchAuditLog.tsx', /portfolio_value \?\? 0|monthly_avg \?\? 0/],
  ] as const)('%s', (f, bad) => {
    expect(code(f)).not.toMatch(bad);
  });
});
