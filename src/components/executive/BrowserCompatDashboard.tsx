import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { KPICard } from './KPICard';
import { ExecutiveDataTable, Column } from './ExecutiveDataTable';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import { MonitorSmartphone, PackageX, PackageCheck, AlertTriangle, MousePointerClick } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface CompatEvent {
  id: string;
  created_at: string;
  event_type: 'gate_missing' | 'impl_loaded' | 'impl_load_failed' | 'banner_shown' | 'banner_action';
  user_agent: string | null;
  missing_features: string[] | null;
  device: Record<string, any> | null;
  error_message: string | null;
  load_ms: number | null;
  choice: string | null;
}

/** Compress a raw UA string into a readable "Browser vNN · OS · surface" label. */
function labelUA(ua: string | null, device: Record<string, any> | null): string {
  if (!ua) return 'Unknown';
  const os = device?.os ?? (/Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : 'Other');
  const chrome = ua.match(/Chrome\/(\d+)/)?.[1];
  const safari = !chrome && /Version\/(\d+)/.test(ua) ? ua.match(/Version\/(\d+)/)?.[1] : null;
  const firefox = ua.match(/Firefox\/(\d+)/)?.[1];
  let browser = 'Browser';
  if (chrome) browser = `Chrome ${chrome}`;
  else if (firefox) browser = `Firefox ${firefox}`;
  else if (safari) browser = `Safari ${safari}`;
  const wv = device?.is_webview || /; wv\)/.test(ua) || /FBAN|FBAV|Instagram/.test(ua);
  return `${browser} · ${os}${wv ? ' · WebView' : ''}`;
}

export function BrowserCompatDashboard() {
  const { data: events, isLoading } = useQuery({
    queryKey: ['browser-compat-events'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('browser_compat_events')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as CompatEvent[];
    },
    staleTime: 120_000,
  });

  const stats = useMemo(() => {
    const list = events ?? [];
    const gateMissing = list.filter((e) => e.event_type === 'gate_missing');
    const implLoaded = list.filter((e) => e.event_type === 'impl_loaded');
    const implFailed = list.filter((e) => e.event_type === 'impl_load_failed');
    const bannerShown = list.filter((e) => e.event_type === 'banner_shown');
    const bannerActions = list.filter((e) => e.event_type === 'banner_action');

    // How users responded to the out-of-date banner.
    const CHOICE_LABELS: Record<string, string> = {
      open_chrome: 'Open in Chrome',
      reload: 'Reload',
      switch_browser: 'How to switch',
      dismiss: 'Dismissed',
    };
    const choiceCounts: Record<string, number> = {};
    for (const e of bannerActions) {
      const key = e.choice || 'unknown';
      choiceCounts[key] = (choiceCounts[key] ?? 0) + 1;
    }
    const choiceRows = Object.entries(choiceCounts)
      .map(([choice, count]) => ({ label: CHOICE_LABELS[choice] ?? choice, count }))
      .sort((a, b) => b.count - a.count);
    const bannerActioned = bannerActions.filter((e) => e.choice && e.choice !== 'dismiss').length;

    // Feature frequency across all gate detections.
    const featureCounts: Record<string, number> = {};
    for (const e of gateMissing) {
      for (const f of e.missing_features ?? []) {
        featureCounts[f] = (featureCounts[f] ?? 0) + 1;
      }
    }
    const featureChart = Object.entries(featureCounts)
      .map(([feature, count]) => ({ feature, count }))
      .sort((a, b) => b.count - a.count);

    // Aggregate by user-agent label.
    type UARow = {
      id: string;
      agent: string;
      detections: number;
      failures: number;
      loaded: number;
      features: string;
      last_seen: string;
    };
    const uaMap = new Map<string, UARow & { featureSet: Set<string>; lastTs: number }>();
    for (const e of list) {
      const key = labelUA(e.user_agent, e.device);
      const cur = uaMap.get(key) ?? {
        id: key, agent: key, detections: 0, failures: 0, loaded: 0,
        features: '', last_seen: '', featureSet: new Set<string>(), lastTs: 0,
      };
      if (e.event_type === 'gate_missing') cur.detections += 1;
      if (e.event_type === 'impl_load_failed') cur.failures += 1;
      if (e.event_type === 'impl_loaded') cur.loaded += 1;
      for (const f of e.missing_features ?? []) cur.featureSet.add(f);
      const ts = new Date(e.created_at).getTime();
      if (ts > cur.lastTs) { cur.lastTs = ts; cur.last_seen = e.created_at; }
      uaMap.set(key, cur);
    }
    const uaRows: UARow[] = Array.from(uaMap.values())
      .map((r) => ({
        id: r.id, agent: r.agent, detections: r.detections, failures: r.failures,
        loaded: r.loaded, features: Array.from(r.featureSet).join(', ') || '—',
        last_seen: r.last_seen,
      }))
      .sort((a, b) => (b.detections + b.failures) - (a.detections + a.failures));

    return {
      totalDevices: uaMap.size,
      gateMissingCount: gateMissing.length,
      implLoadedCount: implLoaded.length,
      implFailedCount: implFailed.length,
      bannerShownCount: bannerShown.length,
      bannerActionRate:
        bannerShown.length > 0
          ? Math.round((bannerActioned / bannerShown.length) * 100)
          : 0,
      choiceRows,
      featureChart,
      uaRows,
    };
  }, [events]);

  const uaColumns: Column<any>[] = [
    { key: 'agent', label: 'User Agent', sortable: true },
    { key: 'detections', label: 'Missing-Feature Detections', sortable: true },
    {
      key: 'failures', label: 'Polyfill Load Failures', sortable: true,
      render: (v) => (
        <span className={Number(v) > 0 ? 'text-red-500 font-semibold' : 'text-muted-foreground'}>{v as number}</span>
      ),
    },
    { key: 'loaded', label: 'Polyfill Loaded OK', sortable: true },
    { key: 'features', label: 'Missing Features', className: 'max-w-[240px] truncate' },
    {
      key: 'last_seen', label: 'Last Seen', sortable: true,
      render: (v) => (v ? formatDistanceToNow(new Date(v as string), { addSuffix: true }) : '—'),
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold">Browser Compatibility</h2>
        <p className="text-sm text-muted-foreground">
          How often old devices hit the runtime-polyfill gate, which features are missing, and where the polyfill fetch fails.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard title="Devices Reporting" value={stats.totalDevices} icon={MonitorSmartphone} loading={isLoading} />
        <KPICard title="Missing-Feature Detections" value={stats.gateMissingCount} icon={PackageX}
          color="bg-amber-500/10 text-amber-600" loading={isLoading} />
        <KPICard title="Polyfill Loaded OK" value={stats.implLoadedCount} icon={PackageCheck}
          color="bg-green-500/10 text-green-600" loading={isLoading} />
        <KPICard title="Polyfill Load Failures" value={stats.implFailedCount} icon={AlertTriangle}
          color="bg-red-500/10 text-red-600" loading={isLoading}
          subtitle={stats.implFailedCount > 0 ? 'Gate path failing — investigate' : 'No gate-path failures'} />
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-2 mb-3">
          <div>
            <h3 className="text-sm font-semibold">Out-of-date banner response</h3>
            <p className="text-xs text-muted-foreground">
              Banner shown {stats.bannerShownCount}× · {stats.bannerActionRate}% took an action
            </p>
          </div>
          <MousePointerClick className="h-5 w-5 text-muted-foreground shrink-0" />
        </div>
        {stats.choiceRows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No banner interactions recorded yet.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {stats.choiceRows.map((c) => (
              <div key={c.label} className="rounded-xl border border-border bg-muted/40 px-3 py-2 min-w-[110px]">
                <p className="text-xs text-muted-foreground">{c.label}</p>
                <p className="text-lg font-bold">{c.count}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <h3 className="text-sm font-semibold mb-3">Most-detected missing features</h3>
        {stats.featureChart.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No missing-feature detections recorded yet — modern devices don't trigger the gate.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(180, stats.featureChart.length * 34)}>
            <BarChart data={stats.featureChart} layout="vertical" margin={{ left: 20, right: 20 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" allowDecimals={false} fontSize={11} />
              <YAxis type="category" dataKey="feature" width={190} fontSize={11} />
              <Tooltip />
              <Bar dataKey="count" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <ExecutiveDataTable
        title="By user agent"
        data={stats.uaRows}
        columns={uaColumns}
        loading={isLoading}
        limit={15}
      />
    </div>
  );
}
