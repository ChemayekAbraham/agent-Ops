/**
 * Client-side pivot for the Calling Center "All calls made and taken this week" report.
 *
 * The server (`cc_weekly_all_calls_report`) returns one row per caller, Kampala day, kind of person called, source and answered/not answered.
 * This file only arranges those rows into the staff x day matrices the screen and the PDF show; it counts nothing the server did not send.
 * Subtotals are the sum of the four kinds, and the daily totals are the sum of the staff rows, so every table reconciles by construction.
 */

export type CallKind = 'tenant' | 'landlord' | 'agent' | 'other';

export const CALL_KINDS: { kind: CallKind; label: string }[] = [
  { kind: 'tenant', label: 'Tenants' },
  { kind: 'landlord', label: 'Landlords' },
  { kind: 'agent', label: 'Agents' },
  { kind: 'other', label: 'Others' },
];

export const CALL_SOURCE_LABELS: Record<string, string> = {
  calling_center: 'Calling Center',
  received: 'Calls that came in',
  crm_voice: 'App voice calls',
  awareness: 'Awareness calls',
  legacy_tenant: 'Earlier tenant call log',
  legacy_landlord: 'Earlier landlord call log',
};

/** One row of `cc_weekly_all_calls_report`. */
export interface AllCallsRow {
  caller_id: string | null;
  caller_name: string | null;
  kampala_day: string;
  subject_kind: string;
  source: string;
  answered: boolean;
  calls: number;
}

export interface AllCallsStaff {
  key: string;
  name: string;
  perDay: number[];
  total: number;
  kinds: Record<CallKind, { perDay: number[]; total: number }>;
}

export interface AllCallsPivot {
  staff: AllCallsStaff[];
  dailyTotals: number[];
  grandTotal: number;
  /** Per kind, summed over all staff. */
  kindTotals: Record<CallKind, { perDay: number[]; total: number }>;
  bySource: { source: string; label: string; calls: number }[];
  answered: number;
  notAnswered: number;
}

const kindOf = (k: string): CallKind => (k === 'tenant' || k === 'landlord' || k === 'agent' ? k : 'other');

/** `dayKeys` are the seven yyyy-MM-dd days of the week, in column order. Rows on any other day are ignored. */
export function pivotAllCalls(rows: AllCallsRow[], dayKeys: string[]): AllCallsPivot {
  const blank = () => dayKeys.map(() => 0);
  const blankKinds = () =>
    ({ tenant: { perDay: blank(), total: 0 }, landlord: { perDay: blank(), total: 0 }, agent: { perDay: blank(), total: 0 }, other: { perDay: blank(), total: 0 } }) as Record<
      CallKind,
      { perDay: number[]; total: number }
    >;

  const staffMap = new Map<string, AllCallsStaff>();
  const kindTotals = blankKinds();
  const dailyTotals = blank();
  const sources = new Map<string, number>();
  let answered = 0;
  let notAnswered = 0;

  for (const r of rows) {
    const idx = dayKeys.indexOf(r.kampala_day);
    const n = Number(r.calls) || 0;
    if (idx < 0 || n <= 0) continue;
    const name = r.caller_name?.trim() || 'Call centre officer';
    const key = r.caller_id ?? `name:${name}`;
    const kind = kindOf(r.subject_kind);
    const s = staffMap.get(key) ?? { key, name, perDay: blank(), total: 0, kinds: blankKinds() };
    s.perDay[idx] += n;
    s.total += n;
    s.kinds[kind].perDay[idx] += n;
    s.kinds[kind].total += n;
    staffMap.set(key, s);
    dailyTotals[idx] += n;
    kindTotals[kind].perDay[idx] += n;
    kindTotals[kind].total += n;
    sources.set(r.source, (sources.get(r.source) ?? 0) + n);
    if (r.answered) answered += n;
    else notAnswered += n;
  }

  const staff = Array.from(staffMap.values()).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const order = Object.keys(CALL_SOURCE_LABELS);
  const bySource = Array.from(sources.entries())
    .map(([source, calls]) => ({ source, label: CALL_SOURCE_LABELS[source] ?? source, calls }))
    .sort((a, b) => (order.indexOf(a.source) < 0 ? 99 : order.indexOf(a.source)) - (order.indexOf(b.source) < 0 ? 99 : order.indexOf(b.source)));

  return { staff, dailyTotals, grandTotal: dailyTotals.reduce((a, b) => a + b, 0), kindTotals, bySource, answered, notAnswered };
}
