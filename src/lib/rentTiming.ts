// Types and small pure helpers for Rent Plan application timing (rent_request_timing / rent_request_timing_history).
//
// Every duration, entry time, previous visit and quality label comes from the server's answer, which carries ONE as_of for the whole batch. Nothing
// here measures time against the browser clock, decides which desk a request is at, or works out a visit; it only types the answer, picks the words
// and formats the numbers, so every screen that shows a request shows the same values at the same as_of.

export const TIMING_BATCH_LIMIT = 200;

export type TimingQuality = 'confirmed' | 'estimated' | 'unavailable';
export type TimingState = 'at_desk' | 'correction' | 'processed' | 'ended' | 'unavailable';
export type TimingDesk = 'service_center' | 'agent_ops' | 'tenant_ops' | 'landlord_ops' | 'partner_ops' | 'coo' | 'cfo' | 'correction' | 'agent';

export interface TimingVisit {
  desk: string;
  start: string | null;
  end: string | null;
  seconds: number | null;
  quality: TimingQuality;
  source: string | null;
}

export interface TimingCurrent {
  desk: string;
  entry: string;
  seconds: number;
  quality: TimingQuality;
  source: string | null;
}

export interface TimingPayout {
  funded_at: string | null;
  landlord_paid_at: string | null;
  landlord_paid_quality: TimingQuality;
  waiting_seconds: number | null;
  still_waiting: boolean;
  note: string | null;
}

export interface RentTiming {
  request_id: string;
  state: TimingState;
  desk: string | null;
  current: TimingCurrent | null;
  previous: TimingVisit | null;
  request_start: string | null;
  processing_end: string | null;
  total_seconds: number | null;
  quality: TimingQuality;
  evidence: string[];
  missing_reason: string | null;
  skipped_desks: string[];
  flags: string[];
  payout: TimingPayout | null;
  /** only on the history answer */
  visits: TimingVisit[] | null;
  as_of: string;
}

export interface RentTimingBatch {
  as_of: string;
  requested: number;
  returned: number;
  /** request ids the server left out (not visible to the caller, or not found); a screen shows these as "Not available", never as zero */
  rows: RentTiming[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
const numOrNull = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const quality = (v: unknown): TimingQuality => (v === 'confirmed' || v === 'estimated' ? v : 'unavailable');
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

const STATES: readonly string[] = ['at_desk', 'correction', 'processed', 'ended', 'unavailable'];

function visit(v: unknown): TimingVisit {
  const o = obj(v);
  return { desk: String(o.desk ?? ''), start: str(o.start), end: str(o.end), seconds: numOrNull(o.seconds), quality: quality(o.quality), source: str(o.source) };
}

export function normalizeTiming(raw: unknown, asOf = ''): RentTiming {
  const o = obj(raw);
  const cur = o.current ? obj(o.current) : null;
  const pay = o.payout ? obj(o.payout) : null;
  return {
    request_id: String(o.request_id ?? ''),
    state: (STATES.includes(String(o.state)) ? String(o.state) : 'unavailable') as TimingState,
    desk: str(o.desk),
    current: cur && str(cur.entry) && numOrNull(cur.seconds) != null
      ? { desk: String(cur.desk ?? ''), entry: String(cur.entry), seconds: Number(cur.seconds), quality: quality(cur.quality), source: str(cur.source) }
      : null,
    previous: o.previous ? visit(o.previous) : null,
    request_start: str(o.request_start),
    processing_end: str(o.processing_end),
    total_seconds: numOrNull(o.total_seconds),
    quality: quality(o.quality),
    evidence: strings(o.evidence),
    missing_reason: str(o.missing_reason),
    skipped_desks: strings(o.skipped_desks),
    flags: strings(o.flags),
    payout: pay
      ? { funded_at: str(pay.funded_at), landlord_paid_at: str(pay.landlord_paid_at), landlord_paid_quality: quality(pay.landlord_paid_quality),
          waiting_seconds: numOrNull(pay.waiting_seconds), still_waiting: pay.still_waiting === true, note: str(pay.note) }
      : null,
    visits: Array.isArray(o.visits) ? o.visits.map(visit) : null,
    as_of: str(o.as_of) ?? asOf,
  };
}

export function normalizeTimingBatch(raw: unknown): RentTimingBatch {
  const o = obj(Array.isArray(raw) ? raw[0] : raw);
  const asOf = String(o.as_of ?? '');
  const rows = Array.isArray(o.rows) ? o.rows.map((r) => normalizeTiming(r, asOf)) : [];
  return { as_of: asOf, requested: numOrNull(o.requested) ?? 0, returned: numOrNull(o.returned) ?? rows.length, rows };
}

// ---------- words and numbers ----------

export const DESK_LABEL: Record<string, string> = {
  service_center: 'Service Centre',
  agent_ops: 'Agent Ops',
  tenant_ops: 'Tenant Ops',
  landlord_ops: 'Landlord Ops',
  partner_ops: 'Partner Ops',
  coo: 'COO',
  cfo: 'CFO',
  correction: 'Waiting for agent correction',
  agent: 'Agent',
};
export const deskLabel = (desk: string | null | undefined): string => (desk ? DESK_LABEL[desk] ?? desk.replace(/_/g, ' ') : 'None');

export const QUALITY_LABEL: Record<TimingQuality, string> = { confirmed: 'Recorded', estimated: 'Estimated', unavailable: 'Not recorded' };

export const MISSING_REASON_LABEL: Record<string, string> = {
  created_at_missing_or_in_the_future: 'The request has no valid start time.',
  service_center_verification_time_not_recorded: 'The Service Centre verification time was not recorded.',
  approval_stamp_missing_for_the_current_desk: 'The time this desk received the request was not recorded.',
  processing_endpoint_not_recorded: 'The time this request was closed was not recorded.',
};
export const missingReasonLabel = (r: string | null | undefined): string | null => (r ? MISSING_REASON_LABEL[r] ?? r.replace(/_/g, ' ') : null);

const MIN = 60;
const HOUR = 3600;
const DAY = 86400;

/**
 * Elapsed seconds as words. Elapsed time, nights and weekends included (no working-day rule). Under an hour: minutes. Under a day: hours and minutes.
 * A day or more: days and hours. null (not recorded) is "Not available", never "0".
 */
export function formatElapsed(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return 'Not available';
  const s = Math.floor(seconds);
  if (s < MIN) return 'Under 1 min';
  if (s < HOUR) return `${Math.floor(s / MIN)} min`;
  if (s < DAY) {
    const h = Math.floor(s / HOUR);
    const m = Math.floor((s % HOUR) / MIN);
    return m === 0 ? `${h} h` : `${h} h ${m} min`;
  }
  const d = Math.floor(s / DAY);
  const h = Math.floor((s % DAY) / HOUR);
  return h === 0 ? `${d} d` : `${d} d ${h} h`;
}

/** "16 Oct 2026, 14:32" in Kampala time, for an ISO timestamp from the server. */
export function formatKampala(iso: string | null | undefined): string {
  if (!iso) return 'Not available';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Not available';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kampala', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  return `${g('day')} ${g('month')} ${g('year')}, ${g('hour')}:${g('minute')}`;
}

export interface TimingCell { label: string; value: string; detail: string | null; quality: TimingQuality }
export interface TimingRow {
  /** The compact three-column row of a review card: current desk, previous visit, total journey. */
  current: TimingCell;
  previous: TimingCell;
  total: TimingCell;
  quality: TimingQuality;
  /** One plain sentence when something is missing or estimated, else null. */
  note: string | null;
}

/** The three cells a card shows, straight from the server's answer. A missing figure reads "Not available" and carries its reason. */
export function timingRow(t: RentTiming | null | undefined): TimingRow {
  if (!t) {
    const none: TimingCell = { label: 'Not available', value: 'Not available', detail: null, quality: 'unavailable' };
    return { current: none, previous: none, total: { ...none, label: 'Total journey' }, quality: 'unavailable', note: 'No timing was returned for this request.' };
  }
  const open = t.state === 'at_desk' || t.state === 'correction';
  const current: TimingCell = open
    ? { label: t.state === 'correction' ? 'With the agent for correction' : `At ${deskLabel(t.desk)}`, value: formatElapsed(t.current?.seconds), detail: t.current ? `Since ${formatKampala(t.current.entry)}` : null, quality: t.current?.quality ?? 'unavailable' }
    : { label: t.state === 'processed' ? 'Review finished' : 'Closed', value: t.state === 'processed' ? 'Funded' : 'Ended', detail: t.processing_end ? formatKampala(t.processing_end) : null, quality: t.quality };
  const previous: TimingCell = t.previous
    ? { label: `Before: ${deskLabel(t.previous.desk)}`, value: formatElapsed(t.previous.seconds), detail: t.previous.start ? `${formatKampala(t.previous.start)} to ${formatKampala(t.previous.end)}` : null, quality: t.previous.quality }
    : { label: 'Before', value: 'None', detail: null, quality: 'confirmed' };
  const total: TimingCell = { label: 'Total journey', value: formatElapsed(t.total_seconds), detail: t.request_start ? `Started ${formatKampala(t.request_start)}` : null, quality: t.total_seconds == null ? 'unavailable' : t.quality };
  const note = missingReasonLabel(t.missing_reason)
    ?? (t.quality === 'estimated' ? 'Some of this history was not recorded exactly, so part of the timing is an estimate.' : null);
  return { current, previous, total, quality: t.quality, note };
}

export function chunkIds(ids: string[], size = TIMING_BATCH_LIMIT): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** Stable, short cache key for a set of ids (order-independent), so a long list does not go into a query key. */
export function timingIdsKey(ids: string[]): string {
  const sorted = [...new Set(ids)].sort();
  let h = 0x811c9dc5;
  for (const id of sorted) {
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    h ^= 0x2c; h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${sorted.length}:${h.toString(16)}`;
}
