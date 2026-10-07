import type { AwarenessSubject } from '@/lib/awarenessCallLabels';
import { kampalaTodayYmd } from '@/lib/kampalaDays';

/**
 * Read-only helpers for the "has this Rent Plan been called?" badge on the pipeline lists and for the
 * "Your awareness calls" card. Nothing here changes a Rent Plan or blocks an approval; it only describes what has been recorded.
 */

/** One row of awareness_call_status_for_requests. */
export interface AwarenessCallStatus {
  rent_request_id: string;
  calls_total: number;
  calls_at_current_stage: number;
  answered_at_current_stage: number;
  last_call_at: string | null;
  answered_person_types: AwarenessSubject[];
}

/** The report takes at most this many Rent Plans per call. */
export const STATUS_BATCH_LIMIT = 200;

/** Distinct, non-empty ids in a stable order, so the same list always has the same cache key. */
export function uniqueSortedIds(ids: (string | null | undefined)[]): string[] {
  return Array.from(new Set(ids.filter((i): i is string => Boolean(i)))).sort();
}

export function chunkIds(ids: string[], size: number = STATUS_BATCH_LIMIT): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** A short, stable fingerprint of an id list for a cache key (the ids themselves would make the key very long). */
export function idsFingerprint(ids: string[]): string {
  let h = 5381;
  for (const id of ids) for (let i = 0; i < id.length; i++) h = ((h * 33) ^ id.charCodeAt(i)) >>> 0;
  return `${ids.length}:${h.toString(36)}`;
}

/** True when nothing has been recorded at the stage the Rent Plan is at now. */
export const hasNoCallAtStage = (s: AwarenessCallStatus | null | undefined): boolean => Boolean(s) && s!.calls_at_current_stage === 0;

export interface AwarenessBadgeText {
  tone: 'none' | 'called';
  label: string;
  title: string;
}

/** The words on the badge: "No call yet at this stage" or "Called N times". */
export function awarenessBadgeText(s: AwarenessCallStatus | null | undefined): AwarenessBadgeText | null {
  if (!s) return null;
  const types = (s.answered_person_types ?? []).join(', ');
  if (s.calls_at_current_stage === 0) {
    const earlier = s.calls_total > 0 ? ` · ${s.calls_total} at earlier stages` : '';
    return {
      tone: 'none',
      label: 'No call yet at this stage',
      title: `No awareness call has been recorded at this stage${earlier ? ` (${s.calls_total} recorded at earlier stages)` : ''}.`,
    };
  }
  const n = s.calls_at_current_stage;
  return {
    tone: 'called',
    label: `Called ${n} ${n === 1 ? 'time' : 'times'}`,
    title: `${n} awareness ${n === 1 ? 'call' : 'calls'} at this stage, ${s.answered_at_current_stage} answered${types ? `. Answered by: ${types}` : ''}.`,
  };
}

/**
 * "This week" for the caller's own calls: Monday to today on Kampala days, as plain YYYY-MM-DD (the reports read them as Kampala days).
 * `today` is injectable for tests.
 */
export function awarenessWeekRange(today: string = kampalaTodayYmd()): { from: string; to: string } {
  const [y, m, d] = today.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // 0 = Sunday
  const back = (dow + 6) % 7; // Monday = 0
  const monday = new Date(Date.UTC(y, m - 1, d - back, 12));
  return { from: monday.toISOString().slice(0, 10), to: today };
}
