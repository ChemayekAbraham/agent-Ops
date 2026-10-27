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

/** What get_install_funnel_summary returns: per-browser unique counts for the four steps. */
type FunnelSummary = {
  totals: number[];
  rows: { browser: string; counts: number[] }[];
};

/** Parses 'YYYY-MM-DD' as a LOCAL date; null when empty or invalid (a cleared date input). */
function parseLocalDate(value: string): Date | null {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

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
      return {
        start: startOfDay(parseLocalDate(s) ?? subDays(now, 29)),
        end: endOfDay(parseLocalDate(e) ?? now),
      };
  }
}

export function InstallFunnelView() {
  const now = new Date();
  const [preset, setPreset] = useState<Preset>('last_30');
  const [customStart, setCustomStart] = useState(format(subDays(now, 29), 'yyyy-MM-dd'));
  const [customEnd, setCustomEnd] = useState(format(now, 'yyyy-MM-dd'));
  const [platformFilter, setPlatformFilter] = useState<'all' | 'ios' | 'android' | 'other'>('all');

  const { start, end } = presetBounds(preset, customStart, customEnd);
  // Changing one end past the other moves the other end too. A cleared input is ignored (it crashed the page).
  const changeCustomStart = (v: string) => { if (!v) return; setCustomStart(v); if (v > customEnd) setCustomEnd(v); };
  const changeCustomEnd = (v: string) => { if (!v) return; setCustomEnd(v); if (v < customStart) setCustomStart(v); };
  const rangeKey = `${format(start, 'yyyy-MM-dd')}_${format(end, 'yyyy-MM-dd')}`;

  // Counted in the database: the old page downloaded every event (Supabase stops at 1,000 rows, so
  // ranges beyond ~30 days were silently cut short) and counted each Android install twice, because
  // an install writes both app_installed and native_prompt_accepted.
  const { data, isLoading, error } = useQuery({
    queryKey: ['install-funnel-summary', rangeKey, platformFilter],
    queryFn: async () => {
      // The function is newer than the generated database types, so call it through a narrow cast.
      const rpc = supabase as unknown as {
        rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: Error | null }>;
      };
      const { data, error } = await rpc.rpc('get_install_funnel_summary', {
        p_start: start.toISOString(),
        p_end: end.toISOString(),
        p_platform: platformFilter,
      });
      if (error) throw error;
      return data as FunnelSummary;
    },
    staleTime: 60_000,
  });

  const perBrowser = useMemo(() => {
    const rows = (data?.rows ?? []).map((r) => {
      const stepCounts = r.counts;
      const top = stepCounts[0] || 0;
      return {
        browser: r.browser,
        stepCounts,
        top,
        // Step-over-step drop-off, only where it means something: the previous step had users and
        // this step did not exceed it (a later step can be larger when it is a different population).
        dropoffs: stepCounts.map((c, i) => {
          if (i === 0) return null as number | null;
          const prev = stepCounts[i - 1];
          if (!prev || c > prev) return null;
          return 1 - c / prev;
        }),
        overall: top && stepCounts[3] <= top ? stepCounts[3] / top : null,
      };
    });
    return { rows, totals: data?.totals ?? [0, 0, 0, 0] };
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
                  <SelectTrigger className="h-9 w-[170px]">
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
                      max={format(now, 'yyyy-MM-dd')}
                      onChange={(e) => changeCustomStart(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label className="text-xs">End</Label>
                    <Input
                      type="date"
                      className="h-9"
                      value={customEnd}
                      max={format(now, 'yyyy-MM-dd')}
                      onChange={(e) => changeCustomEnd(e.target.value)}
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
                  const count = perBrowser.totals[i] ?? 0;
                  const isInstall = s.key === 'installed';
                  // Installs come from every platform (mostly the Android install prompt), not from
                  // the iOS guide, so they are not a continuation of steps 1-3.
                  const dropoff =
                    i > 0 && !isInstall && perBrowser.totals[i - 1] > 0
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
                        {isInstall ? 'all platforms · not only guide users' : `${(share * 100).toFixed(1)}% of guide opens`}
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
            Signed-in users are counted once per step; anonymous events (no session id exists) are counted
            individually. Installs are Android/desktop install-prompt events, so iOS rows show 0 installed:
            no iOS install event is recorded.
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
                        {r.overall == null ? '—' : `${(r.overall * 100).toFixed(1)}%`}
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