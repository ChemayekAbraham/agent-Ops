import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Route, RefreshCw, CheckCircle2, XCircle, AlertTriangle, Clock } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

interface Check {
  source_label: string;
  url: string;
  path: string;
  expected: string;
  status?: number;
  location?: string | null;
  final_url?: string;
  final_host?: string;
  error?: string;
  verdict: 'pass' | 'redirect_wrong_path' | 'redirect_wrong_target' | 'no_redirect' | 'unreachable';
}

interface AuditResult {
  ok: boolean;
  checked_at: string;
  summary: { total: number; passing: number; failing: number; legacy_ok: boolean };
  checks: Check[];
}

const VERDICT_LABEL: Record<Check['verdict'], string> = {
  pass: 'Redirects correctly',
  redirect_wrong_path: 'Redirects to wrong path',
  redirect_wrong_target: 'Redirects to wrong domain',
  no_redirect: 'No redirect',
  unreachable: 'Unreachable',
};

function VerdictBadge({ v }: { v: Check['verdict'] }) {
  if (v === 'pass') return <Badge className="gap-1 bg-success text-success-foreground"><CheckCircle2 className="w-3 h-3" />{VERDICT_LABEL[v]}</Badge>;
  if (v === 'unreachable') return <Badge className="gap-1 bg-warning text-warning-foreground"><AlertTriangle className="w-3 h-3" />{VERDICT_LABEL[v]}</Badge>;
  return <Badge variant="destructive" className="gap-1"><XCircle className="w-3 h-3" />{VERDICT_LABEL[v]}</Badge>;
}

export function SeoRedirectAuditPanel() {
  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['seo-redirect-audit'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('seo-redirect-audit', { body: {} });
      if (error) throw error;
      return data as AuditResult;
    },
    staleTime: 5 * 60_000,
  });

  const run = async () => {
    try {
      await refetch();
      toast.success('Redirect audit refreshed.');
    } catch (e: any) {
      toast.error(`Audit failed: ${e.message ?? e}`);
    }
  };

  const s = data?.summary;

  return (
    <Card className="border-2">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <div className="flex items-center gap-2">
          <Route className="w-5 h-5 text-primary" />
          <CardTitle className="text-base sm:text-lg">Domain Redirect Audit → welileapp.com</CardTitle>
        </div>
        <Button size="sm" variant="outline" onClick={run} disabled={isFetching}>
          <RefreshCw className={`w-4 h-4 mr-1.5 ${isFetching ? 'animate-spin' : ''}`} />
          Run audit
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        {s && (
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg border bg-card p-2.5">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Passing</p>
              <p className="text-sm font-semibold text-success mt-0.5">{s.passing} / {s.total}</p>
            </div>
            <div className="rounded-lg border bg-card p-2.5">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Failing</p>
              <p className={`text-sm font-semibold mt-0.5 ${s.failing > 0 ? 'text-destructive' : 'text-success'}`}>{s.failing}</p>
            </div>
            <div className="rounded-lg border bg-card p-2.5">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Legacy redirect</p>
              <p className={`text-sm font-semibold mt-0.5 ${s.legacy_ok ? 'text-success' : 'text-destructive'}`}>{s.legacy_ok ? 'OK' : 'Broken'}</p>
            </div>
          </div>
        )}

        {!s?.legacy_ok && data && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
            <span>
              <strong>welilereceipts.com is not redirecting to welileapp.com.</strong>{/* legacy-domain-guard-allow */} It must issue a 301 at the
              DNS/host level (repoint to Lovable and add it as a custom domain, or add an <code>.htaccess</code> 301
              on the current host). Until then Google keeps ranking signals on the legacy domain.
            </span>
          </div>
        )}

        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : error ? (
          <p className="text-sm text-destructive">Could not run audit. Try again.</p>
        ) : data ? (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Source</TableHead>
                    <TableHead className="text-xs">Path</TableHead>
                    <TableHead className="text-xs">Result</TableHead>
                    <TableHead className="text-xs">Lands on</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.checks.map((c, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-xs whitespace-nowrap">{c.source_label}</TableCell>
                      <TableCell className="text-xs font-mono whitespace-nowrap">{c.path}</TableCell>
                      <TableCell><VerdictBadge v={c.verdict} /></TableCell>
                      <TableCell className="text-xs">
                        {c.final_host ? (
                          <span className={c.final_host === 'welileapp.com' ? 'text-success' : 'text-destructive'}>{c.final_host}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              Live HTTP audit · checked {formatDistanceToNow(new Date(data.checked_at), { addSuffix: true })}.
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}