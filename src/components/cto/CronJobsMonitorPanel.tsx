import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, formatDistanceToNow } from 'date-fns';
import { Loader2, RefreshCw, Search } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';

type Health = 'healthy' | 'warning' | 'failing' | 'inactive' | 'no_runs';

interface CronJobRow {
  jobid: number;
  jobname: string;
  schedule: string;
  active: boolean;
  database: string;
  username: string;
  target_type: 'edge_function' | 'sql';
  target: string;
  command: string;
  last_status: string | null;
  last_start: string | null;
  last_end: string | null;
  last_duration_ms: number | null;
  last_message: string | null;
  runs_24h: number;
  failed_24h: number;
  runs_7d: number;
  failed_7d: number;
  avg_duration_ms: number | null;
  max_duration_ms: number | null;
  last_failed_at: string | null;
  health: Health;
}

const HEALTH_LABEL: Record<Health, string> = {
  healthy: 'Healthy', warning: 'Recent failures', failing: 'Failing', inactive: 'Inactive', no_runs: 'No runs (7d)',
};
const HEALTH_CLASS: Record<Health, string> = {
  healthy: 'bg-success/10 text-success border-success/30',
  warning: 'bg-warning/10 text-warning border-warning/30',
  failing: 'bg-destructive/10 text-destructive border-destructive/30',
  inactive: 'bg-muted text-muted-foreground border-border',
  no_runs: 'bg-warning/10 text-warning border-warning/30',
};

const fmtMs = (ms: number | null) =>
  ms == null ? '—' : ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60000).toFixed(1)} min`;
const fmtWhen = (d: string | null) => (d ? `${formatDistanceToNow(new Date(d), { addSuffix: true })}` : '—');

export default function CronJobsMonitorPanel() {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Health | 'all'>('all');
  const [selected, setSelected] = useState<CronJobRow | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['cto-cron-jobs-overview'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('cto_cron_jobs_overview');
      if (error) throw error;
      return data as unknown as { jobs: CronJobRow[]; as_at: string };
    },
    staleTime: 60_000,
  });

  const jobs = data?.jobs ?? [];
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: jobs.length };
    jobs.forEach((j) => { c[j.health] = (c[j.health] ?? 0) + 1; });
    return c;
  }, [jobs]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return jobs.filter((j) => (filter === 'all' || j.health === filter)
      && (!q || j.jobname.toLowerCase().includes(q) || j.target.toLowerCase().includes(q)));
  }, [jobs, filter, search]);

  const filters: (Health | 'all')[] = ['all', 'failing', 'warning', 'no_runs', 'inactive', 'healthy'];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Scheduled Jobs</h2>
          <p className="text-xs text-muted-foreground">
            Every scheduled job, its health, last run, run time and what it triggers. Stats cover the last 7 days.
            {data?.as_at && ` As at ${format(new Date(data.as_at), 'd MMM yyyy, HH:mm')}.`}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {filters.map((f) => (
          <button key={f} type="button" onClick={() => setFilter(f)}
            className={`rounded-xl border bg-card p-3 text-left transition-colors ${filter === f ? 'border-primary ring-1 ring-primary' : 'hover:bg-muted/50'}`}>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{f === 'all' ? 'All jobs' : HEALTH_LABEL[f]}</p>
            <p className="text-2xl font-bold tabular-nums">{counts[f] ?? 0}</p>
          </button>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm">{rows.length} job(s)</CardTitle>
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search job or target" className="pl-8" />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : error ? (
            <p className="p-4 text-sm text-destructive">Could not load scheduled jobs: {(error as Error).message}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Job</th><th className="px-3 py-2">Health</th><th className="px-3 py-2">Schedule</th>
                    <th className="px-3 py-2">Triggers</th><th className="px-3 py-2">Last run</th><th className="px-3 py-2">Last took</th>
                    <th className="px-3 py-2">Avg / Max</th><th className="px-3 py-2">Runs 24h</th><th className="px-3 py-2">Failed 7d</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((j) => (
                    <tr key={j.jobid} onClick={() => setSelected(j)} className="cursor-pointer border-b last:border-0 hover:bg-muted/40">
                      <td className="px-3 py-2 font-medium">{j.jobname}</td>
                      <td className="px-3 py-2"><Badge variant="outline" className={HEALTH_CLASS[j.health]}>{HEALTH_LABEL[j.health]}</Badge></td>
                      <td className="px-3 py-2 font-mono text-xs">{j.schedule}</td>
                      <td className="max-w-[260px] px-3 py-2">
                        <span className="text-[10px] uppercase text-muted-foreground">{j.target_type === 'edge_function' ? 'Function' : 'SQL'}</span>
                        <p className="truncate font-mono text-xs">{j.target}</p>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs">{fmtWhen(j.last_start)}</td>
                      <td className="px-3 py-2 tabular-nums text-xs">{fmtMs(j.last_duration_ms)}</td>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums text-xs">{fmtMs(j.avg_duration_ms)} / {fmtMs(j.max_duration_ms)}</td>
                      <td className="px-3 py-2 tabular-nums text-xs">{j.runs_24h}</td>
                      <td className={`px-3 py-2 tabular-nums text-xs ${j.failed_7d > 0 ? 'font-semibold text-destructive' : ''}`}>{j.failed_7d}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {selected && (
            <>
              <SheetHeader><SheetTitle className="break-words">{selected.jobname}</SheetTitle></SheetHeader>
              <div className="mt-4 space-y-4 text-sm">
                <Badge variant="outline" className={HEALTH_CLASS[selected.health]}>{HEALTH_LABEL[selected.health]}</Badge>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                  {([
                    ['Job ID', selected.jobid], ['Active', selected.active ? 'Yes' : 'No'],
                    ['Schedule', selected.schedule], ['Runs as', selected.username],
                    ['Last status', selected.last_status ?? '—'],
                    ['Last started', selected.last_start ? format(new Date(selected.last_start), 'd MMM yyyy, HH:mm:ss') : '—'],
                    ['Last ended', selected.last_end ? format(new Date(selected.last_end), 'd MMM yyyy, HH:mm:ss') : '—'],
                    ['Last took', fmtMs(selected.last_duration_ms)],
                    ['Average run', fmtMs(selected.avg_duration_ms)], ['Longest run', fmtMs(selected.max_duration_ms)],
                    ['Runs 24h / 7d', `${selected.runs_24h} / ${selected.runs_7d}`],
                    ['Failed 24h / 7d', `${selected.failed_24h} / ${selected.failed_7d}`],
                    ['Last failure', fmtWhen(selected.last_failed_at)],
                  ] as [string, string | number][]).map(([k, v]) => (
                    <div key={k}><dt className="text-xs text-muted-foreground">{k}</dt><dd className="font-medium break-words">{v}</dd></div>
                  ))}
                </dl>
                {selected.last_message && (
                  <div><p className="mb-1 text-xs text-muted-foreground">Last run message</p>
                    <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs">{selected.last_message}</pre></div>
                )}
                <div><p className="mb-1 text-xs text-muted-foreground">What it runs</p>
                  <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs">{selected.command}</pre></div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
