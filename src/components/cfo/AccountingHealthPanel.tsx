import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatDynamic as formatUGX } from '@/lib/currencyFormat';
import { format } from 'date-fns';

interface FinControl {
  id: string;
  name: string;
  status: 'ok' | 'warn' | 'fail';
  value: number;
  amount?: number;
  detail?: unknown;
}

interface FinControls {
  as_at: string;
  generated_at: string;
  controls: FinControl[];
  summary: { fail: number; warn: number; ok: number };
}

const statusIcon = (s: FinControl['status']) =>
  s === 'ok' ? <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
  : s === 'warn' ? <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
  : <XCircle className="h-4 w-4 text-destructive shrink-0" />;

function Detail({ detail }: { detail: unknown }) {
  if (detail == null) return null;
  if (typeof detail === 'string') return <p className="text-[11px] text-muted-foreground mt-1">{detail}</p>;
  if (!Array.isArray(detail) || detail.length === 0) return null;
  const rows = detail.slice(0, 10) as Record<string, unknown>[];
  const keys = Object.keys(rows[0] ?? {});
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-left text-muted-foreground border-b border-border">
            {keys.map((k) => <th key={k} className="py-1 pr-3 font-medium">{k.replace(/_/g, ' ')}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border/50 last:border-0">
              {keys.map((k) => {
                const v = r[k];
                const text = typeof v === 'number' ? formatUGX(v) : v == null ? '—' : String(v);
                return <td key={k} className="py-1 pr-3 font-mono truncate max-w-[220px]">{text}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {detail.length > 10 && <p className="text-[10px] text-muted-foreground mt-1">{detail.length - 10} more not shown</p>}
    </div>
  );
}

/**
 * Accounting health: read-only checks from `public.fin_controls()`.
 * Nothing here can move money or change a record; it only shows where the books and the operational
 * records disagree so the CFO sees it before the figures are used.
 */
export default function AccountingHealthPanel() {
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['fin-controls'],
    queryFn: async (): Promise<FinControls> => {
      const { data: res, error: rpcError } = await supabase.rpc('fin_controls', {});
      if (rpcError) throw rpcError;
      return res as unknown as FinControls;
    },
    staleTime: 5 * 60 * 1000,
  });

  return (
    <div className="space-y-4 max-w-6xl mx-auto">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-bold tracking-tight">Accounting Health</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Read-only checks of the ledger against itself and against operational records. Takes about a minute.
          </p>
        </div>
        <Button variant="outline" size="sm" className="h-9 rounded-xl gap-2 text-xs" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Run checks
        </Button>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" /> Running accounting checks…
        </div>
      )}
      {error && (
        <Card className="rounded-2xl">
          <CardContent className="p-6 text-sm text-destructive">{(error as Error).message}</CardContent>
        </Card>
      )}

      {data && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="destructive">{data.summary.fail} failing</Badge>
            <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">{data.summary.warn} to review</Badge>
            <Badge variant="outline" className="border-emerald-500 text-emerald-700 dark:text-emerald-400">{data.summary.ok} passing</Badge>
            <span className="text-muted-foreground">as at {format(new Date(data.as_at), 'dd MMM yyyy, HH:mm')}</span>
          </div>
          <div className="space-y-3">
            {data.controls.map((c) => (
              <Card key={c.id} className="rounded-2xl">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-start gap-2">
                    {statusIcon(c.status)}
                    <span className="flex-1">
                      <span className="text-muted-foreground mr-1.5">{c.id}</span>
                      {c.name}
                    </span>
                    <span className="font-mono tabular-nums text-xs">
                      {c.value}
                      {c.amount != null ? ` · ${formatUGX(c.amount)}` : ''}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <Detail detail={c.detail} />
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
