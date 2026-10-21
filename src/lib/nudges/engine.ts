/**
 * Shared engine for dashboard nudge toasts (agent, funder, ...).
 *
 * Each persona keeps its own copy in a nudges.json and its own stats RPC; this
 * module only matches rules, fills placeholders, picks one nudge and paces
 * them. It fetches nothing and shows nothing.
 *
 * A nudge is eligible when every `when` rule holds AND every {placeholder} in
 * its title/body has a value, so a missing figure silently skips the nudge
 * instead of printing "null".
 */

export type NudgeTone = 'nudge' | 'celebrate' | 'info';

export type NudgeRule = Partial<Record<'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne', number>> & {
  exists?: boolean;
};

export interface NudgeTemplate<Cta extends string = string> {
  id: string;
  category: string;
  tone: NudgeTone;
  weight?: number;
  when?: Record<string, NudgeRule>;
  title: string;
  body: string;
  cta?: Cta;
}

export interface RenderedNudge<Cta extends string = string> {
  id: string;
  category: string;
  tone: NudgeTone;
  title: string;
  body: string;
  cta?: Cta;
}

export type NudgeValue = string | number | null;
export type NudgeValues = Record<string, NudgeValue>;

export interface RenderFormat {
  /** Keys holding UGX amounts; rendered with the viewer's currency. */
  moneyKeys?: ReadonlySet<string>;
  /** Keys holding ISO dates (YYYY-MM-DD); rendered like "7 Nov". */
  dateKeys?: ReadonlySet<string>;
  formatMoney?: (amount: number) => string;
  formatDate?: (isoDate: string) => string;
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

function kampalaPart(now: Date, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'Africa/Kampala' }).format(now);
}

export function kampalaHour(now: Date): number {
  return Number(kampalaPart(now, { hour: 'numeric', hourCycle: 'h23' }));
}

/** hour 0-23, day_of_week 1 (Mon)-7 (Sun), day_of_month 1-31, all Kampala. */
export function kampalaClock(now: Date): { hour: number; day_of_week: number; day_of_month: number } {
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return {
    hour: kampalaHour(now),
    day_of_week: weekdays.indexOf(kampalaPart(now, { weekday: 'short' })) + 1,
    day_of_month: Number(kampalaPart(now, { day: 'numeric' })),
  };
}

/** "SHAFEEQ" / "nakasagga juliet" → "Shafeeq" / "Nakasagga Juliet"; mixed case is kept. */
export function tidyName(name: string | null | undefined): string | null {
  const s = name?.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  if (s !== s.toUpperCase() && s !== s.toLowerCase()) return s;
  return s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
}

/** "2026-11-07" → "7 Nov". Anything unparseable is returned as given. */
export function shortDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) return isoDate;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]}`;
}

const PLACEHOLDER = /\{(\w+)\}/g;

export function placeholdersOf(t: Pick<NudgeTemplate, 'title' | 'body'>): string[] {
  return [...`${t.title} ${t.body}`.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

function ruleHolds(value: NudgeValue, rule: NudgeRule): boolean {
  const present = value != null && value !== '';
  if (rule.exists !== undefined && rule.exists !== present) return false;
  const numeric = Object.keys(rule).some((k) => k !== 'exists');
  if (!numeric) return true;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (rule.gt !== undefined && !(value > rule.gt)) return false;
  if (rule.gte !== undefined && !(value >= rule.gte)) return false;
  if (rule.lt !== undefined && !(value < rule.lt)) return false;
  if (rule.lte !== undefined && !(value <= rule.lte)) return false;
  if (rule.eq !== undefined && value !== rule.eq) return false;
  if (rule.ne !== undefined && value === rule.ne) return false;
  return true;
}

/** A nudge fits when all its rules hold and every placeholder has a value. */
export function isNudgeEligible(t: NudgeTemplate, values: NudgeValues): boolean {
  for (const [key, rule] of Object.entries(t.when ?? {})) {
    if (!ruleHolds(values[key] ?? null, rule)) return false;
  }
  return placeholdersOf(t).every((k) => values[k] != null && values[k] !== '');
}

export function renderNudge<Cta extends string>(
  t: NudgeTemplate<Cta>,
  values: NudgeValues,
  format: RenderFormat = {},
): RenderedNudge<Cta> {
  const { moneyKeys, dateKeys, formatMoney = String, formatDate = shortDate } = format;
  const fill = (s: string) =>
    s.replace(PLACEHOLDER, (_, key: string) => {
      const v = values[key];
      if (v == null) return '';
      if (moneyKeys?.has(key)) return formatMoney(Number(v));
      if (dateKeys?.has(key)) return formatDate(String(v));
      return typeof v === 'number' ? v.toLocaleString('en-US') : v;
    });
  return { id: t.id, category: t.category, tone: t.tone, title: fill(t.title), body: fill(t.body), cta: t.cta };
}

export interface PickFromValuesOptions {
  /** Nudge ids to skip, e.g. the last few shown. Ignored if it would leave nothing. */
  exclude?: Iterable<string>;
  /** Returns a number in [0, 1). Defaults to Math.random. */
  random?: () => number;
}

/** Weighted-random pick among the templates that fit `values`; null when none fit. */
export function pickTemplate<Cta extends string>(
  templates: NudgeTemplate<Cta>[],
  values: NudgeValues,
  opts: PickFromValuesOptions = {},
): NudgeTemplate<Cta> | null {
  const eligible = templates.filter((t) => isNudgeEligible(t, values));
  if (eligible.length === 0) return null;

  const skip = new Set(opts.exclude ?? []);
  const fresh = eligible.filter((t) => !skip.has(t.id));
  const pool = fresh.length > 0 ? fresh : eligible;

  const total = pool.reduce((sum, t) => sum + Math.max(t.weight ?? 1, 0), 0);
  let r = (opts.random ?? Math.random)() * total;
  for (const t of pool) {
    r -= Math.max(t.weight ?? 1, 0);
    if (r < 0) return t;
  }
  return pool[pool.length - 1];
}

/** How often nudges may appear: at most one per cooldown, only in waking hours. */
export interface NudgePacing {
  cooldownMs: number;
  /** Kampala hours, [from, to). */
  hours: { from: number; to: number };
  recentLimit: number;
}

export interface NudgeHistory {
  lastShownAt: number | null;
  /** Most recent first. */
  recent: string[];
}

export function canShowNudgeWith(pacing: NudgePacing, history: NudgeHistory, now: Date = new Date()): boolean {
  const h = kampalaHour(now);
  if (h < pacing.hours.from || h >= pacing.hours.to) return false;
  return history.lastShownAt == null || now.getTime() - history.lastShownAt >= pacing.cooldownMs;
}

export function recordNudgeWith(
  pacing: NudgePacing,
  history: NudgeHistory,
  id: string,
  now: Date = new Date(),
): NudgeHistory {
  return {
    lastShownAt: now.getTime(),
    recent: [id, ...history.recent.filter((r) => r !== id)].slice(0, pacing.recentLimit),
  };
}
