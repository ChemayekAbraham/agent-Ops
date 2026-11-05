import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { deskChecklistOn } from './deskFlag';

/**
 * Per-desk live switches.
 *
 * Each desk is live unless `pipeline_switches` holds a row
 * `desk_live:<deskId>` with `is_on = false`. A missing row, a missing table or
 * a failed read all mean live: the switch exists to take one desk off, not to
 * keep every desk off until someone remembers to add rows.
 *
 * `VITE_DESK_CHECKLIST=false` (and an unknown host) still turns every desk off,
 * through `deskChecklistOn()`.
 *
 * Desk ids: command, coo, service-centre, agent-ops, tenant-ops, landlord-ops,
 * partner-ops, cfo, customer-care, ontology.
 */

export const LIVE_PREFIX = 'desk_live:';

export type SwitchRow = { key: string; is_on: boolean | null };

/** Pure rule, so it can be tested without a network or a window. */
export function deskLiveFrom(rows: SwitchRow[] | null | undefined, deskId: string, checklistOn: boolean): boolean {
  if (!checklistOn) return false;
  const row = (rows ?? []).find((r) => r.key === `${LIVE_PREFIX}${deskId}`);
  return !(row && row.is_on === false);
}

/** "does not exist" from PostgREST or Postgres: the database part is not applied yet. */
export function isMissingDbObject(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code === '42P01' || e.code === '42883' || e.code === 'PGRST202' || e.code === 'PGRST205') return true;
  return /does not exist|could not find the (function|table)|schema cache/i.test(String(e.message ?? ''));
}

const logged = new Set<string>();
/** One console line per missing object per page load, so a missing piece is visible but not noisy. */
export function logMissingOnce(name: string, error: unknown): void {
  if (logged.has(name)) return;
  logged.add(name);
  console.info(`[desk] ${name} is not available yet; that piece is hidden.`, (error as { message?: string })?.message ?? '');
}

type FromFn = (table: string) => {
  select: (cols: string) => {
    like: (col: string, pattern: string) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>;
  };
};
// pipeline_switches is not in the generated Supabase types yet — same cast pattern as reviewApi.ts.
const from = supabase.from.bind(supabase) as unknown as FromFn;

async function loadSwitches(): Promise<SwitchRow[]> {
  const { data, error } = await from('pipeline_switches').select('key, is_on').like('key', `${LIVE_PREFIX}%`);
  if (error) {
    // A failed read must never take a desk off.
    if (isMissingDbObject(error)) logMissingOnce('pipeline_switches', error);
    else logMissingOnce('pipeline_switches read', error);
    return [];
  }
  return Array.isArray(data) ? (data as SwitchRow[]) : [];
}

/** The switches, cached for a minute. */
export function useDeskSwitches() {
  return useQuery({
    queryKey: ['desk-live-switches'],
    queryFn: loadSwitches,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchInterval: 60_000,
    retry: false,
  });
}

/**
 * `deskLive(deskId)` for the desks. Live while the switches are still loading:
 * the switch only ever takes a desk off, and a flash of the old layout on every
 * page load would be worse than a rare flash of the new one.
 */
export function useDeskLive(): (deskId: string) => boolean {
  const { data } = useDeskSwitches();
  return useCallback((deskId: string) => deskLiveFrom(data, deskId, deskChecklistOn()), [data]);
}
