import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { format, subDays, startOfDay, endOfDay } from 'date-fns';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { ArrowDown, Smartphone } from 'lucide-react';

type Preset = 'today' | 'last_7' | 'last_30' | 'last_90' | 'custom';

const FUNNEL_STEPS: Array<{
  key: 'guide_opened' | 'copy_clicked' | 'safari_handoff' | 'installed';
  label: string;
  description: string;
  events: string[];
}> = [
  {
    key: 'guide_opened',
    label: 'Open guide',
    description: 'ios_guide_opened',
    events: ['ios_guide_opened'],
  },
  {
    key: 'copy_clicked',
    label: 'Copy link',
    description: 'copy_link_clicked',
    events: ['copy_link_clicked'],
  },
  {
    key: 'safari_handoff',
    label: 'Open in Safari',
    description: 'copy_link_success (link handed to Safari)',
    events: ['copy_link_success'],
  },
  {
    key: 'installed',
    label: 'Installed',
    description: 'app_installed / native_prompt_accepted',
    events: ['app_installed', 'native_prompt_accepted'],
  },
];

const TRACKED_EVENTS = Array.from(new Set(FUNNEL_STEPS.flatMap((s) => s.events)));

type Row = {
  event_type: string;
  in_app_browser_name: string | null;
  in_app_browser: boolean | null;
  platform: string | null;
  user_id: string | null;
  created_at: string;
};

function presetBounds(preset: Preset, s: string, e: string) {
  const now = new Date();
  switch (preset) {
    case 'today':
      return { start: startOfDay(now), end: endOfDay(now) };
    case 'last_7':
      return { start: startOfDay(subDays(now, 6)), end: endOfDay(now) };
    case 'last_30':
      return { start: startOfDay(subDays(now, 29)), end: endOfDay(now) };
    case 'last_90':
      return { start: startOfDay(subDays(now, 89)), end: endOfDay(now) };
    case 'custom':
      return { start: startOfDay(new Date(s)), end: endOfDay(new Date(e)) };
  }
}

function browserLabel(row: Row): string {
  if (row.in_app_browser_name && row.in_app_browser_name.trim()) return row.in_app_browser_name.trim();
  if (row.in_app_browser) return 'In-app browser (unknown)';
  if (row.platform === 'ios') return 'Safari (iOS)';
  if (row.platform === 'android') return 'Chrome (Android)';
  if (row.platform) return row.platform;
  return 'Unknown';
}

export function InstallFunnelView() {
  const now = new Date();
  const [preset, setPreset] = useState<Preset>('last_30');
  const [customStart, setCustomStart] = useState(format(subDays(now, 29), 'yyyy-MM-dd'));
  const [customEnd, setCustomEnd] = useState(format(now, 'yyyy-MM-dd'));
  const [platformFilter, setPlatformFilter] = useState<'all' | 'ios' | 'android' | 'other'>('all');

  const { start, end } = presetBounds(preset, customStart, customEnd);

  const { data, isLoading, error } = useQuery({
    queryKey: ['install-funnel', start.toISOString(), end.toISOString(), platformFilter],
    queryFn: async () => {
      let q = supabase
        .from('install_attempt_events')
        .select('event_type,in_app_browser_name,in_app_browser,platform,user_id,created_at')
        .in('event_type', TRACKED_EVENTS)
        .gte('created_at', start.toISOString())
        .lte('created_at', end.toISOString())
        .order('created_at', { ascending: true })
        .limit(50000);
      if (platformFilter !== 'all' && platformFilter !== 'other') {
        q = q.eq('platform', platformFilter);
      }
      const { data, error } = await q;
      if (error) throw error;
      const rows = (data || []) as Row[];
      if (platformFilter === 'other') {
        return rows.filter((r) => r.platform !== 'ios' && r.platform !== 'android');
      }
      return rows;
    },
    staleTime: 60_000,
  });

  // Build funnel per browser: a user reaches step N if they emitted any event
  // in that step's event list within the window. Dedup by user_id (or a
  // per-session pseudo-id fallback for anonymous rows).
  const perBrowser = useMemo(() => {
    const rows = data || [];
    // browser -> step key -> Set<identity>
    const buckets = new Map<string, Record<string, Set<string>>>();
    for (const row of rows) {
      const b = browserLabel(row);
      const step = FUNNEL_STEPS.find((s) => s.events.includes(row.event_type));
      if (!step) continue;
      const identity = row.user_id ?? `anon:${row.created_at}`;
      if (!buckets.has(b)) {
        const init: Record<string, Set<string>> = {};
        FUNNEL_STEPS.forEach((s) => (init[s.key] = new Set()));
        buckets.set(b, init);
      }
      buckets.get(b)![step.key].add(identity);
    }

    const totals: Record<string, Set<string>> = {};
    FUNNEL_STEPS.forEach((s) => (totals[s.key] = new Set()));
    for (const stepCounts of buckets.values()) {
      for (const s of FUNNEL_STEPS) {
        stepCounts[s.key].forEach((id) => totals[s.key].add(id));
      }
    }

    const perBrowserRows = Array.from(buckets.entries())
      .map(([browser, counts]) => {
        const stepCounts = FUNNEL_STEPS.map((s) => counts[s.key].size);
        const top = stepCounts[0] || 0;
        return {
          browser,
          stepCounts,
          top,
          dropoffs: stepCounts.map((c, i) => {
            if (i === 0) return null as number | null;
            const prev = stepCounts[i - 1];
            if (!prev) return null;
            return 1 - c / prev;
          }),
          overall: top ? stepCounts[stepCounts.length - 1] / top : 0,
        };
      })
      .sort((a, b) => b.top - a.top);

    return {
      rows: perBrowserRows,
      totals: FUNNEL_STEPS.map((s) => totals[s.key].size),
    };
  }, [data]);

  const totalTop = perBrowser.totals[0] || 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="text-lg">Install funnel</CardTitle>
              <CardDescription>
                Guide → Copy → Safari → Install, split by detected browser.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <Label className="text-xs">Range</Label>
                <Select value={preset} onValueChange={(v) => setPreset(v as Preset)}>
                  <SelectTrigger className="h-9 w-[140px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="today">Today</SelectItem>
                    <SelectItem value="last_7">Last 7 days</SelectItem>
                    <SelectItem value="last_30">Last 30 days</SelectItem>
                    <SelectItem value="last_90">Last 90 days</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Platform</Label>
                <Select value={platformFilter} onValueChange={(v) => setPlatformFilter(v as typeof platformFilter)}>
                  <SelectTrigger className="h-9 w-[130px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="ios">iOS</SelectItem>
                    <SelectItem value="android">Android</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {preset === 'custom' && (
                <>
                  <div>
                    <Label className="text-xs">Start</Label>
                    <Input
                      type="date"
                      className="h-9"
                      value={customStart}
                      onChange={(e) => setCustomStart(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label className="text-xs">End</Label>
                    <Input
                      type="date"
                      className="h-9"
                      value={customEnd}
                      onChange={(e) => setCustomEnd(e.target.value)}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : error ? (
            <p className="text-sm text-destructive">Failed to load events.</p>
          ) : (
            <>
              {/* Overall funnel */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {FUNNEL_STEPS.map((s, i) => {
                  const count = perBrowser.totals[i];
                  const dropoff =
                    i > 0 && perBrowser.totals[i - 1] > 0
                      ? 1 - count / perBrowser.totals[i - 1]
                      : null;
                  const share = totalTop ? count / totalTop : 0;
                  return (
                    <div key={s.key} className="rounded-lg border p-3 bg-card">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          {i + 1}. {s.label}
                        </p>
                        {dropoff != null && (
                          <Badge variant={dropoff > 0.5 ? 'destructive' : 'secondary'} className="gap-1">
                            <ArrowDown className="h-3 w-3" />
                            {(dropoff * 100).toFixed(1)}%
                          </Badge>
                        )}
                      </div>
                      <p className="text-2xl font-semibold mt-1">{count.toLocaleString()}</p>
                      <p className="text-xs text-muted-foreground">
                        {(share * 100).toFixed(1)}% of guide opens
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-1 font-mono truncate" title={s.description}>
                        {s.description}
                      </p>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Smartphone className="h-4 w-4" /> By detected browser
          </CardTitle>
          <CardDescription>
            Unique users per step, with step-over-step drop-off. Anonymous events
            are counted individually.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : perBrowser.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No install events in this range.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Browser</TableHead>
                    {FUNNEL_STEPS.map((s) => (
                      <TableHead key={s.key} className="text-right">
                        {s.label}
                      </TableHead>
                    ))}
                    <TableHead className="text-right">Guide → Install</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {perBrowser.rows.map((r) => (
                    <TableRow key={r.browser}>
                      <TableCell className="font-medium">{r.browser}</TableCell>
                      {r.stepCounts.map((c, i) => {
                        const drop = r.dropoffs[i];
                        return (
                          <TableCell key={i} className="text-right tabular-nums">
                            <div>{c.toLocaleString()}</div>
                            {drop != null && (
                              <div
                                className={`text-[10px] ${
                                  drop > 0.5 ? 'text-destructive' : 'text-muted-foreground'
                                }`}
                              >
                                −{(drop * 100).toFixed(1)}%
                              </div>
                            )}
                          </TableCell>
                        );
                      })}
                      <TableCell className="text-right tabular-nums font-medium">
                        {(r.overall * 100).toFixed(1)}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default InstallFunnelView;