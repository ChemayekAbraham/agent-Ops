import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { BarChart3, RefreshCw, MousePointerClick, UserCheck } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SourceStat {
  source: string;
  clicks: number;
  signups: number;
  conversion: number;
}

const SOURCE_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  facebook: 'Facebook',
  twitter: 'X (Twitter)',
  linkedin: 'LinkedIn',
  telegram: 'Telegram',
  email: 'Email',
  copy: 'Copied Link',
  native_share: 'Direct Share',
};

const label = (s: string) => SOURCE_LABELS[s] ?? s;

export default function CareersAnalyticsPanel() {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<SourceStat[]>([]);
  const [totals, setTotals] = useState({ clicks: 0, signups: 0 });

  const fetchStats = useCallback(async () => {
    setLoading(true);
    try {
      const [clicksRes, appsRes] = await Promise.all([
        (supabase.from('career_link_clicks' as any) as any).select('utm_source'),
        (supabase.from('job_applications' as any) as any).select('utm_source'),
      ]);

      const clickMap = new Map<string, number>();
      (clicksRes.data || []).forEach((r: any) => {
        const s = r.utm_source || 'untagged';
        clickMap.set(s, (clickMap.get(s) || 0) + 1);
      });

      const signupMap = new Map<string, number>();
      (appsRes.data || []).forEach((r: any) => {
        const s = r.utm_source || 'untagged';
        signupMap.set(s, (signupMap.get(s) || 0) + 1);
      });

      const sources = new Set<string>([...clickMap.keys(), ...signupMap.keys()]);
      const rows: SourceStat[] = [...sources].map((source) => {
        const clicks = clickMap.get(source) || 0;
        const signups = signupMap.get(source) || 0;
        return { source, clicks, signups, conversion: clicks > 0 ? (signups / clicks) * 100 : 0 };
      });

      rows.sort((a, b) => b.signups - a.signups || b.clicks - a.clicks);
      setStats(rows);
      setTotals({
        clicks: [...clickMap.values()].reduce((a, b) => a + b, 0),
        signups: [...signupMap.values()].reduce((a, b) => a + b, 0),
      });
    } catch (err) {
      console.error('Failed to load careers analytics:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  const maxClicks = Math.max(1, ...stats.map((s) => s.clicks));

  return (
    <Card className="mb-4 no-print">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <BarChart3 className="h-4 w-4 text-primary" />
          Careers Link Analytics
        </CardTitle>
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={fetchStats}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Totals */}
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-xl border border-border p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <MousePointerClick className="h-3.5 w-3.5" /> Clicks
            </div>
            <p className="text-2xl font-bold">{totals.clicks}</p>
          </div>
          <div className="rounded-xl border border-border p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <UserCheck className="h-3.5 w-3.5" /> Sign-ups
            </div>
            <p className="text-2xl font-bold">{totals.signups}</p>
          </div>
          <div className="rounded-xl border border-border p-3">
            <div className="text-xs text-muted-foreground">Conversion</div>
            <p className="text-2xl font-bold">
              {totals.clicks > 0 ? ((totals.signups / totals.clicks) * 100).toFixed(0) : 0}%
            </p>
          </div>
        </div>

        {/* Per-source breakdown */}
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full rounded-lg" />)}
          </div>
        ) : stats.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            No data yet. Share the careers link to start tracking which platform drives sign-ups.
          </p>
        ) : (
          <div className="space-y-2">
            {stats.map((s) => (
              <div key={s.source} className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">{label(s.source)}</span>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground">{s.clicks} clicks</span>
                    <Badge variant="outline" className="text-[10px]">{s.signups} sign-ups</Badge>
                    <span className="font-semibold text-primary w-10 text-right">{s.conversion.toFixed(0)}%</span>
                  </div>
                </div>
                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${(s.clicks / maxClicks) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}