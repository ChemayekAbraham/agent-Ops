import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Activity, RefreshCw, AlertTriangle } from 'lucide-react';
import { format, formatDistanceStrict, formatDistanceToNowStrict } from 'date-fns';
import { formatDynamic as formatUGX } from '@/lib/currencyFormat';

type Row = {
  id: string;
  internal_date: string | null;
  created_at: string;
  channel: string | null;
  direction: string | null;
  transaction_id: string | null;
  amount: number | null;
  counterparty: string | null;
  subject: string | null;
  parsed: boolean | null;
};

const WINDOWS = [
  { key: '24h', label: 'Last 24 hours', hours: 24, gapMinutes: 120 },
  { key: '7d', label: 'Last 7 days', hours: 24 * 7, gapMinutes: 240 },
  { key: '30d', label: 'Last 30 days', hours: 24 * 30, gapMinutes: 720 },
] as const;

const rowTime = (r: Row) => new Date(r.internal_date ?? r.created_at).getTime();

/**
 * IFTTT diagnostics — shows the most recent forwarded action rows
 * (SMS -> Gmail -> gmail_transactions) and highlights silence gaps
 * inside the selected timeframe.
 */
export function IftttDiagnosticsPanel() {
  const [windowKey, setWindowKey] = useState<(typeof WINDOWS)[number]['key']>('24h');
  const win = WINDOWS.find((w) => w.key === windowKey)!;

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['ifttt-diagnostics', windowKey],
    queryFn: async () => {
      const since = new Date(Date.now() - win.hours * 3600_000).toISOString();
      const { data, error } = await supabase
        .from('gmail_transactions')
        .select(
          'id, internal_date, created_at, channel, direction, transaction_id, amount, counterparty, subject, parsed'
        )
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as Row[];
    },
    refetchInterval: 2 * 60 * 1000,
    staleTime: 60_000,
  });

  const { rows, gaps } = useMemo(() => {
    const sorted = [...(data ?? [])].sort((a, b) => rowTime(b) - rowTime(a));
    const gapMs = win.gapMinutes * 60_000;
    const found: { from: Date; to: Date; ms: number }[] = [];
    const now = Date.now();
    if (sorted.length) {
      const newest = rowTime(sorted[0]);
      if (now - newest > gapMs) found.push({ from: new Date(newest), to: new Date(now), ms: now - newest });
      for (let i = 0; i < sorted.length - 1; i++) {
        const a = rowTime(sorted[i]);
        const b = rowTime(sorted[i + 1]);
        if (a - b > gapMs) found.push({ from: new Date(b), to: new Date(a), ms: a - b });
      }
    }
    return { rows: sorted, gaps: found };
  }, [data, win.gapMinutes]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            IFTTT diagnostics
          </CardTitle>
          <div className="flex items-center gap-1">
            {WINDOWS.map((w) => (
              <Button
                key={w.key}
                size="sm"
                variant={w.key === windowKey ? 'default' : 'outline'}
                className="h-7 text-xs"
                onClick={() => setWindowKey(w.key)}
              >
                {w.key}
              </Button>
            ))}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {win.label} · {rows.length} forwarded action{rows.length === 1 ? '' : 's'} · gap threshold{' '}
          {win.gapMinutes} min
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            {/* Gaps */}
            {gaps.length > 0 ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 space-y-2">
                <p className="text-xs font-semibold text-destructive flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {gaps.length} silence gap{gaps.length === 1 ? '' : 's'} detected
                </p>
                <ul className="space-y-1">
                  {gaps.slice(0, 8).map((g, i) => (
                    <li key={i} className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {formatDistanceStrict(g.from, g.to)}
                      </span>{' '}
                      — {format(g.from, 'dd MMM HH:mm')} → {format(g.to, 'dd MMM HH:mm')}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">
                  No gaps longer than {win.gapMinutes} minutes in this timeframe.
                </p>
              </div>
            )}

            {/* Recent rows */}
            <div className="divide-y divide-border rounded-lg border border-border">
              {rows.length === 0 && (
                <p className="p-3 text-xs text-muted-foreground">
                  No forwarded action rows in this timeframe.
                </p>
              )}
              {rows.slice(0, 25).map((r) => {
                const ts = new Date(rowTime(r));
                return (
                  <div key={r.id} className="flex items-start justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline" className="text-[10px]">
                          {r.channel ?? 'unknown'}
                        </Badge>
                        {r.direction && (
                          <Badge variant="secondary" className="text-[10px]">
                            {r.direction}
                          </Badge>
                        )}
                        {r.parsed === false && (
                          <Badge variant="destructive" className="text-[10px]">
                            unparsed
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 truncate">
                        {r.transaction_id ? `TID ${r.transaction_id} · ` : ''}
                        {r.counterparty ?? r.subject ?? '—'}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-medium">
                        {r.amount != null ? formatUGX(Number(r.amount)) : '—'}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {format(ts, 'dd MMM HH:mm')} · {formatDistanceToNowStrict(ts)} ago
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}