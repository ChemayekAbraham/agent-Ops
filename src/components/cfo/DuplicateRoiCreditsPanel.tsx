import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, RefreshCw, Loader2, Copy, Check } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { toast } from 'sonner';

interface DuplicateRoiRow {
  portfolio_id: string;
  portfolio_code: string | null;
  beneficiary_name: string | null;
  proxy_wallet_user_id: string | null;
  cycle_month: string;
  credit_count: number;
  total_amount: number;
  excess_amount: number;
  first_credit_at: string;
  last_credit_at: string;
  min_gap_seconds: number | null;
  ledger_ids: string[];
  ledger_references: string[];
}

export function DuplicateRoiCreditsPanel() {
  const [windowSeconds, setWindowSeconds] = useState(120);
  const [lookbackDays, setLookbackDays] = useState(30);
  const [copied, setCopied] = useState<string | null>(null);

  const { data, isFetching, refetch, error } = useQuery({
    queryKey: ['duplicate-roi-credits', windowSeconds, lookbackDays],
    queryFn: async (): Promise<DuplicateRoiRow[]> => {
      const { data, error } = await supabase.rpc('get_duplicate_roi_credits', {
        p_window_seconds: windowSeconds,
        p_lookback_days: lookbackDays,
      });
      if (error) throw error;
      return (data ?? []) as DuplicateRoiRow[];
    },
    staleTime: 60_000,
  });

  const rows = data ?? [];
  const totalExcess = rows.reduce((s, r) => s + Number(r.excess_amount || 0), 0);

  const copyRefs = (row: DuplicateRoiRow) => {
    const text = row.ledger_references.filter(Boolean).join(', ') || row.ledger_ids.join(', ');
    navigator.clipboard.writeText(text);
    setCopied(row.portfolio_id);
    toast.success('Ledger references copied');
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <Card className="border-destructive/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          Duplicate ROI Credit Monitor
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Flags portfolios where the same monthly ROI was credited more than once and the duplicate
          credits landed within seconds of each other — the signature of a double-submitted payout.
          Excess = amount paid above a single legitimate credit.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label className="text-xs">Within window (seconds)</Label>
            <Input
              type="number"
              min={1}
              max={3600}
              value={windowSeconds}
              onChange={(e) => setWindowSeconds(Math.max(1, Number(e.target.value) || 1))}
            />
          </div>
          <div>
            <Label className="text-xs">Lookback (days)</Label>
            <Input
              type="number"
              min={1}
              max={365}
              value={lookbackDays}
              onChange={(e) => setLookbackDays(Math.max(1, Number(e.target.value) || 1))}
            />
          </div>
          <div className="flex items-end">
            <Button onClick={() => refetch()} disabled={isFetching} className="w-full" variant="secondary">
              {isFetching ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              Recompute
            </Button>
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
            {(error as Error).message}
          </div>
        )}

        {rows.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <span className="font-semibold text-destructive">
              {rows.length} portfolio{rows.length === 1 ? '' : 's'} with duplicate ROI credits
            </span>
            <span className="text-muted-foreground">•</span>
            <span>Total excess: <span className="font-semibold tabular-nums">{formatUGX(totalExcess)}</span></span>
          </div>
        )}

        <div className="text-xs text-muted-foreground">
          {isFetching ? 'Scanning ledger…' : `${rows.length} flagged`}
        </div>

        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-left">
              <tr>
                <th className="p-2">Portfolio</th>
                <th className="p-2">Beneficiary</th>
                <th className="p-2">Cycle</th>
                <th className="p-2 text-right"># credits</th>
                <th className="p-2 text-right">Total credited</th>
                <th className="p-2 text-right">Excess</th>
                <th className="p-2 text-right">Gap</th>
                <th className="p-2 text-right">Posted</th>
                <th className="p-2 text-right">Refs</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !isFetching && (
                <tr>
                  <td colSpan={9} className="p-4 text-center text-muted-foreground">
                    No duplicate ROI credits inside the current window. 🎉
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={`${r.portfolio_id}-${r.cycle_month}`} className="border-t">
                  <td className="p-2">
                    <div className="font-medium">{r.portfolio_code ?? '—'}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">{r.portfolio_id.slice(0, 8)}…</div>
                  </td>
                  <td className="p-2 max-w-[160px] truncate">{r.beneficiary_name ?? '—'}</td>
                  <td className="p-2 whitespace-nowrap">{format(new Date(r.cycle_month), 'MMM yyyy')}</td>
                  <td className="p-2 text-right">
                    <Badge variant="destructive">{r.credit_count}×</Badge>
                  </td>
                  <td className="p-2 text-right tabular-nums">{formatUGX(r.total_amount)}</td>
                  <td className="p-2 text-right tabular-nums font-semibold text-destructive">
                    {formatUGX(r.excess_amount)}
                  </td>
                  <td className="p-2 text-right tabular-nums">
                    {r.min_gap_seconds != null ? `${Math.round(r.min_gap_seconds)}s` : '—'}
                  </td>
                  <td className="p-2 text-right text-muted-foreground whitespace-nowrap">
                    {format(new Date(r.first_credit_at), 'MMM d HH:mm:ss')}
                  </td>
                  <td className="p-2 text-right">
                    <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => copyRefs(r)}>
                      {copied === r.portfolio_id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

export default DuplicateRoiCreditsPanel;
