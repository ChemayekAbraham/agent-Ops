import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Globe, RefreshCw, MousePointerClick, Eye, TrendingUp, CheckCircle2,
  Clock, XCircle, AlertTriangle,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface BrandedQuery {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}
interface SearchConsole {
  available: boolean;
  error?: string;
  period?: { start: string; end: string };
  branded?: {
    clicks: number;
    impressions: number;
    ctr: number;
    avg_position: number;
    query_count: number;
  };
  top_queries?: BrandedQuery[];
}
interface SemrushSummary {
  captured_at: string | null;
  indexed: boolean;
  rank: number | null;
  organic_keywords: number | null;
  organic_traffic: number | null;
  authority_score: number | null;
  note: string | null;
}
interface Profile {
  key: string;
  name: string;
  status: string;
  detail: string;
}
interface VisibilityResult {
  ok: boolean;
  checked_at: string;
  domain: string;
  search_console: SearchConsole;
  semrush: SemrushSummary;
  profiles: Profile[];
}

const POSITIVE = new Set(['verified', 'indexed', 'connected']);
const PENDING = new Set(['pending', 'indexing']);

function statusMeta(status: string) {
  if (POSITIVE.has(status)) {
    return { icon: CheckCircle2, variant: 'default' as const, label: status };
  }
  if (PENDING.has(status)) {
    return { icon: Clock, variant: 'secondary' as const, label: status };
  }
  return { icon: XCircle, variant: 'outline' as const, label: status.replace(/_/g, ' ') };
}

function Stat({ icon: Icon, label, value, sub }: {
  icon: React.ElementType; label: string; value: string; sub?: string;
}) {
  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="w-3.5 h-3.5" /> {label}
      </div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

export function BrandSerpVisibilityPanel() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['brand-serp-visibility'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('brand-serp-visibility', { body: {} });
      if (error) throw error;
      return data as VisibilityResult;
    },
    staleTime: 30 * 60_000,
  });

  const sc = data?.search_console;
  const sr = data?.semrush;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Globe className="w-5 h-5" /> Branded SERP Visibility
          </CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Search Console demand, Semrush rank &amp; cross-engine profile presence for welileapp.com
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <Skeleton className="h-56 w-full" />
        ) : error ? (
          <p className="text-sm text-destructive">Failed to load: {(error as Error).message}</p>
        ) : !data ? null : (
          <>
            <p className="text-xs text-muted-foreground">
              Checked {formatDistanceToNow(new Date(data.checked_at), { addSuffix: true })}
              {sc?.period && <> · Search Console window {sc.period.start} → {sc.period.end}</>}
            </p>

            {/* Search Console branded demand */}
            <div>
              <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                <MousePointerClick className="w-4 h-4" /> Branded Search demand (Google)
              </h4>
              {sc?.available && sc.branded ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Stat icon={MousePointerClick} label="Clicks" value={sc.branded.clicks.toLocaleString()} />
                  <Stat icon={Eye} label="Impressions" value={sc.branded.impressions.toLocaleString()} />
                  <Stat icon={TrendingUp} label="CTR" value={`${(sc.branded.ctr * 100).toFixed(1)}%`} />
                  <Stat
                    icon={TrendingUp}
                    label="Avg position"
                    value={sc.branded.avg_position ? sc.branded.avg_position.toFixed(1) : '—'}
                    sub={`${sc.branded.query_count} branded queries`}
                  />
                </div>
              ) : (
                <div className="text-sm text-muted-foreground flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" />
                  {sc?.error
                    ? `Search Console unavailable: ${sc.error}`
                    : 'No branded Search Console data in this window yet.'}
                </div>
              )}
            </div>

            {/* Semrush rank */}
            <div>
              <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                <TrendingUp className="w-4 h-4" /> Semrush index &amp; rank
              </h4>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat icon={TrendingUp} label="Semrush rank" value={sr?.rank ? sr.rank.toLocaleString() : '—'} />
                <Stat icon={TrendingUp} label="Organic keywords" value={sr?.organic_keywords?.toLocaleString() ?? '—'} />
                <Stat icon={Eye} label="Est. traffic/mo" value={sr?.organic_traffic?.toLocaleString() ?? '—'} />
                <Stat icon={TrendingUp} label="Authority score" value={sr?.authority_score?.toString() ?? '—'} />
              </div>
              {sr?.note && (
                <p className="text-xs text-muted-foreground mt-2">{sr.note}</p>
              )}
              {sr?.captured_at && (
                <p className="text-xs text-muted-foreground mt-1">
                  Semrush snapshot {formatDistanceToNow(new Date(sr.captured_at), { addSuffix: true })}
                </p>
              )}
            </div>

            {/* Profile presence */}
            <div>
              <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4" /> Profile presence
              </h4>
              <div className="grid gap-2 sm:grid-cols-2">
                {data.profiles.map((p) => {
                  const m = statusMeta(p.status);
                  const Icon = m.icon;
                  return (
                    <div key={p.key} className="flex items-center justify-between gap-2 rounded-lg border p-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{p.name}</div>
                        <div className="text-xs text-muted-foreground truncate">{p.detail}</div>
                      </div>
                      <Badge variant={m.variant} className="capitalize shrink-0">
                        <Icon className="w-3 h-3 mr-1" /> {m.label}
                      </Badge>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Top branded queries */}
            {sc?.available && (sc.top_queries?.length ?? 0) > 0 && (
              <div>
                <h4 className="text-sm font-semibold mb-2">Top branded queries</h4>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Query</TableHead>
                      <TableHead className="text-right">Clicks</TableHead>
                      <TableHead className="text-right">Impr.</TableHead>
                      <TableHead className="text-right">CTR</TableHead>
                      <TableHead className="text-right">Pos.</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sc.top_queries!.map((q) => (
                      <TableRow key={q.query}>
                        <TableCell className="font-medium">{q.query}</TableCell>
                        <TableCell className="text-right">{q.clicks.toLocaleString()}</TableCell>
                        <TableCell className="text-right">{q.impressions.toLocaleString()}</TableCell>
                        <TableCell className="text-right">{(q.ctr * 100).toFixed(1)}%</TableCell>
                        <TableCell className="text-right">{q.position.toFixed(1)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
