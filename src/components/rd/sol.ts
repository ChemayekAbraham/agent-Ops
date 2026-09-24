import type { Mission } from './useRd';

/** Today's date (YYYY-MM-DD) in Africa/Kampala. */
function kampalaToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function dayNum(ymd: string): number {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400_000);
}

export type SolRow = { m: Mission; sol: number; actual: number; gap: number };

export function isSolEligible(m: Mission) {
  return m.horizon === 'now' && m.stage !== 'kill' && m.started_on != null && m.sol_days != null;
}

export function solGap(m: Mission): SolRow | null {
  if (!isSolEligible(m)) return null;
  const sol = Number(m.sol_days);
  const actual = dayNum(kampalaToday()) - dayNum(String(m.started_on));
  return { m, sol, actual, gap: sol > 0 ? actual / sol : Infinity };
}

export function solRows(missions: Mission[]): SolRow[] {
  return missions.map(solGap).filter((r): r is SolRow => !!r).sort((a, b) => b.gap - a.gap);
}

export function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export const fmtGap = (g: number | null) => (g == null ? '—' : Number.isFinite(g) ? `${g.toFixed(1)}×` : '∞×');
export const gapTone = (g: number | null): 'neutral' | 'watch' | 'break' =>
  g == null ? 'neutral' : g >= 2 ? 'break' : g >= 1.5 ? 'watch' : 'neutral';
