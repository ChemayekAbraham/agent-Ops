import { kampalaTodayYmd } from '@/lib/kampalaDays';

export type RdUpdate = { id: string; date: string; text: string };
export type RdWeekPeriod = 'last' | 'today' | 'next';
export const RD_UPDATES_KEY = 'rd-project-updates-v1';

export function rdDateOffset(date: string, offset: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10);
}

/** Non-overlapping calendar periods; future entries must also be explicitly recorded. */
export function rdWeeklyUpdates(updates: RdUpdate[], period: RdWeekPeriod, today = kampalaTodayYmd()): RdUpdate[] {
  const start = period === 'last' ? rdDateOffset(today, -7) : period === 'next' ? rdDateOffset(today, 1) : today;
  const end = period === 'last' ? rdDateOffset(today, -1) : period === 'next' ? rdDateOffset(today, 7) : today;
  return updates.filter((u) => /^\d{4}-\d{2}-\d{2}$/.test(u.date) && u.date >= start && u.date <= end)
    .slice().sort((a, b) => a.date.localeCompare(b.date));
}

export function loadRdUpdates(): Record<string, RdUpdate[]> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(RD_UPDATES_KEY) || '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).filter(([, rows]) => Array.isArray(rows))
      .map(([name, rows]) => [name, (rows as unknown[]).filter((row): row is RdUpdate => {
        if (!row || typeof row !== 'object') return false;
        const u = row as Partial<RdUpdate>;
        return typeof u.id === 'string' && typeof u.date === 'string' && typeof u.text === 'string';
      })]));
  } catch { return {}; }
}