/**
 * ENGREP P13 — engineer self-view of own harvested rows.
 *
 * Reads engrep_my_rows only. RLS restricts that view to the signed-in engineer's own
 * rows, so no client-side filter on staff or engineer is applied. This page is
 * read-only in full: it issues no insert, update, delete or RPC of any kind. No
 * comparison, average, rank, cross-engineer total or percentage appears anywhere, and
 * no point or payout figure is displayed or computed.
 */
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, Info } from 'lucide-react';
import PersonalLayout from '@/components/layout/PersonalLayout';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/integrations/supabase/client';

// The engrep views are newer than the generated Supabase types.
const db = supabase as unknown as { from: (table: string) => any };

const ROW_SELECT =
  'id, granularity, period_start, period_end, status, source, evidence_ref, commit_subject, change_classes, claims_schema, live_verified, zeroed, zero_reason, band, basis, adjudicated_at';

interface MyRow {
  id: string;
  granularity: string;
  period_start: string;
  period_end: string;
  status: string;
  source: string;
  evidence_ref: string | null;
  commit_subject: string | null;
  change_classes: string[] | null;
  claims_schema: boolean;
  live_verified: string | null;
  zeroed: boolean;
  zero_reason: string | null;
  band: string | null;
  basis: string | null;
  adjudicated_at: string | null;
}

const SOURCE_LABEL: Record<string, string> = {
  lovable_edit: 'Lovable edit',
  external_commit: 'External commit',
};

async function fetchMyRows(): Promise<MyRow[]> {
  const { data, error } = await db
    .from('engrep_my_rows')
    .select(ROW_SELECT)
    // Ordering is explicit. Never rely on a default order.
    .order('period_start', { ascending: false });
  if (error) throw error;
  return (data ?? []) as MyRow[];
}

function LiveCell({ value }: { value: string | null }) {
  if (value === 'yes') return <span className="font-medium text-success">Yes</span>;
  if (value === 'no') return <span className="font-medium text-destructive">No</span>;
  return <span className="text-muted-foreground">n/a</span>;
}

export default function MyContribution() {
  const rowsQuery = useQuery({ queryKey: ['engrep', 'my-rows'], queryFn: fetchMyRows });
  const rows = rowsQuery.data ?? [];

  return (
    <PersonalLayout title="My contribution record">
      <p className="-mt-2 text-sm text-muted-foreground">
        Your own harvested rows, exactly as recorded.
      </p>

      <Card className="overflow-hidden border-border/70 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2.5 space-y-0 border-b border-border/60 bg-muted/30 px-4 py-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Info className="h-4 w-4" />
          </span>
          <CardTitle className="text-sm font-semibold tracking-tight">
            How this record works

          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            What is captured is your tagged Lovable edit, your external commit, and whether a
            schema change you claimed actually reached the database.
          </p>
          <p>
            The difficulty band and its written basis are set by a person. They are never
            inferred, and nothing on this page is derived from diff size, edit count, commit
            count or lines changed.
          </p>
          <p>Four conditions score zero automatically:</p>
          <ul className="list-disc space-y-0.5 pl-5">
            <li>an untagged edit;</li>
            <li>a change landing inside a colleague&apos;s fenced path;</li>
            <li>a self-fix;</li>
            <li>a change claimed but absent from the catalog.</li>
          </ul>
          <p>Points and payout are computed outside this system.</p>
        </CardContent>
      </Card>

      <Card className="overflow-hidden border-border/70 shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 border-b border-border/60 bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <ClipboardList className="h-4 w-4" />
            </span>
            <div>
              <CardTitle className="text-sm font-semibold tracking-tight">Your rows</CardTitle>
              <p className="text-[11px] text-muted-foreground">Newest period first</p>
            </div>
          </div>
          {!rowsQuery.isLoading && !rowsQuery.isError && rows.length > 0 && (
            <Badge
              variant="outline"
              className="rounded-full border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[11px] font-semibold text-primary"
            >
              {rows.length}
            </Badge>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {rowsQuery.isLoading ? (
            <div className="space-y-2.5 p-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-10 w-full rounded-lg" />
              ))}
            </div>
          ) : rowsQuery.isError ? (
            <p role="alert" className="bg-destructive/5 px-4 py-3 text-sm font-medium text-destructive">
              Could not load your contribution rows.
            </p>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <ClipboardList className="h-5 w-5" />
              </span>
              <p className="text-sm font-medium">No rows recorded for you yet</p>
              <p className="max-w-xs text-xs text-muted-foreground">
                Tagged edits and commits appear here once they are harvested.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr className="border-b border-border/60 text-left [&>th]:px-3 [&>th]:py-2.5 [&>th]:text-[11px] [&>th]:font-semibold [&>th]:uppercase [&>th]:tracking-wider [&>th]:text-muted-foreground">
                    <th>Period</th>
                    <th>Source</th>
                    <th>Evidence</th>
                    <th>Subject</th>
                    <th>Classes</th>
                    <th>Live</th>
                    <th>Band</th>
                    <th>Written basis</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      className={`border-t border-border/50 align-top transition-colors hover:bg-primary/[0.04] ${
                        row.zeroed ? 'bg-muted/40 text-muted-foreground' : ''
                      }`}
                    >
                      <td className="whitespace-nowrap px-3 py-3 text-xs tabular-nums">
                        {row.period_start} → {row.period_end}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-xs">
                        {SOURCE_LABEL[row.source] ?? row.source}
                      </td>
                      <td className="break-all px-3 py-3 text-xs text-muted-foreground">
                        {row.evidence_ref ?? '—'}
                      </td>
                      <td className="px-3 py-3 text-sm">
                        <span>{row.commit_subject ?? '—'}</span>
                        {row.zeroed && row.zero_reason && (
                          <span className="ml-2 text-xs italic">{row.zero_reason}</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-xs uppercase">
                        {(row.change_classes ?? []).length > 0
                          ? (row.change_classes ?? []).join('·')
                          : '—'}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-xs">
                        <LiveCell value={row.live_verified} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-3">
                        {row.band ? (
                          <span className="text-xs font-semibold">{row.band.toUpperCase()}</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">Not yet adjudicated</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-xs text-muted-foreground">{row.basis ?? '—'}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-xs">
                        {row.status === 'locked' ? 'Locked' : 'Open'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </PersonalLayout>
  );
}

