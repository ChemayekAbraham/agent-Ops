import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, ArrowDownLeft, ArrowUpRight, History, ChevronLeft, ChevronRight } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';

const PAGE_SIZE = 10;

interface CorrectionRow {
  id: string;
  operation: string;
  amount: number;
  evidence: string | null;
  reference_id: string | null;
  created_at: string;
  target_user_id: string;
  metadata: Record<string, unknown> | null;
}

function pageWindow(current: number, total: number): (number | 'gap')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | 'gap')[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) pages.push('gap');
  for (let p = start; p <= end; p++) pages.push(p);
  if (end < total - 1) pages.push('gap');
  pages.push(total);
  return pages;
}

export function RecentPayoutActivity() {
  const [page, setPage] = useState(1);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['cfo-recent-payout-activity', page],
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const from = (page - 1) * PAGE_SIZE;
      const { data: rows, error: rowsErr, count } = await supabase
        .from('platform_wallet_corrections')
        .select('id, operation, amount, evidence, reference_id, created_at, target_user_id, metadata', {
          count: 'exact',
        })
        .eq('tool', 'cfo_direct_credit')
        .order('created_at', { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
      if (rowsErr) throw rowsErr;

      const list = (rows ?? []) as unknown as CorrectionRow[];
      const ids = Array.from(new Set(list.map((r) => r.target_user_id).filter(Boolean)));
      let names: Record<string, { full_name: string | null; phone: string | null }> = {};
      if (ids.length) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', ids);
        names = Object.fromEntries(
          (profiles ?? []).map((p: any) => [p.id, { full_name: p.full_name, phone: p.phone }]),
        );
      }
      return {
        rows: list.map((r) => ({ ...r, recipient: names[r.target_user_id] ?? null })),
        total: count ?? 0,
      };
    },
  });

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, total);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          Recent Payout Activity
          {isFetching && !isLoading && (
            <span className="text-xs font-normal text-muted-foreground">Updating…</span>
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Every wallet movement made from this page, with who received it and why.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <p className="px-5 pb-5 text-sm text-destructive">Could not load recent activity.</p>
        ) : !data || data.rows.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-muted-foreground">No payouts recorded yet.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Recipient</th>
                    <th className="px-4 py-2.5 font-medium text-right">Amount</th>
                    <th className="px-4 py-2.5 font-medium">Type</th>
                    <th className="px-4 py-2.5 font-medium">Destination</th>
                    <th className="px-4 py-2.5 font-medium">Category</th>
                    <th className="px-4 py-2.5 font-medium">Reference</th>
                    <th className="px-4 py-2.5 font-medium whitespace-nowrap">Date &amp; time</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => {
                    const isDebit = row.operation === 'debit';
                    const meta = (row.metadata ?? {}) as Record<string, any>;
                    const destination =
                      meta.recipient_type === 'operational_wallet' ? 'Operational float' : 'User wallet';
                    return (
                      <tr key={row.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-2.5">
                          <div className="font-medium">{row.recipient?.full_name || 'Unknown'}</div>
                          <div className="text-xs text-muted-foreground">{row.recipient?.phone || '—'}</div>
                        </td>
                        <td
                          className={`px-4 py-2.5 text-right font-semibold ${
                            isDebit ? 'text-destructive' : 'text-emerald-600'
                          }`}
                        >
                          {isDebit ? '−' : '+'}
                          {formatUGX(Number(row.amount))}
                        </td>
                        <td className="px-4 py-2.5">
                          <Badge variant={isDebit ? 'destructive' : 'secondary'} className="gap-1 text-xs">
                            {isDebit ? (
                              <ArrowUpRight className="h-3 w-3" />
                            ) : (
                              <ArrowDownLeft className="h-3 w-3" />
                            )}
                            {isDebit ? 'Taken out' : 'Sent'}
                          </Badge>
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">{destination}</td>
                        <td className="px-4 py-2.5 max-w-[260px] truncate text-muted-foreground">
                          {meta.category_label || row.evidence || '—'}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                          {row.reference_id || '—'}
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">
                          {format(new Date(row.created_at), 'dd MMM yyyy, HH:mm')}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-muted-foreground">
                Showing {rangeStart}–{rangeEnd} of {total} records
              </p>
              <div className="flex flex-wrap items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 px-2"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="h-4 w-4" />
                  <span className="hidden sm:inline">Previous</span>
                </Button>
                {pageWindow(page, totalPages).map((p, i) =>
                  p === 'gap' ? (
                    <span key={`gap-${i}`} className="px-1 text-xs text-muted-foreground">
                      …
                    </span>
                  ) : (
                    <Button
                      key={p}
                      variant={p === page ? 'default' : 'outline'}
                      size="sm"
                      className="h-8 w-8 p-0 text-xs"
                      onClick={() => setPage(p)}
                    >
                      {p}
                    </Button>
                  ),
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 px-2"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  <span className="hidden sm:inline">Next</span>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
