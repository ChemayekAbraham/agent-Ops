import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  BarChart3,
  CalendarDays,
  ChevronRight,
  Clock3,
  Loader2,
  MapPin,
  Phone,
  RefreshCw,
  Search,
  TrendingDown,
  TrendingUp,
  UserRound,
  Users,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { KPICard } from '../KPICard';
import { formatUGX } from '@/lib/rentCalculations';
import { supabase } from '@/integrations/supabase/client';
import { useTenantRepaymentReliability, type ReliabilityRow } from '@/hooks/useTenantRepaymentReliability';

const AGE_BUCKETS = [
  { key: '1-7', label: '1–7 days', min: 1, max: 7 },
  { key: '8-30', label: '8–30 days', min: 8, max: 30 },
  { key: '31-60', label: '31–60 days', min: 31, max: 60 },
  { key: '60+', label: '60+ days', min: 61, max: Number.POSITIVE_INFINITY },
] as const;

type AgeKey = 'all' | (typeof AGE_BUCKETS)[number]['key'];

type Snapshot = {
  period_start: string;
  scheduled_due_ugx: number | null;
  collected_ugx: number | null;
  plan_count: number | null;
};

type ProfileLocation = {
  district: string | null;
  city: string | null;
  region: string | null;
};

const compactUgx = (value: number) => {
  const amount = Math.round(value || 0);
  if (Math.abs(amount) >= 1_000_000) return `UGX ${(amount / 1_000_000).toFixed(1)}M`;
  if (Math.abs(amount) >= 1_000) return `UGX ${Math.round(amount / 1_000)}K`;
  return formatUGX(amount);
};

const ageBucket = (missedDays: number) => AGE_BUCKETS.find((bucket) => missedDays >= bucket.min && missedDays <= bucket.max)?.key ?? 'all';

function useTenantLocations(tenantIds: string[]) {
  return useQuery({
    queryKey: ['tenant-ops-backlog-locations', tenantIds],
    enabled: tenantIds.length > 0,
    staleTime: 300_000,
    queryFn: async () => {
      const chunks: string[][] = [];
      for (let index = 0; index < tenantIds.length; index += 200) chunks.push(tenantIds.slice(index, index + 200));
      const responses = await Promise.all(chunks.map((ids) =>
        supabase.from('profiles').select('id,district,city,region').in('id', ids),
      ));
      const locationMap = new Map<string, ProfileLocation>();
      responses.forEach(({ data, error }) => {
        if (error) throw error;
        (data ?? []).forEach((profile) => locationMap.set(profile.id, {
          district: profile.district,
          city: profile.city,
          region: profile.region,
        }));
      });
      return locationMap;
    },
  });
}

function formatSnapshotDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

export function BacklogAnalysis() {
  const { data, isLoading, isFetching, refetch, error } = useTenantRepaymentReliability(2000);
  const rows = data?.rows ?? [];
  const tenantIds = useMemo(() => rows.map((row) => row.tenant_id), [rows]);
  const { data: locations = new Map(), isLoading: locationsLoading } = useTenantLocations(tenantIds);
  const { data: snapshots = [], isLoading: snapshotsLoading } = useQuery({
    queryKey: ['tenant-ops-backlog-snapshots'],
    staleTime: 300_000,
    queryFn: async (): Promise<Snapshot[]> => {
      const { data: snapshotRows, error: snapshotError } = await supabase
        .from('tppo_period_snapshots')
        .select('period_start,scheduled_due_ugx,collected_ugx,plan_count')
        .eq('granularity', 'day')
        .order('period_start', { ascending: false })
        .limit(45);
      if (snapshotError) throw snapshotError;
      return (snapshotRows ?? []).map((snapshot) => ({
        period_start: snapshot.period_start,
        scheduled_due_ugx: Number(snapshot.scheduled_due_ugx || 0),
        collected_ugx: Number(snapshot.collected_ugx || 0),
        plan_count: Number(snapshot.plan_count || 0),
      })).reverse();
    },
  });

  const [search, setSearch] = useState('');
  const [age, setAge] = useState<AgeKey>('all');
  const [agent, setAgent] = useState('all');
  const [district, setDistrict] = useState('all');
  const [selected, setSelected] = useState<ReliabilityRow | null>(null);

  const enrichedRows = useMemo(() => rows.map((row) => {
    const location = locations.get(row.tenant_id);
    return {
      ...row,
      locationLabel: location?.district || location?.city || location?.region || 'Unmapped',
    };
  }), [rows, locations]);

  const overdueRows = useMemo(() => enrichedRows.filter((row) => row.missed_days > 0), [enrichedRows]);
  const agents = useMemo(() => [...new Set(overdueRows.map((row) => row.agent_name || 'Unassigned'))].sort(), [overdueRows]);
  const districts = useMemo(() => [...new Set(overdueRows.map((row) => row.locationLabel))].sort(), [overdueRows]);

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return overdueRows
      .filter((row) => age === 'all' || ageBucket(row.missed_days) === age)
      .filter((row) => agent === 'all' || (row.agent_name || 'Unassigned') === agent)
      .filter((row) => district === 'all' || row.locationLabel === district)
      .filter((row) => !query || [row.tenant_name, row.tenant_phone, row.agent_name, row.locationLabel]
        .some((value) => (value || '').toLowerCase().includes(query)))
      .sort((a, b) => b.outstanding - a.outstanding);
  }, [age, agent, district, overdueRows, search]);

  const metrics = useMemo(() => ({
    backlog: overdueRows.reduce((sum, row) => sum + row.outstanding, 0),
    affected: overdueRows.length,
    plans: overdueRows.length,
    activeBook: rows.length,
    missedDays: overdueRows.reduce((sum, row) => sum + row.missed_days, 0),
  }), [overdueRows, rows.length]);

  const ageData = useMemo(() => AGE_BUCKETS.map((bucket) => {
    const bucketRows = overdueRows.filter((row) => ageBucket(row.missed_days) === bucket.key);
    return {
      name: bucket.label,
      plans: bucketRows.length,
      backlog: bucketRows.reduce((sum, row) => sum + row.outstanding, 0),
    };
  }), [overdueRows]);

  const agentData = useMemo(() => {
    const map = new Map<string, { agent: string; plans: number; backlog: number }>();
    overdueRows.forEach((row) => {
      const name = row.agent_name || 'Unassigned';
      const current = map.get(name) ?? { agent: name, plans: 0, backlog: 0 };
      current.plans += 1;
      current.backlog += row.outstanding;
      map.set(name, current);
    });
    return [...map.values()].sort((a, b) => b.backlog - a.backlog).slice(0, 12);
  }, [overdueRows]);

  const districtData = useMemo(() => {
    const map = new Map<string, { district: string; plans: number; backlog: number }>();
    overdueRows.forEach((row) => {
      const current = map.get(row.locationLabel) ?? { district: row.locationLabel, plans: 0, backlog: 0 };
      current.plans += 1;
      current.backlog += row.outstanding;
      map.set(row.locationLabel, current);
    });
    return [...map.values()].sort((a, b) => b.backlog - a.backlog).slice(0, 12);
  }, [overdueRows]);

  const trendData = useMemo(() => snapshots.map((snapshot) => ({
    date: formatSnapshotDate(snapshot.period_start),
    gap: Math.max(0, (snapshot.scheduled_due_ugx ?? 0) - (snapshot.collected_ugx ?? 0)),
    plans: snapshot.plan_count ?? 0,
  })), [snapshots]);
  const latestGap = trendData.at(-1)?.gap ?? 0;
  const priorGap = trendData.length > 1 ? trendData.at(-2)?.gap ?? latestGap : latestGap;
  const trendDirection = latestGap <= priorGap ? 'reducing' : 'increasing';

  if (isLoading) return <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>;
  if (error) return <Card className="border-destructive/40 bg-destructive/5"><CardContent className="p-4"><p className="text-sm font-semibold text-destructive">Could not load backlog analysis</p><p className="mt-1 text-xs text-destructive/80">{(error as Error).message}</p></CardContent></Card>;

  return (
    <div className="space-y-3">
      <Card className="border-2 border-primary/30 bg-primary/5">
        <CardContent className="flex flex-wrap items-center gap-3 p-3.5">
          <div className="rounded-lg bg-primary/15 p-2"><AlertTriangle className="h-5 w-5 text-primary" /></div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-black">Overdue Repayment Backlog</p>
            <p className="text-[11px] leading-snug text-muted-foreground">Recovery view of active rent plans that are behind their server-computed daily repayment schedule.</p>
          </div>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <KPICard title="Overdue backlog" value={formatUGX(metrics.backlog)} icon={AlertTriangle} color="bg-destructive/10 text-destructive" subtitle="Outstanding on behind plans" />
        <KPICard title="Affected tenants / primary plans" value={metrics.affected.toLocaleString()} icon={Users} color="bg-amber-500/10 text-amber-600" subtitle={`${metrics.activeBook.toLocaleString()} active plans on book`} />
        <KPICard title="Missed repayment days" value={metrics.missedDays.toLocaleString()} icon={CalendarDays} color="bg-primary/10 text-primary" subtitle="Cumulative across affected plans" />
        <KPICard title="Collection gap trend" value={compactUgx(latestGap)} icon={trendDirection === 'reducing' ? TrendingDown : TrendingUp} color={trendDirection === 'reducing' ? 'bg-emerald-500/10 text-emerald-600' : 'bg-destructive/10 text-destructive'} subtitle={`Daily portfolio gap is ${trendDirection}`} />
      </div>

      <div className="rounded-lg border border-border bg-muted/30 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tenant, phone, agent or location" className="h-9 pl-9" />
          </div>
          <Select value={age} onValueChange={(value) => setAge(value as AgeKey)}>
            <SelectTrigger className="h-9 w-full text-xs sm:w-[150px]"><SelectValue placeholder="Backlog age" /></SelectTrigger>
            <SelectContent><SelectItem value="all">All ages</SelectItem>{AGE_BUCKETS.map((bucket) => <SelectItem key={bucket.key} value={bucket.key}>{bucket.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={agent} onValueChange={setAgent}>
            <SelectTrigger className="h-9 w-full text-xs sm:w-[170px]"><SelectValue placeholder="Agent" /></SelectTrigger>
            <SelectContent><SelectItem value="all">All agents</SelectItem>{agents.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={district} onValueChange={setDistrict}>
            <SelectTrigger className="h-9 w-full text-xs sm:w-[160px]"><SelectValue placeholder="District" /></SelectTrigger>
            <SelectContent><SelectItem value="all">All locations</SelectItem>{districts.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent>
          </Select>
          <Badge variant="secondary" className="h-7 text-[10px]">{filteredRows.length.toLocaleString()} shown</Badge>
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader className="p-3 pb-1"><CardTitle className="flex items-center gap-2 text-xs font-bold"><Clock3 className="h-4 w-4 text-primary" /> Backlog by missed-day age</CardTitle></CardHeader>
          <CardContent className="p-3 pt-2"><div className="h-[210px]">{ageData.length ? <ResponsiveContainer width="100%" height="100%"><BarChart data={ageData} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}><CartesianGrid strokeDasharray="3 3" className="stroke-border" /><XAxis dataKey="name" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 10 }} tickFormatter={(value) => compactUgx(Number(value)).replace('UGX ', '')} /><Tooltip formatter={(value: number, name: string) => [name === 'backlog' ? formatUGX(value) : value, name === 'backlog' ? 'Backlog' : 'Plans']} /><Bar dataKey="backlog" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} /></BarChart></ResponsiveContainer> : <EmptyState />}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="p-3 pb-1"><CardTitle className="flex items-center gap-2 text-xs font-bold"><BarChart3 className="h-4 w-4 text-primary" /> Collection gap trend</CardTitle></CardHeader>
          <CardContent className="p-3 pt-2"><div className="h-[210px]">{snapshotsLoading ? <LoadingState /> : trendData.length ? <ResponsiveContainer width="100%" height="100%"><LineChart data={trendData} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}><CartesianGrid strokeDasharray="3 3" className="stroke-border" /><XAxis dataKey="date" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 10 }} tickFormatter={(value) => compactUgx(Number(value)).replace('UGX ', '')} /><Tooltip formatter={(value: number) => formatUGX(value)} /><Line type="monotone" dataKey="gap" name="Daily gap" stroke="hsl(var(--destructive))" strokeWidth={2} dot={false} /></LineChart></ResponsiveContainer> : <EmptyState />}</div><p className="mt-1 text-[10px] text-muted-foreground">Uses existing daily portfolio snapshots: scheduled due less collected. This is a collection-gap trend, not a second overdue-balance calculation.</p></CardContent>
        </Card>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <RollupCard title="Backlog by agent" icon={<UserRound className="h-4 w-4 text-primary" />} rows={agentData} nameKey="agent" />
        <RollupCard title="Backlog by district / location" icon={<MapPin className="h-4 w-4 text-primary" />} rows={districtData} nameKey="district" />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between p-3 pb-2"><div><CardTitle className="text-xs font-bold">Recovery queue</CardTitle><p className="mt-0.5 text-[10px] text-muted-foreground">Highest outstanding balances among the loaded active plans. Select a row for the recovery context.</p></div><Badge variant="outline" className="text-[10px]">{filteredRows.length.toLocaleString()} overdue</Badge></CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-xs">
              <thead><tr className="border-y bg-muted/30 text-left text-[10px] uppercase tracking-wide text-muted-foreground"><th className="p-2.5">Tenant</th><th className="p-2.5">Agent</th><th className="p-2.5">Location</th><th className="p-2.5">Age</th><th className="p-2.5 text-right">Outstanding</th><th className="p-2.5 text-right">Daily</th><th className="p-2.5" /></tr></thead>
              <tbody>{filteredRows.slice(0, 250).map((row) => <tr key={row.rent_request_id} className="border-b transition-colors hover:bg-muted/40"><td className="p-2.5"><button type="button" className="text-left font-semibold hover:text-primary" onClick={() => setSelected(row)}>{row.tenant_name || 'Unnamed tenant'}<span className="mt-0.5 block font-normal text-muted-foreground">{row.tenant_phone || 'No phone'}</span></button></td><td className="p-2.5">{row.agent_name || 'Unassigned'}</td><td className="p-2.5">{row.locationLabel}</td><td className="p-2.5"><Badge variant={row.missed_days >= 8 ? 'destructive' : 'secondary'} className="text-[10px]">{row.missed_days}d</Badge></td><td className="p-2.5 text-right font-mono font-bold">{formatUGX(row.outstanding)}</td><td className="p-2.5 text-right font-mono">{formatUGX(row.daily)}</td><td className="p-2.5 text-right"><Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Open ${row.tenant_name || 'tenant'} details`} onClick={() => setSelected(row)}><ChevronRight className="h-4 w-4" /></Button></td></tr>)}</tbody>
            </table>
          </div>
          {filteredRows.length > 250 && <p className="p-3 text-[10px] text-muted-foreground">Showing the top 250 balances. Narrow the filters to focus the recovery queue.</p>}
          {!filteredRows.length && <EmptyState />}
        </CardContent>
      </Card>

      <p className="text-[10px] text-muted-foreground">Source: the existing server-computed repayment reliability result backed by the daily eligibility view and agent collections. The active cohort excludes fully repaid, reversed, paused and non-paying plans. Closed or ended backlog is not included because it is not part of that authoritative active view. {locationsLoading ? 'Loading available location fields…' : ''}</p>

      <Sheet open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
          {selected && <>
            <SheetHeader><SheetTitle>{selected.tenant_name || 'Unnamed tenant'}</SheetTitle><SheetDescription>Recovery detail from the current active rent plan.</SheetDescription></SheetHeader>
            <div className="mt-5 space-y-4">
              <div className="flex flex-wrap gap-2"><Badge variant="destructive">{selected.missed_days} missed days</Badge><Badge variant="outline">{selected.band}</Badge><Badge variant="secondary">{selected.status || 'Active'}</Badge></div>
              {selected.tenant_phone && <a href={`tel:${selected.tenant_phone}`} className="flex items-center gap-2 rounded-lg border p-3 text-sm font-semibold hover:bg-muted"><Phone className="h-4 w-4 text-primary" /> Call {selected.tenant_phone}</a>}
              <div className="grid grid-cols-2 gap-2"><Detail label="Outstanding" value={formatUGX(selected.outstanding)} /><Detail label="Daily repayment" value={formatUGX(selected.daily)} /><Detail label="Rent amount" value={formatUGX(selected.rent_amount)} /><Detail label="Plan total" value={formatUGX(selected.total)} /><Detail label="Paid days" value={`${selected.paid_days} / ${selected.expected_days}`} /><Detail label="Last payment" value={selected.last_pay_date || 'Never'} /><Detail label="Agent" value={selected.agent_name || 'Unassigned'} /><Detail label="Location" value={locations.get(selected.tenant_id)?.district || locations.get(selected.tenant_id)?.city || locations.get(selected.tenant_id)?.region || 'Unmapped'} /></div>
              <div className="rounded-lg border bg-muted/30 p-3 text-xs"><p className="font-bold">Suggested follow-up context</p><p className="mt-1 text-muted-foreground">The plan is {selected.days_since_last_pay === null ? 'not yet recorded with a payment' : `${selected.days_since_last_pay} day(s) from its last recorded payment`} and has {selected.longest_gap} day(s) as its longest payment gap.</p></div>
            </div>
          </>}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function RollupCard({ title, icon, rows, nameKey }: { title: string; icon: React.ReactNode; rows: Array<{ agent?: string; district?: string; plans: number; backlog: number }>; nameKey: 'agent' | 'district' }) {
  return <Card><CardHeader className="p-3 pb-1"><CardTitle className="flex items-center gap-2 text-xs font-bold">{icon}{title}</CardTitle></CardHeader><CardContent className="p-3 pt-1"><div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr className="border-b text-left text-[10px] uppercase tracking-wide text-muted-foreground"><th className="p-2">{nameKey === 'agent' ? 'Agent' : 'Location'}</th><th className="p-2 text-right">Plans</th><th className="p-2 text-right">Backlog</th></tr></thead><tbody>{rows.map((row) => <tr key={row[nameKey]} className="border-b last:border-0"><td className="max-w-[180px] truncate p-2 font-medium">{row[nameKey]}</td><td className="p-2 text-right">{row.plans}</td><td className="p-2 text-right font-mono font-semibold">{formatUGX(row.backlog)}</td></tr>)}{!rows.length && <tr><td colSpan={3}><EmptyState /></td></tr>}</tbody></table></div></CardContent></Card>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border bg-muted/20 p-2.5"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-1 break-words text-sm font-bold">{value}</p></div>;
}

function EmptyState() {
  return <div className="flex items-center justify-center gap-2 p-8 text-xs text-muted-foreground"><AlertTriangle className="h-4 w-4" /> No matching backlog data.</div>;
}

function LoadingState() {
  return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>;
}
