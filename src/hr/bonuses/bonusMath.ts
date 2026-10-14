/**
 * Display-only preview of the server's allocation rounding
 * (hr_pay_bonus_recompute). The server's figure is the one paid.
 * amount = floor(pool × % ÷ 100); then the shortfall to
 * round(pool × total% ÷ 100) goes +1 to the largest remainders (tie: staff_id).
 */
export interface BonusAllocInput {
  staff_id: string;
  percentage: number;
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function allocateBonus(pool: number, rows: BonusAllocInput[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (!(pool > 0) || rows.length === 0) {
    rows.forEach((r) => { out[r.staff_id] = 0; });
    return out;
  }
  const pcts = rows.map((r) => ({ id: r.staff_id, p: round3(r.percentage || 0) }));
  const totalPct = pcts.reduce((s, r) => s + r.p, 0);
  const target = Math.round((pool * totalPct) / 100);
  const raw = pcts.map((r) => {
    const exact = (pool * r.p) / 100;
    const base = Math.floor(exact);
    return { id: r.id, base, rem: exact - base };
  });
  raw.forEach((r) => { out[r.id] = r.base; });
  const short = target - raw.reduce((s, r) => s + r.base, 0);
  if (short > 0) {
    [...raw]
      .sort((a, b) => (b.rem - a.rem) || a.id.localeCompare(b.id))
      .slice(0, short)
      .forEach((r) => { out[r.id] += 1; });
  }
  return out;
}

/** Equal split to 3 decimals; the last person absorbs the rounding so it totals 100. */
export function splitEqually(n: number): number[] {
  if (n <= 0) return [];
  const each = Math.floor((100 / n) * 1000) / 1000;
  const arr = Array(n).fill(each);
  arr[n - 1] = round3(100 - each * (n - 1));
  return arr;
}

export const BONUS_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Awaiting CEO',
  returned: 'Returned',
  approved: 'Approved — awaiting CFO',
  paid: 'Paid',
  cancelled: 'Cancelled',
};
