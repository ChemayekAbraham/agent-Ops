import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, RefreshCw, Loader2 } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';

interface DriftRow {
  user_id: string;
  full_name: string;
  phone: string;
  window_days: number;
  admin_net: number;
  admin_abs: number;
  production_net: number;
  production_abs: number;
  abs_ratio: number;
  cached_withdrawable: number;
  cached_float: number;
  strict_withdrawable: number;
  last_admin_at: string | null;
  admin_entry_count: number;
}

export function PhantomCorrectionDriftPanel() {
  const [windowDays, setWindowDays] = useState(30);
  const [minAdminAbs, setMinAdminAbs] = useState(100_000);
  const [ratio, setRatio] = useState(2);

  const { data, isFetching, refetch, error } = useQuery({
    queryKey: ['phantom-correction-drift', windowDays, minAdminAbs, ratio],
    queryFn: async (): Promise<DriftRow[]> => {
      const { data, error } = await supabase.rpc('get_phantom_correction_drift', {
        p_window_days: windowDays,
        p_min_admin_abs: minAdminAbs,
        p_ratio_threshold: ratio,
      });
      if (error) throw error;
      return (data ?? []) as DriftRow[];
    },
    staleTime: 60_000,
  });

  const rows = data ?? [];

  return (
    <Card className="border-amber-500/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          Phantom Correction Drift Monitor
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Wallets where admin / system corrections greatly exceed real production activity
          inside the window. High abs-ratio = the wallet's recent movement is mostly admin
          plumbing, not earned activity.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <div>
            <Label className="text-xs">Window (days)</Label>
            <Input
              type="number"
              min={1}
              max={365}
              value={windowDays}
              onChange={(e) => setWindowDays(Math.max(1, Number(e.target.value) || 1))}
            />
          </div>
          <div>
            <Label className="text-xs">Min admin |Σ| (UGX)</Label>
            <Input
              type="number"
              min={0}
              step={10000}
              value={minAdminAbs}
              onChange={(e) => setMinAdminAbs(Math.max(0, Number(e.target.value) || 0))}
            />
          </div>
          <div>
            <Label className="text-xs">Ratio threshold</Label>
            <Input
              type="number"
              min={0}
              step={0.5}
              value={ratio}
              onChange={(e) => setRatio(Math.max(0, Number(e.target.value) || 0))}
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

        <div className="text-xs text-muted-foreground">
          {isFetching ? 'Scanning…' : `${rows.length} flagged wallet${rows.length === 1 ? '' : 's'}`}
        </div>

        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-left">
              <tr>
                <th className="p-2">User</th>
                <th className="p-2 text-right">Admin net</th>
                <th className="p-2 text-right">Production net</th>
                <th className="p-2 text-right">|admin|/|prod|</th>
                <th className="p-2 text-right">Cached W / F</th>
                <th className="p-2 text-right">Strict W</th>
                <th className="p-2 text-right">Last admin</th>
                <th className="p-2 text-right"># entries</th>
                <th className="p-2 text-right">Drill-down</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !isFetching && (
                <tr>
                  <td colSpan={9} className="p-4 text-center text-muted-foreground">
                    No wallets exceed the current thresholds.
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const severe = r.production_net < 0 && r.admin_net > 0;
                return (
                  <tr key={r.user_id} className="border-t">
                    <td className="p-2">
                      <div className="font-medium truncate max-w-[180px]">{r.full_name}</div>
                      <div className="text-muted-foreground">{r.phone}</div>
                      <div className="font-mono text-[10px] text-muted-foreground">{r.user_id.slice(0, 8)}…</div>
                    </td>
                    <td className="p-2 text-right tabular-nums text-emerald-700">
                      {formatUGX(r.admin_net)}
                    </td>
                    <td className={`p-2 text-right tabular-nums ${r.production_net < 0 ? 'text-destructive' : ''}`}>
                      {formatUGX(r.production_net)}
                    </td>
                    <td className="p-2 text-right">
                      <Badge variant={severe ? 'destructive' : r.abs_ratio >= 5 ? 'destructive' : 'secondary'}>
                        {r.abs_ratio >= 1e8 ? '∞' : `${r.abs_ratio}x`}
                      </Badge>
                    </td>
                    <td className="p-2 text-right tabular-nums">
                      {formatUGX(r.cached_withdrawable)} / {formatUGX(r.cached_float)}
                    </td>
                    <td className="p-2 text-right tabular-nums">{formatUGX(r.strict_withdrawable)}</td>
                    <td className="p-2 text-right text-muted-foreground">
                      {r.last_admin_at ? format(new Date(r.last_admin_at), 'MMM d HH:mm') : '—'}
                    </td>
                    <td className="p-2 text-right tabular-nums">{r.admin_entry_count}</td>
                    <td className="p-2 text-right">
                      <Link
                        to={`/cfo/phantom-drift/${r.user_id}?window=${windowDays}`}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

export default PhantomCorrectionDriftPanel;