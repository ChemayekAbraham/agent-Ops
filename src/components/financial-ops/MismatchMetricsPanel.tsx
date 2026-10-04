import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, AlertTriangle, RefreshCw, TrendingUp } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { format, formatDistanceToNow } from 'date-fns';

/**
 * Provider Mismatch Metrics — CFO/manager rollup of how often Financial
 * Ops operators trigger provider-mismatch warnings while verifying
 * deposits. Sourced from the `system_events` stream (event_type =
 * `finops_provider_mismatch`).
 *
 * Surfaces:
 *  • Totals for today / 7 days / 30 days
 *  • Per-operator leaderboard (worst → best in window)
 *  • Most recent attempts with picked vs. selected provider
 */
type Window = '1d' | '7d' | '30d';

type RawEvent = {
  id: string;
  user_id: string | null;
  created_at: string;
  metadata: {
    picked_provider?: string;
    selected_provider?: string;
    attempted_amount?: number | null;
    attempted_tid?: string | null;
  } | null;
};

type OperatorRow = {
  user_id: string;
  full_name: string | null;
  count: number;
  last_seen: string;
};

const WINDOW_HOURS: Record<Window, number> = {
  '1d': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
};

export function MismatchMetricsPanel() {
  const [windowSel, setWindowSel] = useState<Window>('7d');
  const [events, setEvents] = useState<RawEvent[]>([]);
  const [profilesById, setProfilesById] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async (w: Window) => {
    setLoading(true);
    setError(null);
    try {
      const since = new Date(Date.now() - WINDOW_HOURS[w] * 3600_000).toISOString();
      const { data, error: evErr } = await (supabase as any)
        .from('system_events')
        .select('id,user_id,created_at,metadata')
        .eq('event_type', 'finops_provider_mismatch')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(500);
      if (evErr) throw evErr;
      const rows = (data ?? []) as RawEvent[];
      setEvents(rows);

      // Fetch operator names in one round-trip.
      const userIds = Array.from(
        new Set(rows.map((r) => r.user_id).filter((x): x is string => !!x))
      );
      if (userIds.length) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id,full_name')
          .in('id', userIds);
        const map: Record<string, string | null> = {};
        (profs ?? []).forEach((p: { id: string; full_name: string | null }) => {
          map[p.id] = p.full_name;
        });
        setProfilesById(map);
      } else {
        setProfilesById({});
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to load metrics';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(windowSel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowSel]);

  // Per-operator aggregation
  const byOperator: OperatorRow[] = (() => {
    const buckets: Record<string, OperatorRow> = {};
    events.forEach((e) => {
      if (!e.user_id) return;
      if (!buckets[e.user_id]) {
        buckets[e.user_id] = {
          user_id: e.user_id,
          full_name: profilesById[e.user_id] ?? null,
          count: 0,
          last_seen: e.created_at,
        };
      }
      buckets[e.user_id].count += 1;
      if (e.created_at > buckets[e.user_id].last_seen) {
        buckets[e.user_id].last_seen = e.created_at;
      }
    });
    return Object.values(buckets).sort((a, b) => b.count - a.count);
  })();

  const totalAttempts = events.length;
  const uniqueOperators = byOperator.length;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold flex items-center gap-2.5">
            <AlertTriangle className="h-6 w-6 text-warning" />
            Provider Mismatch Metrics
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            How often operators try to verify a deposit on the wrong provider channel.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-border overflow-hidden">
            {(['1d', '7d', '30d'] as Window[]).map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setWindowSel(w)}
                className={`px-3 h-9 text-xs font-medium transition-colors ${
                  windowSel === w
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background hover:bg-accent/40'
                }`}
              >
                {w === '1d' ? 'Today' : w === '7d' ? '7 days' : '30 days'}
              </button>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => load(windowSel)}
            disabled={loading}
            className="h-9"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Attempts</p>
            <p className="text-2xl font-bold mt-0.5">{totalAttempts}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Operators</p>
            <p className="text-2xl font-bold mt-0.5">{uniqueOperators}</p>
          </CardContent>
        </Card>
        <Card className="col-span-2 sm:col-span-1">
          <CardContent className="pt-4 pb-4">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Avg / operator</p>
            <p className="text-2xl font-bold mt-0.5">
              {uniqueOperators === 0 ? '0' : (totalAttempts / uniqueOperators).toFixed(1)}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Per-operator leaderboard
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {loading ? (
            <div className="flex items-center justify-center py-6 text-muted-foreground text-xs">
              <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading…
            </div>
          ) : error ? (
            <p className="text-xs text-destructive py-3">{error}</p>
          ) : byOperator.length === 0 ? (
            <p className="text-xs text-muted-foreground py-3">
              No mismatch attempts in this window — nice work, team.
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {byOperator.map((op) => (
                <li key={op.user_id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {op.full_name ?? <span className="font-mono text-xs">{op.user_id.slice(0, 8)}…</span>}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      Last attempt {formatDistanceToNow(new Date(op.last_seen), { addSuffix: true })}
                    </p>
                  </div>
                  <Badge variant={op.count >= 5 ? 'destructive' : op.count >= 2 ? 'secondary' : 'outline'}>
                    {op.count} attempt{op.count === 1 ? '' : 's'}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Recent attempts</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {events.length === 0 ? (
            <p className="text-xs text-muted-foreground py-3">No events.</p>
          ) : (
            <ul className="divide-y divide-border/60 max-h-80 overflow-y-auto">
              {events.slice(0, 50).map((e) => {
                const picked = (e.metadata?.picked_provider ?? '—').toUpperCase();
                const selected = (e.metadata?.selected_provider ?? '—').toUpperCase();
                const opName = e.user_id ? profilesById[e.user_id] : null;
                return (
                  <li key={e.id} className="py-2 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs">
                        <span className="font-medium">{opName ?? 'Operator'}</span>{' '}
                        picked <Badge variant="secondary" className="text-[10px]">{picked}</Badge>{' '}
                        but had <Badge variant="outline" className="text-[10px]">{selected}</Badge>{' '}
                        selected.
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {format(new Date(e.created_at), 'MMM d, HH:mm')}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}