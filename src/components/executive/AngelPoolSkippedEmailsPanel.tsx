import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '@/components/ui/table';
import { MailX, RefreshCw } from 'lucide-react';
import { format } from 'date-fns';

interface SkipRow {
  id: string;
  investor_id: string | null;
  reference_id: string | null;
  recipient_email: string | null;
  reason: string;
  funding_source: string | null;
  source_function: string | null;
  created_at: string;
}

const REASONS: { key: string; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'placeholder_email', label: 'Placeholder address' },
  { key: 'no_email_on_file', label: 'No email on file' },
  { key: 'not_first_purchase', label: 'Repeat purchase' },
];

const reasonLabel = (r: string) =>
  REASONS.find(x => x.key === r)?.label ?? r.replace(/_/g, ' ');

const reasonVariant = (r: string): 'destructive' | 'secondary' | 'outline' =>
  r === 'placeholder_email' ? 'destructive' : r === 'no_email_on_file' ? 'secondary' : 'outline';

export function AngelPoolSkippedEmailsPanel() {
  const [filter, setFilter] = useState<string>('placeholder_email');
  const PAGE_SIZE = 20;
  const [page, setPage] = useState(0);

  const { data: rows = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['angel-pool-email-skips'],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('angel_pool_email_skips')
        .select('id, investor_id, reference_id, recipient_email, reason, funding_source, source_function, created_at')
        .order('created_at', { ascending: false })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as SkipRow[];
    },
  });

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length };
    for (const r of rows) c[r.reason] = (c[r.reason] ?? 0) + 1;
    return c;
  }, [rows]);

  const filtered = useMemo(
    () => (filter === 'all' ? rows : rows.filter(r => r.reason === filter)),
    [rows, filter],
  );

  const paginated = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <MailX className="h-4 w-4" /> Skipped Onboarding Emails
        </CardTitle>
        <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {REASONS.map(r => (
            <Button
              key={r.key}
              size="sm"
              variant={filter === r.key ? 'default' : 'outline'}
              onClick={() => { setFilter(r.key); setPage(0); }}
            >
              {r.label}
              <Badge variant="secondary" className="ml-2">{counts[r.key] ?? 0}</Badge>
            </Button>
          ))}
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No skipped emails recorded for this filter.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Recipient</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead className="text-right">When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginated.map(r => (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs break-all">
                        {r.recipient_email || <span className="text-muted-foreground italic">— none —</span>}
                      </TableCell>
                      <TableCell>
                        <Badge variant={reasonVariant(r.reason)}>{reasonLabel(r.reason)}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{r.reference_id || '—'}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.source_function === 'agent-angel-pool-invest' ? 'Agent' : 'Direct'}
                        {r.funding_source ? ` · ${r.funding_source}` : ''}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground whitespace-nowrap">
                        {format(new Date(r.created_at), 'dd MMM yyyy HH:mm')}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  Page {page + 1} of {totalPages} · {filtered.length} record(s)
                </span>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</Button>
                  <Button size="sm" variant="outline" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Next</Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
