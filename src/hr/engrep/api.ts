/**
 * ENGREP data access — reads over engrep views/tables and thin RPC calls.
 *
 * No business rules live here: no banding logic, no arithmetic, no thresholds.
 * RLS and the adjudicator check inside each RPC are the whole control.
 */
import { supabase, unwrap } from '../api/client';
import type {
  EngrepBand,
  EngrepClaimedNotLive,
  EngrepGranularity,
  EngrepIngestInput,
  EngrepLivenessVerdict,
  EngrepRow,
  EngrepUnclaimedObject,
  EngrepWindowSummary,
} from './types';

// The engrep views/RPCs are newer than the generated Supabase types.
const db = supabase as unknown as {
  from: (table: string) => any;
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: any; error: any }>;
};

const SUMMARY_SELECT =
  'window_id, granularity, period_start, period_end, status, harvested_at, locked_at, lovable_edits, external_commits, claiming_schema, live_verified, untagged, fenced_breaches, self_fixes, zeroed, unadjudicated, distinct_author_emails';

/** Latest window summary for a granularity, or null when no window exists yet. */
export async function getLatestWindowSummary(
  granularity: EngrepGranularity,
): Promise<EngrepWindowSummary | null> {
  const rows = unwrap(
    await db
      .from('engrep_window_summary')
      .select(SUMMARY_SELECT)
      .eq('granularity', granularity)
      .order('period_start', { ascending: false })
      .limit(1),
  ) as EngrepWindowSummary[] | null;
  return rows?.[0] ?? null;
}

export async function listWindowSummaries(
  granularity: EngrepGranularity,
  limit = 30,
): Promise<EngrepWindowSummary[]> {
  return (unwrap(
    await db
      .from('engrep_window_summary')
      .select(SUMMARY_SELECT)
      .eq('granularity', granularity)
      .order('period_start', { ascending: false })
      .limit(limit),
  ) ?? []) as EngrepWindowSummary[];
}

export async function listRows(
  windowId: string,
  source?: EngrepSourceFilter,
): Promise<EngrepRow[]> {
  let query = db
    .from('engrep_rows')
    .select('*')
    .eq('window_id', windowId)
    .order('harvested_at', { ascending: true, nullsFirst: false });
  if (source) query = query.eq('source', source);
  return (unwrap(await query) ?? []) as EngrepRow[];
}

type EngrepSourceFilter = 'lovable_edit' | 'external_commit';

export async function listClaimedNotLive(windowId: string): Promise<EngrepClaimedNotLive[]> {
  return (unwrap(
    await db.from('engrep_claimed_not_live').select('*').eq('window_id', windowId),
  ) ?? []) as EngrepClaimedNotLive[];
}

export async function listUnclaimedObjects(windowId: string): Promise<EngrepUnclaimedObject[]> {
  return (unwrap(
    await db
      .from('engrep_unclaimed_objects')
      .select('*')
      .eq('window_id', windowId)
      .order('detected_at', { ascending: false }),
  ) ?? []) as EngrepUnclaimedObject[];
}

function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  return db.rpc(fn, args).then((res) => unwrap(res) as T);
}

export function openWindow(granularity: EngrepGranularity, periodStart: string): Promise<string> {
  return rpc<string>('engrep_open_window', {
    p_granularity: granularity,
    p_period_start: periodStart,
  });
}

export function ingestRow(input: EngrepIngestInput): Promise<string> {
  return rpc<string>('engrep_ingest_row', {
    p_window_id: input.windowId,
    p_source: input.source,
    p_evidence_ref: input.evidenceRef,
    p_commit_subject: input.commitSubject,
    p_change_classes: input.changeClasses ?? [],
    p_engineer_code: input.engineerCode ?? null,
    p_author_email: input.authorEmail ?? null,
    p_claims_schema: input.claimsSchema ?? false,
    p_migration_bearing: input.migrationBearing ?? false,
    p_untagged: input.untagged ?? false,
    p_fenced_breach: input.fencedBreach ?? false,
    p_fence_path: input.fencePath ?? null,
    p_self_fix: input.selfFix ?? false,
    p_self_fix_of: input.selfFixOf ?? null,
    p_claimed_objects: input.claimedObjects ?? [],
  });
}

export function setLiveness(rowId: string, verdict: EngrepLivenessVerdict): Promise<unknown> {
  return rpc('engrep_set_liveness', { p_row_id: rowId, p_verdict: verdict });
}

export function adjudicate(rowId: string, band: EngrepBand, basis: string): Promise<unknown> {
  return rpc('engrep_adjudicate', { p_row_id: rowId, p_band: band, p_basis: basis });
}

export function lockWindow(windowId: string): Promise<unknown> {
  return rpc('engrep_lock_window', { p_window_id: windowId });
}

export function detectUnclaimed(windowId: string): Promise<unknown> {
  return rpc('engrep_detect_unclaimed', { p_window_id: windowId });
}

export function markHarvested(windowId: string): Promise<unknown> {
  return rpc('engrep_mark_harvested', { p_window_id: windowId });
}

/** True when the caller is the Lead Engineer / adjudicator, per the database. */
export function isAdjudicator(): Promise<boolean> {
  return rpc<boolean>('engrep_is_adjudicator');
}
