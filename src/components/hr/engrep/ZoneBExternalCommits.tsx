/**
 * ENGREP P10 — Zone B · EXTERNAL COMMITS.
 *
 * Presentation only. Nothing here derives from diff size, lines changed or a per-author
 * commit total beyond the B1 count. No score, point or percentage is computed.
 */
import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/integrations/supabase/client';
import type { EngrepRow } from '@/hr/engrep/types';
import { AdjudicationCells } from '@/components/hr/engrep/AdjudicationRow';

const SUB_LINE = 'harvested from git at 17:00, Lovable bot author excluded';

const BLIND_WARNING =
  'git config user.email is wrong on a machine and this zone is blind.';

const ROW_SELECT =
  'id, window_id, engineer_code, author_email, commit_subject, migration_bearing, live_verified, zeroed, zero_reason, harvested_at, band, basis';

// The engrep tables are newer than the generated Supabase types.
const db = supabase as unknown as { from: (table: string) => any };

type ZoneBRow = Pick<
  EngrepRow,
  | 'id'
  | 'window_id'
  | 'band'
  | 'basis'
  | 'engineer_code'
  | 'author_email'
  | 'commit_subject'
  | 'migration_bearing'
  | 'live_verified'
  | 'zeroed'
  | 'zero_reason'
  | 'harvested_at'
>;

async function fetchZoneBRows(windowId: string): Promise<ZoneBRow[]> {
  const { data, error } = await db
    .from('engrep_rows')
    .select(ROW_SELECT)
    .eq('window_id', windowId)
    .eq('source', 'external_commit')
    // Ordering is explicit: harvested_at ascending. Never rely on a default order.
    .order('harvested_at', { ascending: true, nullsFirst: true });
  if (error) throw error;
  return (data ?? []) as ZoneBRow[];
}

function LiveCell({ value }: { value: EngrepRow['live_verified'] }) {
  if (value === 'yes') return <span className="font-medium text-emerald-600">Yes</span>;
  if (value === 'no') return <span className="font-medium text-destructive">No</span>;
  return <span>n/a</span>;
}

function buildBreakdown(rows: ZoneBRow[]): string {
  const byEngineer = new Map<string, number>();
  let untagged = 0;
  for (const row of rows) {
    if (row.engineer_code) {
      byEngineer.set(row.engineer_code, (byEngineer.get(row.engineer_code) ?? 0) + 1);
    } else {
      untagged += 1;
    }
  }
  const parts = [...byEngineer.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([code, count]) => `${code} ${count}`);
  if (untagged > 0) parts.push(`untagged ${untagged}`);

  const migrationBearing = rows.filter((r) => r.migration_bearing);
  if (migrationBearing.length > 0) {
    parts.push(`${migrationBearing.length} touch supabase/migrations/*`);
    const live = migrationBearing.filter((r) => r.live_verified === 'yes').length;
    if (live === 0) {
      parts.push(migrationBearing.length === 1 ? 'it is not live' : 'neither is live');
    } else if (live === migrationBearing.length) {
      parts.push(migrationBearing.length === 1 ? 'it is live' : 'all are live');
    } else {
      parts.push(`${live} of ${migrationBearing.length} live`);
    }
  }

  return parts.length > 0 ? parts.join(' · ') : '—';
}

export function ZoneBExternalCommits({
  windowId,
  distinctAuthorEmails,
}: {
  windowId: string | null;
  distinctAuthorEmails: number | null;
}) {
  const rowsQuery = useQuery({
    queryKey: ['engrep', 'zone-b', windowId],
    queryFn: () => fetchZoneBRows(windowId as string),
    enabled: Boolean(windowId),
  });

  const subLine = <p className="text-xs text-muted-foreground">{SUB_LINE}</p>;

  if (!windowId) {
    return (
      <div className="space-y-2">
        {subLine}
        <p className="text-xs text-muted-foreground">No window opened yet.</p>
      </div>
    );
  }

  if (rowsQuery.isLoading) {
    return (
      <div className="space-y-3">
        {subLine}
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (rowsQuery.isError) {
    return (
      <div className="space-y-2">
        {subLine}
        <p className="text-xs text-destructive">
          Could not load external commits for this window.
        </p>
      </div>
    );
  }

  const rows = rowsQuery.data ?? [];
  const humanCommits = rows.length;
  const authorsSeen = distinctAuthorEmails ?? 0;
  const blind = authorsSeen === 1;
  const migrationBearing = rows.filter((r) => r.migration_bearing);
  const migrationLive = migrationBearing.filter((r) => r.live_verified === 'yes').length;
  const liveFraction = `${migrationLive} of ${migrationBearing.length}`;

  return (
    <div className="space-y-4">
      {subLine}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border bg-muted/30 p-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            B1 · Human commits
          </p>
          <p className="mt-1 text-xl font-semibold tabular-nums">{humanCommits}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{buildBreakdown(rows)}</p>
        </div>
        <div
          className={
            blind
              ? 'rounded-lg border border-destructive bg-destructive/10 p-3 text-destructive'
              : 'rounded-lg border bg-muted/30 p-3'
          }
        >
          <p
            className={`text-sm font-semibold ${blind ? '' : 'text-foreground'}`}
          >
            Distinct author emails seen: {authorsSeen}
          </p>
          {blind && <p className="mt-1 text-xs font-medium">{BLIND_WARNING}</p>}
        </div>
      </div>

      <div className="hidden overflow-x-auto rounded-lg border sm:block">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">Auth</th>
              <th className="px-3 py-2 font-medium">Subject</th>
              <th className="px-3 py-2 font-medium">Migration</th>
              <th className="px-3 py-2 font-medium">Live</th>
              <th className="px-3 py-2 font-medium">Band *</th>
              <th className="px-3 py-2 font-medium">Written basis *</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-xs text-muted-foreground">
                  No external commits recorded in this window.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr
                key={row.id}
                className={`border-t align-top ${row.zeroed ? 'bg-muted/40 text-muted-foreground' : ''}`}
              >
                <td className="whitespace-nowrap px-3 py-2">
                  {row.engineer_code ? (
                    <span className="font-medium">{row.engineer_code}</span>
                  ) : (
                    <span className="text-xs">{row.author_email ?? '—'}</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <span>{row.commit_subject ?? '—'}</span>
                  {row.zeroed && row.zero_reason && (
                    <span className="ml-2 text-xs italic">{row.zero_reason}</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {row.migration_bearing ? 'yes' : 'no'}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  <LiveCell value={row.live_verified} />
                </td>
                <AdjudicationCells row={row} windowId={windowId} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Below 640px the same rows render as cards; the adjudication controls are the
          same AdjudicationCells component, so the mutation logic is not forked. */}
      <div className="space-y-3 sm:hidden">
        {rows.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No external commits recorded in this window.
          </p>
        )}
        {rows.map((row) => (
          <div
            key={row.id}
            className={`rounded-lg border p-3 text-sm ${row.zeroed ? 'bg-muted/40 text-muted-foreground' : ''}`}
          >
            <div className="flex items-center justify-between gap-2">
              {row.engineer_code ? (
                <span className="font-medium">{row.engineer_code}</span>
              ) : (
                <span className="text-xs">{row.author_email ?? '—'}</span>
              )}
              <LiveCell value={row.live_verified} />
            </div>
            <p className="mt-1">
              {row.commit_subject ?? '—'}
              {row.zeroed && row.zero_reason && (
                <span className="ml-2 text-xs italic">{row.zero_reason}</span>
              )}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              migration: {row.migration_bearing ? 'yes' : 'no'}
            </p>
            <table className="mt-2 w-full text-sm">
              <tbody>
                <tr className="align-top">
                  <AdjudicationCells row={row} windowId={windowId} />
                </tr>
              </tbody>
            </table>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {humanCommits} commits · {authorsSeen} authors seen
        </span>
        <span>{liveFraction}</span>
      </div>
    </div>
  );
}

export default ZoneBExternalCommits;
