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
  GitCompareArrows, RefreshCw, CheckCircle2, AlertTriangle, XCircle, HelpCircle, Clock, ArrowRight,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

interface UrlRow {
  path: string;
  url: string;
  verdict: string | null;
  coverage_state: string | null;
  robots_state: string | null;
  indexing_state: string | null;
  page_fetch_state: string | null;
  google_canonical: string | null;
  user_canonical: string | null;
  last_crawl_time: string | null;
  canonical_on_primary: boolean | null;
  error?: string;
}

interface Sitemap {
  ok: boolean;
  submitted?: number;
  indexed?: number;
  errors?: number;
  warnings?: number;
  last_downloaded?: string | null;
  is_pending?: boolean;
}

interface Property {
  site_url: string;
  verified: boolean;
  sitemap: Sitemap | null;
  urls: UrlRow[];
}

interface CoverageResult {
  ok: boolean;
  checked_at: string;
  consolidation: 'correct' | 'reversed' | 'unknown';
  properties: { primary: Property; legacy: Property };
}

const host = (u: string) => u.replace(/^https?:\/\//, '').replace(/\/$/, '');

function coverageTone(state: string | null): 'good' | 'bad' | 'warn' | 'neutral' {
  if (!state) return 'neutral';
  const s = state.toLowerCase();
  if (s.includes('submitted and indexed') || s.includes('indexed, not submitted')) return 'good';
  if (s.includes('redirect') || s.includes('duplicate') || s.includes('excluded') || s.includes('blocked') || s.includes('error') || s.includes('not found')) return 'bad';
  if (s.includes('discovered') || s.includes('crawled')) return 'warn';
  if (s.includes('unknown to google')) return 'neutral';
  return 'neutral';
}

function CoverageBadge({ state }: { state: string | null }) {
  const tone = coverageTone(state);
  const label = state ?? '—';
  if (tone === 'good') return <Badge className="gap-1 bg-success text-success-foreground"><CheckCircle2 className="w-3 h-3" />{label}</Badge>;
  if (tone === 'bad') return <Badge variant="destructive" className="gap-1"><XCircle className="w-3 h-3" />{label}</Badge>;
  if (tone === 'warn') return <Badge className="gap-1 bg-warning text-warning-foreground"><AlertTriangle className="w-3 h-3" />{label}</Badge>;
  return <Badge variant="secondary" className="gap-1"><HelpCircle className="w-3 h-3" />{label}</Badge>;
}

function StatTile({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'good' | 'bad' | 'warn' | 'neutral' }) {
  const cls = tone === 'good' ? 'text-success' : tone === 'bad' ? 'text-destructive' : tone === 'warn' ? 'text-warning' : 'text-foreground';
  return (
    <div className="rounded-lg border bg-card p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-sm font-semibold mt-0.5 ${cls}`}>{value}</p>
    </div>
  );
}

function PropertyColumn({ property, isPrimary }: { property: Property; isPrimary: boolean }) {
  const sm = property.sitemap;
  return (
    <div className="rounded-xl border-2 p-3 sm:p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm sm:text-base">{host(property.site_url)}</span>
          <Badge variant={isPrimary ? 'default' : 'secondary'} className="text-[10px]">
            {isPrimary ? 'Primary' : 'Legacy'}
          </Badge>
        </div>
        {!property.verified && <Badge variant="destructive" className="text-[10px]">Not verified</Badge>}
      </div>

      {sm?.ok ? (
        <div className="grid grid-cols-3 gap-2">
          <StatTile label="Submitted" value={String(sm.submitted ?? 0)} />
          <StatTile label="Indexed" value={String(sm.indexed ?? 0)} tone={(sm.indexed ?? 0) > 0 ? 'good' : 'neutral'} />
          <StatTile label="Sitemap errors" value={String(sm.errors ?? 0)} tone={(sm.errors ?? 0) > 0 ? 'bad' : 'good'} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No sitemap data.</p>
      )}

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">Page</TableHead>
              <TableHead className="text-xs">Coverage</TableHead>
              <TableHead className="text-xs">Google canonical</TableHead>
              <TableHead className="text-xs whitespace-nowrap">Last crawl</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {property.urls.map((u) => (
              <TableRow key={u.path}>
                <TableCell className="text-xs font-mono whitespace-nowrap">{u.path}</TableCell>
                <TableCell><CoverageBadge state={u.error ? u.error : u.coverage_state} /></TableCell>
                <TableCell className="text-xs">
                  {u.google_canonical ? (
                    <span className={u.canonical_on_primary ? 'text-success' : 'text-destructive'}>
                      {host(u.google_canonical)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                  {u.last_crawl_time ? formatDistanceToNow(new Date(u.last_crawl_time), { addSuffix: true }) : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export function SeoCoverageDashboard() {
  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['seo-coverage-dashboard'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('seo-coverage-dashboard', { body: {} });
      if (error) throw error;
      return data as CoverageResult;
    },
    staleTime: 5 * 60_000,
  });

  const run = async () => {
    try {
      await refetch();
      toast.success('Coverage refreshed from Search Console.');
    } catch (e: any) {
      toast.error(`Refresh failed: ${e.message ?? e}`);
    }
  };

  const consolidation = data?.consolidation;

  return (
    <Card className="border-2">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <div className="flex items-center gap-2">
          <GitCompareArrows className="w-5 h-5 text-primary" />
          <CardTitle className="text-base sm:text-lg">Search Console Coverage · welileapp.com vs welilereceipts.com</CardTitle>{/* legacy-domain-guard-allow */}
        </div>
        <Button size="sm" variant="outline" onClick={run} disabled={isFetching}>
          <RefreshCw className={`w-4 h-4 mr-1.5 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Consolidation verdict banner */}
        {consolidation && (
          <div
            className={`rounded-lg border p-3 text-sm flex items-start gap-2 ${
              consolidation === 'correct'
                ? 'border-success/40 bg-success/10'
                : consolidation === 'reversed'
                  ? 'border-destructive/40 bg-destructive/10'
                  : 'border-muted bg-muted/30'
            }`}
          >
            {consolidation === 'correct' ? (
              <CheckCircle2 className="w-4 h-4 text-success mt-0.5 shrink-0" />
            ) : consolidation === 'reversed' ? (
              <AlertTriangle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
            ) : (
              <HelpCircle className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
            )}
            <div>
              {consolidation === 'correct' && (
                <span>Google is consolidating correctly — it treats <strong>welileapp.com</strong> as canonical.</span>
              )}
              {consolidation === 'reversed' && (
                <span className="flex flex-wrap items-center gap-1">
                  <strong>Consolidation is reversed.</strong> Google currently picks
                  <span className="font-mono">welilereceipts.com</span>{/* legacy-domain-guard-allow */}
                  <ArrowRight className="w-3 h-3" /> as canonical for welileapp.com pages.
                  Fix the legacy 301 redirect + submit a Change of Address so signals flow to welileapp.com.
                </span>
              )}
              {consolidation === 'unknown' && (
                <span>Not enough crawl data yet to determine canonical consolidation direction.</span>
              )}
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">Could not load coverage data. Try Refresh.</p>
        ) : data ? (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <PropertyColumn property={data.properties.primary} isPrimary />
              <PropertyColumn property={data.properties.legacy} isPrimary={false} />
            </div>
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              Live from Search Console · checked {formatDistanceToNow(new Date(data.checked_at), { addSuffix: true })}.
              Green canonical = points to welileapp.com; red = points to the legacy domain.
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}