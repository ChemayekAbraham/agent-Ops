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
  if (value === 'yes') return <span className="font-medium text-emerald-600">Yes</span>;
  if (value === 'no') return <span className="font-medium text-destructive">No</span>;
  return <span>n/a</span>;
}

export default function MyContribution() {
  const rowsQuery = useQuery({ queryKey: ['engrep', 'my-rows'], queryFn: fetchMyRows });
  const rows = rowsQuery.data ?? [];

  return (
    <div className="container mx-auto max-w-6xl space-y-6 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">My Contribution Record</h1>
        <p className="text-sm text-muted-foreground">
          Your own harvested rows, exactly as recorded.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold uppercase tracking-wide">
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

      {rowsQuery.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : rowsQuery.isError ? (
        <p className="text-sm text-destructive">Could not load your contribution rows.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium">Period</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Evidence</th>
                <th className="px-3 py-2 font-medium">Subject</th>
                <th className="px-3 py-2 font-medium">Classes</th>
                <th className="px-3 py-2 font-medium">Live</th>
                <th className="px-3 py-2 font-medium">Band</th>
                <th className="px-3 py-2 font-medium">Written basis</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-4 text-center text-xs text-muted-foreground">
                    No rows recorded for you yet.
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className={`border-t align-top ${row.zeroed ? 'bg-muted/40 text-muted-foreground' : ''}`}
                >
                  <td className="whitespace-nowrap px-3 py-2">
                    {row.period_start} → {row.period_end}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {SOURCE_LABEL[row.source] ?? row.source}
                  </td>
                  <td className="px-3 py-2 text-xs break-all">{row.evidence_ref ?? '—'}</td>
                  <td className="px-3 py-2">
                    <span>{row.commit_subject ?? '—'}</span>
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
                  <td className="whitespace-nowrap px-3 py-2">
                    {row.band ? (
                      <span className="font-medium">{row.band.toUpperCase()}</span>
                    ) : (
                      <span className="text-xs">Not yet adjudicated</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">{row.basis ?? '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {row.status === 'locked' ? 'Locked' : 'Open'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
