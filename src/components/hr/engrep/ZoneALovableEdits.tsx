/**
 * ENGREP P09 — Zone A · LOVABLE EDITS.
 *
 * Presentation only. Nothing here derives from diff size, lines changed, edit count per
 * row or commit count: the only numbers displayed are counts of rows matching a flag.
 * Change classes are rendered as a set, never as a number.
 */
import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/integrations/supabase/client';
import type { EngrepRow } from '@/hr/engrep/types';
import { AdjudicationCells } from '@/components/hr/engrep/AdjudicationRow';

const ROW_SELECT =
  'id, window_id, engineer_code, commit_subject, change_classes, claims_schema, live_verified, untagged, fenced_breach, self_fix, zeroed, zero_reason, harvested_at, band, basis';

// The engrep tables are newer than the generated Supabase types.
const db = supabase as unknown as { from: (table: string) => any };

type ZoneARow = Pick<
  EngrepRow,
  | 'id'
  | 'window_id'
  | 'band'
  | 'basis'
  | 'engineer_code'
  | 'commit_subject'
  | 'change_classes'
  | 'claims_schema'
  | 'live_verified'
  | 'untagged'
  | 'fenced_breach'
  | 'self_fix'
  | 'zeroed'
  | 'zero_reason'
  | 'harvested_at'
>;

async function fetchZoneARows(windowId: string): Promise<ZoneARow[]> {
  const { data, error } = await db
    .from('engrep_rows')
    .select(ROW_SELECT)
    .eq('window_id', windowId)
    .eq('source', 'lovable_edit')
    // Ordering is explicit: harvested_at ascending. Never rely on a default order.
    .order('harvested_at', { ascending: true, nullsFirst: true });
  if (error) throw error;
  return (data ?? []) as ZoneARow[];
}

function isUntagged(row: ZoneARow): boolean {
  return row.untagged || !row.engineer_code;
}

function engineerBreakdown(rows: ZoneARow[]): string {
  const tagged = new Map<string, number>();
  let untagged = 0;
  for (const row of rows) {
    if (isUntagged(row)) untagged += 1;
    else {
      const code = row.engineer_code as string;
      tagged.set(code, (tagged.get(code) ?? 0) + 1);
    }
  }
  const parts = [...tagged.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([code, count]) => `${code} ${count}`);
  if (untagged > 0) parts.push(`untagged ${untagged}`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function Tile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function LiveCell({ value }: { value: EngrepRow['live_verified'] }) {
  if (value === 'yes') return <span className="font-medium text-emerald-600">Yes</span>;
  if (value === 'no') return <span className="font-medium text-destructive">No</span>;
  return <span>n/a</span>;
}

export function ZoneALovableEdits({ windowId }: { windowId: string | null }) {
  const rowsQuery = useQuery({
    queryKey: ['engrep', 'zone-a', windowId],
    queryFn: () => fetchZoneARows(windowId as string),
    enabled: Boolean(windowId),
  });

  if (!windowId) {
    return <p className="text-xs text-muted-foreground">No window opened yet.</p>;
  }

  if (rowsQuery.isLoading) {
    return (
      <div className="space-y-2">
        <div className="grid gap-3 sm:grid-cols-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (rowsQuery.isError) {
    return (
      <p className="text-xs text-destructive">
        Could not load Lovable edits for this window.
      </p>
    );
  }

  const rows = rowsQuery.data ?? [];
  const editsInWindow = rows.length;
  const untaggedCount = rows.filter(isUntagged).length;
  const claimingSchema = rows.filter((r) => r.claims_schema).length;
  const liveVerified = rows.filter((r) => r.claims_schema && r.live_verified === 'yes').length;
  const notLive = claimingSchema - liveVerified;
  const fencedBreaches = rows.filter((r) => r.fenced_breach).length;
  const selfFixes = rows.filter((r) => r.self_fix).length;
  const flagsRaised = fencedBreaches + selfFixes;
  const liveFraction = `${liveVerified} of ${claimingSchema}`;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Tile
          label="A1 · Edits in window"
          value={String(editsInWindow)}
          detail={engineerBreakdown(rows)}
        />
        <Tile
          label="A2 · Live verified"
          value={liveFraction}
          detail={`${claimingSchema} claimed schema effect · ${notLive} not live`}
        />
        <Tile
          label="A3 · Flags raised"
          value={String(flagsRaised)}
          detail={`${fencedBreaches} fenced breach · ${selfFixes} self-fix`}
        />
      </div>

      <div className="hidden overflow-x-auto rounded-lg border sm:block">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">Eng</th>
              <th className="px-3 py-2 font-medium">Commit message</th>
              <th className="px-3 py-2 font-medium">Classes</th>
              <th className="px-3 py-2 font-medium">Live</th>
              <th className="px-3 py-2 font-medium">Band *</th>
              <th className="px-3 py-2 font-medium">Written basis *</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-xs text-muted-foreground">
                  No Lovable edits recorded in this window.
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const untagged = isUntagged(row);
              return (
                <tr
                  key={row.id}
                  className={`border-t align-top ${row.zeroed ? 'bg-muted/40 text-muted-foreground' : ''}`}
                >
                  <td className="whitespace-nowrap px-3 py-2">
                    {untagged ? (
                      <span className="font-semibold text-destructive" title="Untagged">
                        —
                      </span>
                    ) : (
                      <span className="font-medium">{row.engineer_code}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span>{row.commit_subject ?? '—'}</span>
                    {untagged && (
                      <span className="ml-2 text-xs font-medium text-destructive">scores zero</span>
                    )}
                    {row.zeroed && row.zero_reason && (
                      <span className="ml-2 text-xs italic">{row.zero_reason}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 uppercase">
                    {(row.change_classes ?? []).length > 0
                      ? (row.change_classes ?? []).join('·')
                      : '—'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <LiveCell value={row.live_verified} />
                  </td>
                  <AdjudicationCells row={row} windowId={windowId} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Below 640px the same rows render as cards; the adjudication controls are the
          same AdjudicationCells component, so the mutation logic is not forked. */}
      <div className="space-y-3 sm:hidden">
        {rows.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No Lovable edits recorded in this window.
          </p>
        )}
        {rows.map((row) => {
          const untagged = isUntagged(row);
          const flags = [
            row.fenced_breach ? 'fenced breach' : null,
            row.self_fix ? 'self-fix' : null,
          ].filter(Boolean) as string[];
          return (
            <div
              key={row.id}
              className={`rounded-lg border p-3 text-sm ${row.zeroed ? 'bg-muted/40 text-muted-foreground' : ''}`}
            >
              <div className="flex items-center justify-between gap-2">
                {untagged ? (
                  <span className="font-semibold text-destructive" title="Untagged">
                    —
                  </span>
                ) : (
                  <span className="font-medium">{row.engineer_code}</span>
                )}
                <LiveCell value={row.live_verified} />
              </div>
              <p className="mt-1">
                {row.commit_subject ?? '—'}
                {untagged && (
                  <span className="ml-2 text-xs font-medium text-destructive">scores zero</span>
                )}
                {row.zeroed && row.zero_reason && (
                  <span className="ml-2 text-xs italic">{row.zero_reason}</span>
                )}
              </p>
              <p className="mt-1 text-xs uppercase text-muted-foreground">
                {(row.change_classes ?? []).length > 0
                  ? (row.change_classes ?? []).join('·')
                  : '—'}
              </p>
              {flags.length > 0 && (
                <p className="mt-1 text-xs font-medium">
                  {row.fenced_breach && (
                    <span className="text-destructive">fenced breach</span>
                  )}
                  {row.fenced_breach && row.self_fix && <span> · </span>}
                  {row.self_fix && (
                    <span className="text-muted-foreground">self-fix</span>
                  )}
                </p>
              )}
              <table className="mt-2 w-full text-sm">
                <tbody>
                  <tr className="align-top">
                    <AdjudicationCells row={row} windowId={windowId} />
                  </tr>
                </tbody>
              </table>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {editsInWindow} edits · {untaggedCount} untagged, scores zero
        </span>
        <span>{liveFraction}</span>
      </div>
    </div>
  );
}

export default ZoneALovableEdits;
