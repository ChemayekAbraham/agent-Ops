/**
 * Partner Returns 4b READINESS CHECK: screen code that turns a masked figure into a number.
 *
 * Migration 4b (supabase/pending/…_phase4_masks.sql, owner decision D9) sets the trust-profile Returns
 * figures and the wallet-hub Returns figures to null for a viewer who may not see the person's Returns.
 * tsconfig.app.json has strictNullChecks off, so `number | null` collapses to `number` and tsc cannot
 * catch `x ?? 0`, `Number(x) || 0`, `Math.round(x)`, `x * 2`, `x >= 50` or `formatUGX(x)` on such a
 * field: each of them shows an unknown figure as 0 (or a 0 ring / bar / tier). This scan lists them.
 *
 * Expected RED until the screen work in gemini_tasks.md items 11a/11b has landed; run it before 4b ships:
 *
 *   PARTNER_RATE_RELEASE_GATE=1 npx vitest run src/test/partnerReturnsMaskedFigureUse.test.ts
 *
 * The detector itself is tested in every run. It reads source text, so it catches direct reads and simple
 * aliases (`const vb = trust.vouch_breakdown`); a figure passed through a prop or renamed further is out of
 * its reach and is covered by the spot list in gemini_tasks.md. A line that guards the same figure
 * (`x != null`, `typeof x === 'number'`) is left alone. `welile_trust_score_cache` columns are not masked
 * (open owner decision) and are not scanned.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

/** Container -> the masked leaves under it (the 17 trust paths of 4b, plus the wallet hub). Containers are
 *  matched by name or by a simple alias, so `trust.score`, `profile?.trust?.score` and `t.score` (after
 *  `const t = profile.trust`) all count. */
export const MASKED: Record<string, string[]> = {
  trust: ['score', 'borrowing_limit_ugx'],
  breakdown: ['supporter'],
  vouch_breakdown: ['total_ugx', 'portfolio_component_ugx', 'boosters_ugx'],
  booster_breakdown: ['payment_history'],
  supporter_activity: ['portfolio_value', 'total_roi_earned', 'roi_paid_30d', 'roi_paid_180d', 'roi_monthly_avg'],
  cash_flow_capacity: ['roi_monthly', 'monthly_avg', 'weekly_avg', 'daily_avg'],
  network: ['portfolio_value'],
};
/** Wallet hub figures (fetchPartnerWalletHub keeps them null when 4b masks them). Matched only in a file
 *  that reads the hub: `roiAmount` / `roi_amount` elsewhere are other tables (supporter_roi_payments, …). */
export const MASKED_HUB = ['roiAmount', 'totalAvailable'];
const HUB_READER = /\b(?:usePartnerWalletHub|fetchPartnerWalletHub|get_partner_wallet_hub|PartnerWalletHub\w*)\b/;

/** Files whose matches are not 4b figures. Each needs a reason. */
const NOT_4B: Record<string, string> = {
  // person.trust is built from welile_trust_score_cache.borrowing_limit_ugx, which 4b does not mask
  // (open owner decision; gemini_tasks.md 11a lists the cache readers conditionally).
  'components/vouch/agent/LendingUserDirectory.tsx': 'welile_trust_score_cache column, not the 4b profile',
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ACCESS = '\\s*\\??\\.\\s*';

/** Aliases of each container in one file: `const cf = profile.cash_flow_capacity;`, `const b = trust?.breakdown ?? {}`. */
function aliases(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of Object.keys(MASKED)) {
    out[c] = [c];
    const re = new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=\\n]+)?=\\s*[\\w$?.\\s]*\\??\\.${c}\\b\\s*(?:;|$|\\?\\?|\\|\\||as\\b)`, 'gm');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) if (!out[c].includes(m[1])) out[c].push(m[1]);
  }
  return out;
}

/** Every masked access a file can make, as regex sources (no flags). */
function accessPatterns(text: string): string[] {
  const out: string[] = [];
  for (const [c, names] of Object.entries(aliases(text))) {
    const leaves = MASKED[c].join('|');
    for (const n of names) out.push(`\\b${esc(n)}${ACCESS}(?:${leaves})\\b`);
  }
  if (HUB_READER.test(text)) out.push(`${ACCESS}(?:${MASKED_HUB.join('|')})\\b`);
  return out;
}

/**
 * The ways a masked figure becomes a number. `M` is the access. Comparisons count: `null >= 50` is
 * false and `null >= 0` is true, so a null score lands in the lowest band or passes a floor check.
 */
function misuse(m: string): RegExp {
  const call = `(?:${m})(?:\\s*\\))*`;
  return new RegExp([
    `${call}\\s*(?:\\?\\?|\\|\\|)\\s*0\\b`, // M ?? 0, Number(M) || 0
    `(?:${m})\\s*(?:[-+*/%]|[<>]=?)(?![=>])`, // M * 2, M - x, M >= 50 (not M => / M ==)
    `(?<![=])(?:[-+*/%]|[<>]=?)\\s*\\(?\\s*(?:[\\w$]+\\s*\\??\\.\\s*)*(?:${m})`, // x - M, 50 <= M, x + M
    `\\b(?:Math\\.(?:round|floor|ceil|min|max|abs)|formatUGX|formatDynamic|formatNumber|toLocaleString)\\s*\\([^)]*?(?:${m})`, // Math.round(M), formatUGX(M)
    `(?:${m})\\s*\\.\\s*(?:toFixed|toLocaleString)\\s*\\(`, // M.toFixed(0) throws on null
  ].join('|'));
}

/** A line that guards the same figure is left alone (`x != null ? x * 2 : '—'`). */
function guarded(line: string, m: string): boolean {
  return new RegExp(`(?:${m})\\s*!==?\\s*(?:null|undefined)|typeof\\s+[\\w$?.\\s]*(?:${m})\\s*===?\\s*['"]number['"]|Number\\.isFinite\\(\\s*(?:${m})`).test(line);
}

/** `file:line: text` for every masked-figure misuse in one source text. Comments are skipped. */
export function maskedFigureMisuse(file: string, text: string): string[] {
  const pats = accessPatterns(text);
  const out: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const t = raw.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*')) return;
    const line = raw.replace(/\/\/.*$/, '');
    // `formatUGXOrDash(M)` is the safe formatter: drop it before matching formatUGX.
    const scan = line.replace(/\bformatUGXOrDash\s*\(/g, 'safeFmt(');
    for (const m of pats) {
      if (!new RegExp(m).test(scan) || guarded(scan, m)) continue;
      if (misuse(m).test(scan)) {
        out.push(`${file}:${i + 1}: ${t.slice(0, 140)}`);
        break;
      }
    }
  });
  return out;
}

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

function scanScreens(): string[] {
  return ['components', 'pages']
    .flatMap((d) => files(join(SRC, d)))
    .map((full) => relative(SRC, full).split(sep).join('/'))
    .filter((f) => !(f in NOT_4B))
    .flatMap((f) => maskedFigureMisuse(f, readFileSync(join(SRC, f), 'utf8')));
}

describe('masked-figure misuse detector', () => {
  it('covers every trust path migration 4b masks (container.leaf of each FOREACH path)', () => {
    const sql = readFileSync(join(SRC, '..', 'supabase', 'pending', '20261107101000_partner_return_policy_phase4_masks.sql'), 'utf8');
    const arr = sql.match(/FOREACH v_path IN ARRAY ARRAY\[([\s\S]*?)\]\s*LOOP/);
    expect(arr).not.toBeNull();
    const fromSql = [...arr![1].matchAll(/'([^']+)'/g)].map((m) => m[1].split('.').slice(-2).join('.')).sort();
    const scanned = Object.entries(MASKED).flatMap(([c, leaves]) => leaves.map((l) => `${c}.${l}`)).sort();
    expect(scanned).toEqual(fromSql);
  });

  const hit = (src: string) => maskedFigureMisuse('x.tsx', src).length > 0;

  it('flags a null turned into 0, arithmetic, comparisons and formatUGX on a masked figure', () => {
    expect(hit('const score = Math.round(profile.trust.score ?? 0);')).toBe(true);
    expect(hit('const score = Math.round(trust.score);')).toBe(true);
    expect(hit('const s = Math.max(0, Math.min(100, Number(profile.trust?.score) || 0));')).toBe(true);
    expect(hit('const limit = profile.trust.borrowing_limit_ugx ?? 0;')).toBe(true);
    expect(hit('if (principalNum > profile.trust.borrowing_limit_ugx) {')).toBe(true);
    expect(hit('const v = trust.breakdown.supporter ?? 0;')).toBe(true);
    expect(hit('<p>{formatUGX(profile.trust.vouch_breakdown.total_ugx)}</p>')).toBe(true);
    expect(hit('const { data } = usePartnerWalletHub(id);\nbalance={data?.totalAvailable ?? 0}')).toBe(true);
    expect(hit('const hub = usePartnerWalletHub(id).data;\nconst total = hub.roiAmount + hub.withdrawable;')).toBe(true);
    expect(hit('const x = 0.25 * profile.cash_flow_capacity.roi_monthly;')).toBe(true);
    expect(hit('const label = data.network.portfolio_value.toLocaleString();')).toBe(true);
  });

  it('follows a simple alias of the container', () => {
    expect(hit('const cf = profile.cash_flow_capacity;\nconst ok = cf.monthly_avg > 0;')).toBe(true);
    expect(hit('const vb = trust?.vouch_breakdown ?? null;\nconst p = vb.portfolio_component_ugx * 1;')).toBe(true);
    expect(hit('const b = profile.trust.breakdown;\nconst s = b.supporter || 0;')).toBe(true);
  });

  it('leaves null-safe code, unmasked fields, plain display and comments alone', () => {
    expect(hit('const s = trust.score;')).toBe(false);
    expect(hit('<p>{formatUGXOrDash(profile.trust.borrowing_limit_ugx)}</p>')).toBe(false);
    expect(hit('const v = trust.score != null ? Math.round(trust.score) : null;')).toBe(false);
    expect(hit("const v = typeof trust.score === 'number' ? trust.score * 1 : null;")).toBe(false);
    expect(hit('const w = trust.breakdown.wallet ?? 0;')).toBe(false);
    expect(hit('const n = profile.payment_history.total_rent_plans > 0;')).toBe(false);
    expect(hit('const s = snapshot?.score ?? 0;')).toBe(false);
    expect(hit('const paid = rows.reduce((s, p) => s + (p.roi_amount || 0), 0); const x = preview.roiAmount * 1;')).toBe(false);
    expect(hit('// const s = trust.score ?? 0;')).toBe(false);
    expect(hit('const f = (x: number) => x; f(trust.score);')).toBe(false);
    expect(hit('rows.map((p) => p.trust.score)')).toBe(false);
  });
});

const gate = process.env.PARTNER_RATE_RELEASE_GATE === '1';

describe.runIf(gate)('Partner Returns 4b readiness (browser): masked figures are never turned into numbers', () => {
  it('no arithmetic, comparison, formatUGX or `?? 0` / `|| 0` on a masked trust or wallet-hub figure in src/components and src/pages', () => {
    expect(scanScreens()).toEqual([]);
  });
});

describe.skipIf(gate)('Partner Returns 4b readiness (browser)', () => {
  it('is opt-in: set PARTNER_RATE_RELEASE_GATE=1 to run it', () => {
    expect(gate).toBe(false);
  });
});
