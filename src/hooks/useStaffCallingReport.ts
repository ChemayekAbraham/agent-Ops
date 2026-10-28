import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { kampalaTodayYmd } from '@/lib/kampalaDays';
import type { AppRole } from '@/hooks/useAuth';

export const JANE_USER_ID = '5295252d-f477-42a9-92f5-af56e503e33d';
export const WINNIE_USER_ID = 'a9258d45-3e27-4827-af71-64344e76fb4f';
export const HANISHA_USER_ID = 'fda0d518-98c4-45e4-83d8-64266b25eefa';
export const MARK_BWAYO_USER_ID = 'fe1e9f51-a2c3-49fc-bd40-b2c143afe628';

export interface CallingStaffMember {
  id: string;
  sys: string;
  short: 'Winnie' | 'Hanisha' | 'Jane';
  display: string;
  roleLabel: string;
  fileSlug: string;
  isHead?: boolean;
}

export const CALLING_TEAM_STAFF: CallingStaffMember[] = [
  {
    id: WINNIE_USER_ID,
    sys: 'WINFRED ASIIMWE',
    short: 'Winnie',
    display: 'Winfred Asiimwe',
    roleLabel: 'Tenant Ops & Landlord Ops - Calling Center',
    fileSlug: 'Winnie-Winfred-Asiimwe',
  },
  {
    id: HANISHA_USER_ID,
    sys: 'Hanishah Amber Kawuki',
    short: 'Hanisha',
    display: 'Hanishah Amber Kawuki',
    roleLabel: 'Tenant Ops & Landlord Ops - Calling Center',
    fileSlug: 'Hanisha-Hanishah-Amber-Kawuki',
  },
  {
    id: JANE_USER_ID,
    sys: 'JANEHEPHZIBAR GIMONO',
    short: 'Jane',
    display: 'Janehephzibar Gimono',
    roleLabel: 'Head - Landlord Ops & Tenant Ops Calling & Pipelines',
    fileSlug: 'Jane-Janehephzibar-Gimono',
    isHead: true,
  },
];

export function getCallingStaffByUserId(userId: string | null | undefined): CallingStaffMember | null {
  if (!userId) return null;
  return CALLING_TEAM_STAFF.find((s) => s.id === userId) ?? null;
}

export function isCallingTeamStaff(userId: string | null | undefined): boolean {
  return Boolean(getCallingStaffByUserId(userId));
}

export function isCallingTeamHead(userId: string | null | undefined): boolean {
  return userId === JANE_USER_ID;
}

/**
 * Strictly gated to HR Mark Bwayo (`fe1e9f51-a2c3-49fc-bd40-b2c143afe628`)
 * so no other user sees "Staff reports" in their personal My Space.
 */
export function canAccessHrStaffReports(
  userId: string | null | undefined,
  _roles?: AppRole[] | null | undefined,
): boolean {
  if (!userId) return false;
  return userId === MARK_BWAYO_USER_ID;
}

/**
 * Pure 7-bit ASCII sanitizer so PDF Helvetica fonts and UI badges never render
 * replacement characters (`ï¿½`).
 */
export function cleanAscii(str: unknown): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00b7/g, ' | ')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normPhone(p: string | null | undefined): string {
  if (!p) return '';
  const d = String(p).replace(/\D/g, '');
  if (d.length >= 9) {
    const n = d.slice(-9);
    return `+256 ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
  }
  return cleanAscii(p);
}

export function titleCaseName(s: string | null | undefined): string {
  return cleanAscii(s || 'Unnamed')
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

export const ROLE_LABEL: Record<string, string> = {
  tenant: 'Tenant',
  landlord: 'Landlord',
  agent: 'Agent',
  other: 'Other',
};

export const OUTCOME_LABEL: Record<string, string> = {
  engaged: 'Reached',
  answered: 'Reached',
  verified: 'Reached - verified',
  completed: 'Reached (app call)',
  received: 'Call received',
  phone_off: 'Phone off',
  no_answer: 'No answer',
  not_answered: 'No answer (app call)',
  failed: 'Call failed',
  cancelled: 'Cancelled',
  wrong_number: 'Wrong number',
  callback_booked: 'Callback booked',
  call_back_later: 'Callback booked',
  call_back: 'Callback booked',
  refused: 'Refused',
  'not reached': 'Not reached',
  'review recorded': 'Pipeline review',
};

export function outcomeLabel(o: string | null | undefined): string {
  if (!o) return 'Recorded';
  return OUTCOME_LABEL[o] || cleanAscii(o).replace(/_/g, ' ');
}

const AWARE_MAP: Record<string, string> = {
  knew: 'Knew',
  heard: 'Had heard',
  did_not_know: 'Did not know',
};

const YN_MAP: Record<string, string> = {
  yes: 'Yes',
  partly: 'Partly',
  no: 'No',
};

export interface RawStaffCallingRow {
  staff_id: string;
  short_name: string;
  staff_name: string;
  ts: string;
  day: string;
  hhmm: string;
  source: string;
  role: string;
  name: string;
  phone: string | null;
  phone9: string;
  answered: boolean | null;
  outcome: string;
  feedback: string | null;
  extra: Record<string, any> | null;
  rr_id: string | null;
  person_id: string | null;
  prio: number;
  excluded_reveals: number;
}

export interface EnrichedStaffCallingRow extends RawStaffCallingRow {
  extra: Record<string, any>;
  ph: string;
  pk: string;
  nm: string;
  ol: string;
  fb: string;
  dayKey: string;
  src: string;
}

export function feedbackText(r: Pick<RawStaffCallingRow, 'source' | 'extra' | 'feedback' | 'outcome'>): string {
  const parts: string[] = [];
  const srcClean = cleanAscii(r.source);
  if (srcClean.includes('Awareness call') || srcClean.includes('Calling Hub')) {
    const x = r.extra || {};
    const bits: string[] = [];
    if (x.aware_30m) bits.push(`30M: ${AWARE_MAP[x.aware_30m] || cleanAscii(x.aware_30m)}`);
    if (x.merchant_codes) bits.push(`Merchant codes: ${AWARE_MAP[x.merchant_codes] || cleanAscii(x.merchant_codes)}`);
    if (x.explained) bits.push(`Explained: ${YN_MAP[x.explained] || cleanAscii(x.explained)}`);
    if (x.landlord_consent) bits.push(`Consent: ${cleanAscii(x.landlord_consent).replace(/_/g, ' ')}`);
    const otpVal = x.payout_otp || x.aware_payout_otp;
    if (otpVal) bits.push(`Payout code: ${cleanAscii(otpVal).replace(/_/g, ' ')}`);
    if (bits.length) parts.push(bits.join('  -  '));
    if (srcClean.includes('Calling Hub') && (x.category || x.feedback_category)) {
      const catStr = cleanAscii(x.category || x.feedback_category);
      const fbClean = cleanAscii(r.feedback);
      if (catStr && (!fbClean || !fbClean.includes(catStr))) {
        parts.push(x.severity ? `${catStr} (${cleanAscii(x.severity)})` : catStr);
      }
    }
  }
  if (r.feedback) {
    parts.push(cleanAscii(r.feedback));
  }
  if (!parts.length) return outcomeLabel(r.outcome);
  return parts.join('  -  ');
}

const FEEDBACK_THEMES: Array<[string, RegExp, RegExp?]> = [
  ['Landlord understood / OTP & process explained', /\b(explained|understood|understand)\b/i],
  [
    'Balance or payment mismatch / statement dispute',
    /mis-?match|shows? (that )?(he|she|they|the)|system shows?|claims?|says? (he|she) (has|had|paid|is|received|got)|owed|dispute|paid .*(yet|but)|balance/i,
  ],
  ['Tenant okay / Landlord verified for payout', /tenant okay|verified landlord|tenant ok|pay landlord/i],
  [
    'Landlord happy / appreciates Welile',
    /thanks? welile|appreciat|likes? (the )?service|okay with (the )?service|happy|satisfied|liked|good idea/i,
  ],
  [
    'Tenant details match the system',
    /\b(corresponds?|correspond(ing)?|matches?|match(ed)?\b.*system|information is correct|same as the system)\b/i,
    /mis-?match|does ?n[o']t match|not match/i,
  ],
  [
    'Finished Rent Plan / asking for renewal',
    /finish(ed)?|complet(ed|e) (his|her|the|their)? ?(rent|loan|payment)|renew|asked for rent|wants? (more )?rent|ask(ed)? (for )?rent|requested for|called to ask for rent|new rent|another (rent|loan)/i,
  ],
  ['Tenant Ops / Landlord Ops pipeline approval', /\bapproved\b/i],
  [
    'Wrong person or wrong phone number',
    /not the one|is not (the owner|\w+\.? ?account)|wrong number|doesn'?t match|doesnot match|not (peruth|the real|him|her)|wrong (person|contact|landlord)|different person|not the landlord/i,
  ],
  [
    'Person unavailable / relative or third party answered',
    /not around|picked up by|picked up and|was not with|son of|daughter|mother|sister|ex wife|someone else|had gone|not available|not with the (real )?owner|will call back/i,
  ],
  [
    'Promised to pay / using merchant code',
    /will (start|pay|use|make|deposit|clear)|merchant code|starts? (using|paying)|promised to (pay|clear)|going to (deposit|pay|start)/i,
  ],
  [
    'Agent complaint or misconduct reported',
    /agent .*(took|got rent in|taken|misconduct|bribe|not the one|failed|miss ?count|has taken long|tortured|rude|mistreats)|bribe|misconduct/i,
  ],
  ['Pipeline return / house photo or tenant arrears issue', /arrears|refused|returned float|photo|pics|pica/i],
];

export function themesOf(text: string): string[] {
  const out: string[] = [];
  for (const [label, re, not] of FEEDBACK_THEMES) {
    if (re.test(text) && !(not && not.test(text))) {
      out.push(label);
    }
  }
  return out;
}

export function hasWrittenNote(r: Pick<EnrichedStaffCallingRow, 'feedback' | 'answered' | 'outcome'>): boolean {
  return Boolean(r.feedback && (r.answered || ['verified', 'received', 'review recorded'].includes(r.outcome)));
}

// ------------------------------------------------------------------ Period Windows (Week Wed-Tue & Specific Month)

export type StaffReportPeriodMode = 'week' | 'month';

export interface StaffCallingPeriodWindow {
  mode: StaffReportPeriodMode;
  /** Inclusive start date YYYY-MM-DD in Africa/Kampala */
  startDay: string;
  /** Inclusive end date YYYY-MM-DD in Africa/Kampala */
  endDay: string;
  /** Inclusive ISO timestamp with +03:00 offset */
  fromIso: string;
  /** Exclusive ISO timestamp with +03:00 offset */
  toIso: string;
  /** Human-readable period label for PDF and UI headers */
  periodLabel: string;
  /** Short period label for subtitles & footers */
  shortLabel: string;
  /** Explicit Kampala time window description */
  timeRangeLabel: string;
  /** Slug for PDF filename */
  fileSlug: string;
  /** Ordered YYYY-MM-DD days in the period */
  days: string[];
}

const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function formatDayLabel(isoYmd: string, long = false): string {
  const d = new Date(`${isoYmd}T00:00:00Z`);
  const wd = WEEKDAYS_SHORT[d.getUTCDay()];
  const mo = MONTHS_SHORT[d.getUTCMonth()];
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return long ? `${wd} ${dd} ${mo} ${d.getUTCFullYear()}` : `${wd} ${dd}`;
}

export function getWedWeekStartYmd(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  const dow = dt.getUTCDay(); // 0=Sun..3=Wed..6=Sat
  const offset = (dow - 3 + 7) % 7;
  dt.setUTCDate(dt.getUTCDate() - offset);
  return dt.toISOString().slice(0, 10);
}

export function addUtcDays(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

export function enumerateDays(startYmd: string, endYmd: string): string[] {
  const out: string[] = [];
  for (
    let d = new Date(`${startYmd}T00:00:00Z`);
    d.toISOString().slice(0, 10) <= endYmd;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Builds a Wednesday 00:00 EAT -> Tuesday 23:59 EAT week window containing `anchorYmd`.
 */
export function buildWeekPeriodWindow(anchorYmd: string): StaffCallingPeriodWindow {
  const startDay = getWedWeekStartYmd(anchorYmd);
  const endDay = addUtcDays(startDay, 6);
  const nextWedDay = addUtcDays(startDay, 7);
  const days = enumerateDays(startDay, endDay);

  const sDate = new Date(`${startDay}T00:00:00Z`);
  const eDate = new Date(`${endDay}T00:00:00Z`);
  const sStr = `${String(sDate.getUTCDate()).padStart(2, '0')} ${MONTHS_SHORT[sDate.getUTCMonth()]} ${sDate.getUTCFullYear()}`;
  const eStr = `${String(eDate.getUTCDate()).padStart(2, '0')} ${MONTHS_SHORT[eDate.getUTCMonth()]} ${eDate.getUTCFullYear()}`;

  return {
    mode: 'week',
    startDay,
    endDay,
    fromIso: `${startDay}T00:00:00+03:00`,
    toIso: `${nextWedDay}T00:00:00+03:00`,
    periodLabel: `Week: Wed ${sStr} - Tue ${eStr} (Wed 00:00 - Tue 23:59 EAT)`,
    shortLabel: `Wed ${sStr} - Tue ${eStr}`,
    timeRangeLabel: `Wednesday ${sStr} 00:00 EAT to Tuesday ${eStr} 23:59 EAT`,
    fileSlug: `Week-${startDay}-to-${endDay}`,
    days,
  };
}

/**
 * Builds a specific calendar month window (`YYYY-MM`, e.g. `2026-10` for October 2026).
 */
export function buildMonthPeriodWindow(yearMonth: string, todayYmd = kampalaTodayYmd()): StaffCallingPeriodWindow {
  const [yStr, mStr] = yearMonth.split('-');
  const year = Number(yStr) || 2026;
  const month = Number(mStr) || 10; // 1..12
  const startDay = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;

  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextMonthStart = `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`;
  const lastDayOfMonth = addUtcDays(nextMonthStart, -1);

  const isCurrentMonth = todayYmd.slice(0, 7) === yearMonth && todayYmd <= lastDayOfMonth && todayYmd >= startDay;
  const effectiveEndDay = isCurrentMonth ? todayYmd : lastDayOfMonth;
  const days = enumerateDays(startDay, effectiveEndDay);

  const monthFull = MONTHS_FULL[month - 1] || 'Month';
  const monthShort = MONTHS_SHORT[month - 1] || 'Mo';
  const endDayNum = Number(effectiveEndDay.slice(8, 10));

  const periodLabel = isCurrentMonth
    ? `${monthFull} ${year} (1 - ${endDayNum} ${monthShort}, month to date)`
    : `${monthFull} ${year} (1 - ${endDayNum} ${monthShort} ${year})`;

  return {
    mode: 'month',
    startDay,
    endDay: effectiveEndDay,
    fromIso: `${startDay}T00:00:00+03:00`,
    toIso: `${nextMonthStart}T00:00:00+03:00`,
    periodLabel,
    shortLabel: `${monthFull} ${year}`,
    timeRangeLabel: `01 ${monthShort} ${year} 00:00 EAT to ${String(endDayNum).padStart(2, '0')} ${monthShort} ${year} 23:59 EAT`,
    fileSlug: `${monthShort}-${year}`,
    days,
  };
}

export function listRecentWedTueWeeks(count = 16, todayYmd = kampalaTodayYmd()) {
  const currentWed = getWedWeekStartYmd(todayYmd);
  return Array.from({ length: count }, (_, idx) => {
    const wed = addUtcDays(currentWed, -idx * 7);
    const win = buildWeekPeriodWindow(wed);
    return {
      weekStart: wed,
      label: idx === 0 ? `Current week (${win.shortLabel})` : win.shortLabel,
      timeRangeLabel: win.timeRangeLabel,
      window: win,
    };
  });
}

export function listRecentMonths(count = 12, todayYmd = kampalaTodayYmd()) {
  const [y, m] = todayYmd.slice(0, 7).split('-').map(Number);
  return Array.from({ length: count }, (_, idx) => {
    const dt = new Date(Date.UTC(y, (m || 1) - 1 - idx, 1));
    const ym = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
    const win = buildMonthPeriodWindow(ym, todayYmd);
    return {
      yearMonth: ym,
      label: win.shortLabel,
      periodLabel: win.periodLabel,
      window: win,
    };
  });
}

// ------------------------------------------------------------------ Stats & Report Aggregation

export interface StaffCallStats {
  total: number;
  people: number;
  reached: number;
  notReached: number;
  reviewOnly: number;
  known: number;
  reachPct: number;
  activeDays: number;
  avg: number;
  busiest: { day: string; n: number } | null;
  byDay: Map<string, EnrichedStaffCallingRow[]>;
}

export interface ChannelBreakdownRow {
  source: string;
  count: number;
  sharePct: number;
  reached: number;
  known: number;
  reachPct: number | null;
  withNotes: number;
}

export interface OutcomeBreakdownRow {
  label: string;
  value: number;
  sharePct: number;
  tone: 'good' | 'warn' | 'info';
}

export interface ThemeBreakdownRow {
  label: string;
  value: number;
  sharePct: number;
  byStaff: Record<string, number>;
}

export interface DirectoryPersonRow {
  name: string;
  phone: string;
  role: string;
  roleLabel: string;
  calls: number;
  reached: number;
  firstDay: string;
  lastDay: string;
  lastOutcome: string;
  lastFeedback: string;
}

export interface IndividualStaffReportData {
  person: CallingStaffMember;
  rows: EnrichedStaffCallingRow[];
  stats: StaffCallStats;
  excludedReveals: number;
  channels: ChannelBreakdownRow[];
  outcomes: OutcomeBreakdownRow[];
  themes: ThemeBreakdownRow[];
  withWrittenNotesCount: number;
  directory: DirectoryPersonRow[];
}

export interface TeamCallingReportData {
  rows: EnrichedStaffCallingRow[];
  stats: StaffCallStats;
  perStaff: IndividualStaffReportData[];
  outcomes: OutcomeBreakdownRow[];
  themes: ThemeBreakdownRow[];
  withWrittenNotesCount: number;
  ccCategories: Array<{
    category: string;
    total: number;
    sharePct: number;
    highSeverity: number;
    byStaff: Record<string, number>;
  }>;
  ccReachedWithFeedbackCount: number;
  awareness: {
    totalCalls: number;
    answeredCalls: number;
    unreachableCalls: number;
    pairedWithVerification: number;
    questions: Array<{
      question: string;
      col1: string;
      col2: string;
      col3: string;
      col4: number;
    }>;
  };
  pipelineDesks: Array<{
    deskAction: string;
    staff: string;
    entries: number;
    summary: string;
  }>;
  verbatimSamples: Array<{
    dateTime: string;
    staff: string;
    person: string;
    phone: string;
    category: string;
    feedback: string;
  }>;
}

export function computeStats(rs: EnrichedStaffCallingRow[]): StaffCallStats {
  const known = rs.filter((r) => r.answered !== null && r.answered !== undefined);
  const reached = known.filter((r) => r.answered === true).length;
  const notReached = known.filter((r) => r.answered === false).length;
  const reviewOnly = rs.length - known.length;
  const people = new Set(rs.map((r) => r.pk));
  const byDay = new Map<string, EnrichedStaffCallingRow[]>();
  rs.forEach((r) => {
    const a = byDay.get(r.dayKey) || [];
    a.push(r);
    byDay.set(r.dayKey, a);
  });
  const activeDays = byDay.size;
  let busiest: { day: string; n: number } | null = null;
  byDay.forEach((a, k) => {
    if (!busiest || a.length > busiest.n) busiest = { day: k, n: a.length };
  });
  return {
    total: rs.length,
    people: people.size,
    reached,
    notReached,
    reviewOnly,
    known: known.length,
    reachPct: known.length ? Math.round((reached / known.length) * 100) : 0,
    activeDays,
    avg: activeDays ? rs.length / activeDays : 0,
    busiest,
    byDay,
  };
}

export function enrichRawCallingRows(
  rawRows: RawStaffCallingRow[],
  startDay: string,
  endDay: string,
): EnrichedStaffCallingRow[] {
  return rawRows
    .filter((r) => r.day >= startDay && r.day <= endDay)
    .map((r) => {
      const rawPhone = r.phone || '';
      const ph = normPhone(rawPhone);
      const pk = rawPhone
        ? String(rawPhone).replace(/\D/g, '').slice(-9)
        : `name:${cleanAscii(r.name).toLowerCase()}`;
      const nm = titleCaseName(r.name || 'Unnamed');
      const ol = outcomeLabel(r.outcome);
      const fb = feedbackText(r);
      return {
        ...r,
        extra: r.extra || {},
        phone: rawPhone,
        ph,
        pk,
        nm,
        ol,
        fb,
        dayKey: r.day,
        src: cleanAscii(r.source),
      };
    });
}

function classifyOutcomeTone(label: string): 'good' | 'warn' | 'info' {
  if (/Reached|received|verified/i.test(label)) return 'good';
  if (/Phone off|No answer|Wrong|failed|Cancelled|Not reached/i.test(label)) return 'warn';
  return 'info';
}

export function buildIndividualReportData(
  person: CallingStaffMember,
  allRows: EnrichedStaffCallingRow[],
): IndividualStaffReportData {
  const rs = allRows
    .filter((r) => r.staff_id === person.id)
    .sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const st = computeStats(rs);
  const excludedReveals = rs.length > 0 ? Math.max(...rs.map((r) => r.excluded_reveals || 0)) : 0;

  // Channel breakdown
  const bySrc = new Map<string, { n: number; reached: number; known: number; notes: number }>();
  rs.forEach((r) => {
    const a = bySrc.get(r.src) || { n: 0, reached: 0, known: 0, notes: 0 };
    a.n += 1;
    if (r.answered !== null && r.answered !== undefined) {
      a.known += 1;
      if (r.answered) a.reached += 1;
    }
    if (hasWrittenNote(r)) a.notes += 1;
    bySrc.set(r.src, a);
  });
  const channels: ChannelBreakdownRow[] = [...bySrc.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([source, v]) => ({
      source,
      count: v.n,
      sharePct: st.total ? Math.round((v.n / st.total) * 100) : 0,
      reached: v.reached,
      known: v.known,
      reachPct: v.known ? Math.round((v.reached / v.known) * 100) : null,
      withNotes: v.notes,
    }));

  // Outcomes
  const oc = new Map<string, number>();
  rs.forEach((r) => oc.set(r.ol, (oc.get(r.ol) || 0) + 1));
  const outcomes: OutcomeBreakdownRow[] = [...oc.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({
      label,
      value,
      sharePct: st.total ? Math.round((value / st.total) * 100) : 0,
      tone: classifyOutcomeTone(label),
    }));

  // Themes
  const th = new Map<string, number>();
  let withNotes = 0;
  rs.filter(hasWrittenNote).forEach((r) => {
    withNotes += 1;
    themesOf(r.fb).forEach((t) => th.set(t, (th.get(t) || 0) + 1));
  });
  const themes: ThemeBreakdownRow[] = [...th.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({
      label,
      value,
      sharePct: withNotes ? Math.round((value / withNotes) * 100) : 0,
      byStaff: { [person.short]: value },
    }));

  // Directory of people called
  const per = new Map<
    string,
    {
      name: string;
      ph: string;
      role: string;
      n: number;
      reached: number;
      first: string;
      last: string;
      lastFb: string;
      lastOl: string;
    }
  >();
  rs.forEach((r) => {
    const a = per.get(r.pk) || {
      name: r.nm,
      ph: r.ph,
      role: r.role,
      n: 0,
      reached: 0,
      first: r.dayKey,
      last: r.dayKey,
      lastFb: '',
      lastOl: '',
    };
    a.n += 1;
    if (r.answered) a.reached += 1;
    if (r.nm && r.nm !== 'Unnamed') a.name = r.nm;
    if (r.ph) a.ph = r.ph;
    a.last = r.dayKey;
    a.lastFb = r.fb;
    a.lastOl = r.ol;
    per.set(r.pk, a);
  });
  const directory: DirectoryPersonRow[] = [...per.values()]
    .sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : a.name.localeCompare(b.name)))
    .map((p) => ({
      name: p.name,
      phone: p.ph || '-',
      role: p.role,
      roleLabel: ROLE_LABEL[p.role] || p.role,
      calls: p.n,
      reached: p.reached,
      firstDay: p.first,
      lastDay: p.last,
      lastOutcome: p.lastOl,
      lastFeedback: p.lastFb,
    }));

  return {
    person,
    rows: rs,
    stats: st,
    excludedReveals,
    channels,
    outcomes,
    themes,
    withWrittenNotesCount: withNotes,
    directory,
  };
}

export function buildTeamCallingReportData(
  rawRows: RawStaffCallingRow[],
  periodWindow: StaffCallingPeriodWindow,
): TeamCallingReportData {
  const all = enrichRawCallingRows(rawRows, periodWindow.startDay, periodWindow.endDay);
  const perStaff = CALLING_TEAM_STAFF.map((person) => buildIndividualReportData(person, all));
  const st = computeStats(all);

  // Team outcomes
  const oc = new Map<string, number>();
  all.forEach((r) => oc.set(r.ol, (oc.get(r.ol) || 0) + 1));
  const outcomes: OutcomeBreakdownRow[] = [...oc.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({
      label,
      value,
      sharePct: st.total ? Math.round((value / st.total) * 100) : 0,
      tone: classifyOutcomeTone(label),
    }));

  // Team themes
  const themeCount = new Map<string, number>();
  const themeBy = new Map<string, Record<string, number>>();
  let withNotes = 0;
  all.filter(hasWrittenNote).forEach((r) => {
    withNotes += 1;
    themesOf(r.fb).forEach((t) => {
      themeCount.set(t, (themeCount.get(t) || 0) + 1);
      const map = themeBy.get(t) || {};
      map[r.short_name] = (map[r.short_name] || 0) + 1;
      themeBy.set(t, map);
    });
  });
  const themes: ThemeBreakdownRow[] = [...themeCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({
      label,
      value,
      sharePct: withNotes ? Math.round((value / withNotes) * 100) : 0,
      byStaff: themeBy.get(label) || {},
    }));

  // Calling Center & Calling Hub structured categories
  const cc = all.filter(
    (r) =>
      ((r.src.includes('Calling Center') && !r.src.includes('Inbound') && r.outcome === 'engaged') ||
        (r.src.includes('Calling Hub') && r.outcome === 'answered')) &&
      r.feedback,
  );
  const cats = new Map<string, { n: number; high: number; by: Record<string, number> }>();
  cc.forEach((r) => {
    const cat = cleanAscii(r.extra.category || 'Other');
    const sev = r.extra.severity || '-';
    const a = cats.get(cat) || { n: 0, high: 0, by: {} };
    a.n += 1;
    if (sev === 'high' || sev === 'critical') a.high += 1;
    a.by[r.short_name] = (a.by[r.short_name] || 0) + 1;
    cats.set(cat, a);
  });
  const ccCategories = [...cats.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([category, v]) => ({
      category,
      total: v.n,
      sharePct: cc.length ? Math.round((v.n / cc.length) * 100) : 0,
      highSeverity: v.high,
      byStaff: v.by,
    }));

  // Awareness calls breakdown (includes Landlord Calling Hub awareness checks)
  const aw = all.filter((r) => r.src.includes('Awareness call') || r.src.includes('Calling Hub'));
  const awAnswered = aw.filter((r) => r.answered);
  const T = awAnswered.length;
  const cnt = (f: string, v: string) =>
    awAnswered.filter((r) => (f === 'payout_otp' ? (r.extra.payout_otp || r.extra.aware_payout_otp) === v : r.extra[f] === v))
      .length;
  const pctStr = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '0%');

  const awareness = {
    totalCalls: aw.length,
    answeredCalls: awAnswered.length,
    unreachableCalls: aw.length - awAnswered.length,
    pairedWithVerification: aw.filter((r) => r.extra.landlord_ops_comment).length,
    questions: [
      {
        question: 'Did the landlord know about up to UGX 30M access?',
        col1: `${cnt('aware_30m', 'knew')} (${pctStr(cnt('aware_30m', 'knew'), T)})`,
        col2: `${cnt('aware_30m', 'heard')} (${pctStr(cnt('aware_30m', 'heard'), T)})`,
        col3: `${cnt('aware_30m', 'did_not_know')} (${pctStr(cnt('aware_30m', 'did_not_know'), T)})`,
        col4: T - cnt('aware_30m', 'knew') - cnt('aware_30m', 'heard') - cnt('aware_30m', 'did_not_know'),
      },
      {
        question: 'Was Welile and the OTP / payout process explained on the call?',
        col1: `${cnt('explained', 'yes')} (${pctStr(cnt('explained', 'yes'), T)})`,
        col2: `${cnt('explained', 'partly')} (${pctStr(cnt('explained', 'partly'), T)})`,
        col3: `${cnt('explained', 'no')} (${pctStr(cnt('explained', 'no'), T)})`,
        col4: T - cnt('explained', 'yes') - cnt('explained', 'partly') - cnt('explained', 'no'),
      },
      {
        question: 'Did the landlord consent to the tenant Rent Plan?',
        col1: `${cnt('landlord_consent', 'consents')} (${pctStr(cnt('landlord_consent', 'consents'), T)})`,
        col2: '-',
        col3: `${cnt('landlord_consent', 'unsure')} (${pctStr(cnt('landlord_consent', 'unsure'), T)})`,
        col4: T - cnt('landlord_consent', 'consents') - cnt('landlord_consent', 'unsure'),
      },
      {
        question: 'Did the landlord know about the payout OTP code?',
        col1: `${cnt('payout_otp', 'knew')} (${pctStr(cnt('payout_otp', 'knew'), T)})`,
        col2: `${cnt('payout_otp', 'heard')} (${pctStr(cnt('payout_otp', 'heard'), T)})`,
        col3: `${cnt('payout_otp', 'did_not_know')} (${pctStr(cnt('payout_otp', 'did_not_know'), T)})`,
        col4: T - cnt('payout_otp', 'knew') - cnt('payout_otp', 'heard') - cnt('payout_otp', 'did_not_know'),
      },
    ],
  };

  const standaloneVerifCount = all.filter((r) => r.src.includes('verification call')).length;
  const pairedVerifCount = aw.filter((r) => r.extra.landlord_ops_comment).length;
  const landlordReviewCount = all.filter((r) => r.src.includes('Landlord Ops review feedback')).length;
  const tenantReviewCount = all.filter((r) => r.src.includes('Tenant Ops review feedback')).length;

  const pipelineDesks = [
    {
      deskAction: 'Landlord Ops  -  Verification phone call (standalone)',
      staff: 'Jane',
      entries: standaloneVerifCount,
      summary: `${standaloneVerifCount} landlords phoned and verified ("Tenant okay | Pay landlord") before approving the Rent Plan.`,
    },
    {
      deskAction: 'Landlord Ops  -  Verification paired with Awareness call',
      staff: 'Jane',
      entries: pairedVerifCount,
      summary: `${pairedVerifCount} awareness calls also recorded Landlord Ops review feedback on the same Rent Plan (merged so each call is counted once).`,
    },
    {
      deskAction: 'Landlord Ops  -  Review feedback (declined / returned)',
      staff: 'Jane',
      entries: landlordReviewCount,
      summary: `${landlordReviewCount} standalone Landlord Ops review actions recorded before approval or return.`,
    },
    {
      deskAction: 'Tenant Ops  -  Pre-approval review feedback',
      staff: 'Jane',
      entries: tenantReviewCount,
      summary: `${tenantReviewCount} Tenant Ops pipeline reviews recorded prior to advancing or declining the Rent Plan.`,
    },
  ];

  // Dynamic verbatim samples from the period's rows with detailed notes
  const notableRows = all
    .filter((r) => r.feedback && r.feedback.length >= 25)
    .sort((a, b) => {
      const aHigh = a.extra?.severity === 'high' || a.src.includes('Inbound') ? 0 : 1;
      const bHigh = b.extra?.severity === 'high' || b.src.includes('Inbound') ? 0 : 1;
      if (aHigh !== bHigh) return aHigh - bHigh;
      return b.feedback!.length - a.feedback!.length;
    })
    .slice(0, 10);

  const verbatimSamples = notableRows.map((r) => {
    const dt = new Date(`${r.dayKey}T00:00:00Z`);
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    const mo = MONTHS_SHORT[dt.getUTCMonth()];
    const cat = r.extra?.category
      ? `${cleanAscii(r.extra.category)}${r.extra.severity ? ` (${cleanAscii(r.extra.severity)})` : ''}`
      : r.src.replace('Rent Pipeline - ', '').replace('Calling Center - ', '');
    return {
      dateTime: `${dd} ${mo}  -  ${r.hhmm}`,
      staff: r.short_name,
      person: `${r.nm} (${ROLE_LABEL[r.role] || r.role})`,
      phone: r.ph || '-',
      category: cleanAscii(cat),
      feedback: r.fb,
    };
  });

  return {
    rows: all,
    stats: st,
    perStaff,
    outcomes,
    themes,
    withWrittenNotesCount: withNotes,
    ccCategories,
    ccReachedWithFeedbackCount: cc.length,
    awareness,
    pipelineDesks,
    verbatimSamples,
  };
}

export async function fetchStaffCallingDetailedRows(
  fromIso: string,
  toIso: string,
): Promise<RawStaffCallingRow[]> {
  const pageSize = 1000;
  let offset = 0;
  const all: RawStaffCallingRow[] = [];

  while (true) {
    const { data, error } = await (supabase.rpc as any)('staff_calling_detailed_report', {
      p_from: fromIso,
      p_to: toIso,
    }).range(offset, offset + pageSize - 1);

    if (error) throw error;
    const batch = ((data ?? []) as any[]).map(
      (r): RawStaffCallingRow => ({
        staff_id: String(r.staff_id),
        short_name: String(r.short_name ?? ''),
        staff_name: String(r.staff_name ?? ''),
        ts: String(r.ts),
        day: String(r.day),
        hhmm: String(r.hhmm ?? ''),
        source: String(r.source ?? ''),
        role: String(r.role ?? 'other'),
        name: String(r.name ?? 'Unnamed'),
        phone: r.phone ?? null,
        phone9: String(r.phone9 ?? ''),
        answered: r.answered === null || r.answered === undefined ? null : Boolean(r.answered),
        outcome: String(r.outcome ?? ''),
        feedback: r.feedback ?? null,
        extra: (r.extra as Record<string, any>) ?? null,
        rr_id: r.rr_id ?? null,
        person_id: r.person_id ?? null,
        prio: Number(r.prio ?? 1),
        excluded_reveals: Number(r.excluded_reveals ?? 0),
      }),
    );

    all.push(...batch);
    if (batch.length < pageSize) break;
    offset += batch.length;
  }

  return all;
}

export function useStaffCallingReport(periodWindow: StaffCallingPeriodWindow, enabled = true) {
  return useQuery({
    queryKey: ['staff-calling-detailed-report', periodWindow.fromIso, periodWindow.toIso],
    enabled: enabled && Boolean(periodWindow.fromIso && periodWindow.toIso),
    staleTime: 30_000,
    queryFn: async (): Promise<TeamCallingReportData> => {
      const rawRows = await fetchStaffCallingDetailedRows(periodWindow.fromIso, periodWindow.toIso);
      return buildTeamCallingReportData(rawRows, periodWindow);
    },
  });
}
