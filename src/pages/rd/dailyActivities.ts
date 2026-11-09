export type DailyActivity = { id: string; date: string; project: string; text: string; createdAt: string };

export const dailyActivitiesKey = (userId: string) => `rd-daily-activities-v1:${userId}`;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function readActivities(value: string | null): DailyActivity[] {
  try {
    const parsed: unknown = JSON.parse(value ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((a): a is DailyActivity => a !== null && typeof a === 'object' &&
      typeof a.id === 'string' && DAY.test(a.date) && typeof a.project === 'string' &&
      typeof a.text === 'string' && typeof a.createdAt === 'string');
  } catch { return []; }
}

const toDate = (d: string) => new Date(`${d}T00:00:00Z`);
const toDay = (d: Date) => d.toISOString().slice(0, 10);

/** Monday of the week containing the given day (YYYY-MM-DD). */
export function weekStart(day: string): string {
  const d = toDate(day);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return toDay(d);
}

export function weekDays(start: string): string[] {
  return Array.from({ length: 7 }, (_, i) => { const d = toDate(start); d.setUTCDate(d.getUTCDate() + i); return toDay(d); });
}

export function shiftWeek(start: string, weeks: number): string {
  const d = toDate(start); d.setUTCDate(d.getUTCDate() + weeks * 7); return toDay(d);
}

export function kampalaToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const label = (day: string) => toDate(day).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Plain-text weekly report draft built only from recorded activities (Monday–Sunday). */
export function draftWeeklyReport(activities: DailyActivity[], start: string, author = ''): string {
  const days = weekDays(start);
  const inWeek = activities.filter((a) => days.includes(a.date));
  const lines = [`R&D Weekly Report — ${label(days[0])} to ${label(days[6])}`];
  if (author) lines.push(`Prepared by: ${author}`);
  lines.push('', `Summary: ${inWeek.length} activit${inWeek.length === 1 ? 'y' : 'ies'} recorded on ${new Set(inWeek.map((a) => a.date)).size} day(s).`);
  const projects = [...new Set(inWeek.map((a) => a.project.trim()).filter(Boolean))];
  if (projects.length) lines.push(`Projects worked on: ${projects.join(', ')}`);
  lines.push('', 'Daily activities');
  for (const day of days) {
    const items = inWeek.filter((a) => a.date === day).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!items.length) continue;
    lines.push('', label(day));
    for (const a of items) lines.push(`- ${a.project.trim() ? `[${a.project.trim()}] ` : ''}${a.text.trim()}`);
  }
  if (!inWeek.length) lines.push('', 'No activities recorded this week.');
  lines.push('', 'Challenges:', '', 'Plans for next week:', '');
  return lines.join('\n');
}
