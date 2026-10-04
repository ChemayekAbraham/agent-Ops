import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Search, RefreshCw, Link2, TrendingUp, AlertTriangle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

interface BrandKeyword {
  keyword: string;
  volume: number;
  cpc: number;
  competition: number;
  difficulty: number;
}
interface DomainSummary {
  indexed?: boolean;
  note?: string;
  rank?: number;
  organic_keywords?: number;
  organic_traffic?: number;
  organic_cost?: number;
  error?: string;
}
interface BacklinksSummary {
  indexed?: boolean;
  note?: string;
  authority_score?: number;
  total_backlinks?: number;
  referring_domains?: number;
  referring_urls?: number;
  follow_links?: number;
  nofollow_links?: number;
  error?: string;
}
interface Snapshot {
  id: string;
  captured_at: string;
  source: string;
  domain: string;
  brand_keywords: BrandKeyword[];
  domain_summary: DomainSummary | null;
  backlinks_summary: BacklinksSummary | null;
}
interface TrackerResult {
  ok: boolean;
  checked_at: string;
  latest: Snapshot | null;
  history: Snapshot[];
}

export function SemrushBrandTrackerPanel() {
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['semrush-brand-tracker'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('semrush-brand-tracker', {
        body: { history_only: true },
      });
      if (error) throw error;
      return data as TrackerResult;
    },
    staleTime: 60 * 60_000,
  });

  const snapshot = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('semrush-brand-tracker', {
        body: { source: 'manual' },
      });
      if (error) throw error;
      return data as TrackerResult;
    },
    onSuccess: (d) => {
      qc.setQueryData(['semrush-brand-tracker'], d);
      toast.success('Fresh Semrush snapshot captured.');
    },
    onError: (e: any) => toast.error(`Snapshot failed: ${e.message ?? e}`),
  });

  const latest = data?.latest;
  const dom = latest?.domain_summary;
  const bl = latest?.backlinks_summary;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Search className="w-5 h-5" /> Brand Search Tracker
          </CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Semrush branded keywords &amp; backlink profile for welileapp.com
          </p>
        </div>
        <Button size="sm" onClick={() => snapshot.mutate()} disabled={snapshot.isPending}>
          <RefreshCw className={`w-4 h-4 mr-2 ${snapshot.isPending ? 'animate-spin' : ''}`} />
          {snapshot.isPending ? 'Fetching…' : 'Capture snapshot'}
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : error ? (
          <p className="text-sm text-destructive">Failed to load tracker: {(error as Error).message}</p>
        ) : !latest ? (
          <div className="text-sm text-muted-foreground flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            No snapshots yet. Click “Capture snapshot” to pull the first Semrush reading.
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Last snapshot {formatDistanceToNow(new Date(latest.captured_at), { addSuffix: true })} · {latest.source}
            </p>

            {/* Branded keywords */}
            <div>
              <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                <TrendingUp className="w-4 h-4" /> Branded keywords
              </h4>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Keyword</TableHead>
                    <TableHead className="text-right">Volume/mo</TableHead>
                    <TableHead className="text-right">CPC</TableHead>
                    <TableHead className="text-right">Difficulty</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {latest.brand_keywords.length === 0 ? (
                    <TableRow><TableCell colSpan={4} className="text-muted-foreground text-sm">No branded keyword data returned.</TableCell></TableRow>
                  ) : latest.brand_keywords.map((k) => (
                    <TableRow key={k.keyword}>
                      <TableCell className="font-medium">{k.keyword}</TableCell>
                      <TableCell className="text-right">{k.volume.toLocaleString()}</TableCell>
                      <TableCell className="text-right">${k.cpc.toFixed(2)}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant={k.difficulty < 30 ? 'secondary' : k.difficulty < 60 ? 'outline' : 'destructive'}>
                          {k.difficulty}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Domain + backlinks summary */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-lg border p-4">
                <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                  <TrendingUp className="w-4 h-4" /> Organic ranking
                </h4>
                {dom?.error ? (
                  <p className="text-sm text-destructive">{dom.error}</p>
                ) : dom?.indexed ? (
                  <ul className="text-sm space-y-1">
                    <li>Rank: <span className="font-medium">#{dom.rank?.toLocaleString()}</span></li>
                    <li>Organic keywords: <span className="font-medium">{dom.organic_keywords?.toLocaleString()}</span></li>
                    <li>Est. monthly traffic: <span className="font-medium">{dom.organic_traffic?.toLocaleString()}</span></li>
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">Not yet in Semrush's index — the domain is new. Data appears as Google crawls and ranks it.</p>
                )}
              </div>
              <div className="rounded-lg border p-4">
                <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                  <Link2 className="w-4 h-4" /> Backlink profile
                </h4>
                {bl?.error ? (
                  <p className="text-sm text-destructive">{bl.error}</p>
                ) : bl?.indexed ? (
                  <ul className="text-sm space-y-1">
                    <li>Authority score: <span className="font-medium">{bl.authority_score}</span></li>
                    <li>Total backlinks: <span className="font-medium">{bl.total_backlinks?.toLocaleString()}</span></li>
                    <li>Referring domains: <span className="font-medium">{bl.referring_domains?.toLocaleString()}</span></li>
                    <li>Follow / nofollow: <span className="font-medium">{bl.follow_links?.toLocaleString()} / {bl.nofollow_links?.toLocaleString()}</span></li>
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">No backlinks indexed yet — expected for a newly published domain.</p>
                )}
              </div>
            </div>

            {data && data.history.length > 1 && (
              <p className="text-xs text-muted-foreground">
                {data.history.length} snapshots tracked · a weekly job captures new readings automatically.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}