import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { KPICard } from './KPICard';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import {
  PhoneCall, Search, Loader2, CheckCircle2, XCircle, Radio, Wallet, Clock, Coins, RefreshCw,
} from 'lucide-react';
import { format, startOfDay, subDays, startOfMonth } from 'date-fns';

type VoiceCall = {
  id: string;
  created_at: string;
  answered_at: string | null;
  ended_at: string | null;
  at_session_id: string | null;
  staff_name: string | null;
  staff_phone: string | null;
  target_name: string | null;
  target_phone: string | null;
  target_role: string | null;
  target_location: string | null;
  direction: string | null;
  transport: string | null;
  status: string | null;
  hangup_cause: string | null;
  failure_reason: string | null;
  duration_seconds: number | null;
  cost_amount: number | null;
  cost_currency: string | null;
  is_active: boolean | null;
  recording_url: string | null;
};

type VoiceStats = {
  total_calls: number;
  answered: number;
  failed: number;
  active: number;
  total_cost: number;
  total_minutes: number;
  avg_duration_seconds: number;
  avg_cost: number;
  daily: { day: string; calls: number; answered: number; cost: number; minutes: number }[];
  by_status: { status: string; calls: number }[];
};

const PAGE_SIZE = 15;

const RANGE_OPTIONS = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'month', label: 'This month' },
  { value: 'all', label: 'All time' },
];

const FALLBACK_STATUSES = [
  'initiating', 'ringing', 'completed', 'not_answered', 'failed', 'cancelled',
];


function rangeBounds(range: string): { from: string | null; to: string | null } {
  const now = new Date();
  if (range === 'today') return { from: startOfDay(now).toISOString(), to: null };
  if (range === '7d') return { from: startOfDay(subDays(now, 6)).toISOString(), to: null };
  if (range === '30d') return { from: startOfDay(subDays(now, 29)).toISOString(), to: null };
  if (range === 'month') return { from: startOfMonth(now).toISOString(), to: null };
  return { from: null, to: null };
}

function statusTone(status: string | null) {
  const s = (status || '').toLowerCase();
  if (['answered', 'completed', 'bridged'].includes(s)) return 'bg-emerald-500/10 text-emerald-600 border-0';
  if (['ringing', 'in_progress', 'queued', 'dialing'].includes(s)) return 'bg-primary/10 text-primary border-0';
  if (['failed', 'rejected', 'error'].includes(s)) return 'bg-destructive/10 text-destructive border-0';
  if (['busy', 'no_answer', 'cancelled'].includes(s)) return 'bg-amber-500/10 text-amber-600 border-0';
  return 'bg-muted text-muted-foreground border-0';
}

function prettyStatus(s: string | null) {
  if (!s) return 'Unknown';
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtDuration(seconds: number | null) {
  const v = Number(seconds) || 0;
  if (!v) return '—';
  const m = Math.floor(v / 60);
  const s = v % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

function fmtMoney(amount: number | null | undefined, currency = 'UGX') {
  const v = Number(amount) || 0;
  return `${currency} ${v.toLocaleString('en-UG', { maximumFractionDigits: 2 })}`;
}

export function VoiceApiCallLogViewer() {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [range, setRange] = useState('30d');
  const [page, setPage] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search.trim()); setPage(0); }, 350);
    return () => clearTimeout(t);
  }, [search]);

  const bounds = useMemo(() => rangeBounds(range), [range]);


  const { data: stats, isLoading: statsLoading, refetch: refetchStats } = useQuery({
    queryKey: ['voice-call-stats', range],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_voice_call_stats', {
        p_from: bounds.from,
        p_to: bounds.to,
      });
      if (error) throw error;
      return data as unknown as VoiceStats;
    },
    staleTime: 60_000,
  });

  const { data: page_, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['voice-call-log', range, statusFilter, debouncedSearch, page],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_voice_call_log', {
        p_search: debouncedSearch || null,
        p_status: statusFilter,
        p_from: bounds.from,
        p_to: bounds.to,
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
      });
      if (error) throw error;
      const payload = data as unknown as { rows: VoiceCall[]; total: number };
      return { rows: payload?.rows || [], total: Number(payload?.total) || 0 };
    },
    staleTime: 20_000,
  });

  const { data: credits, isLoading: creditsLoading, refetch: refetchCredits } = useQuery({
    queryKey: ['voice-credit-balance'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('voice-credit-balance');
      if (error) throw error;
      return data as { balance_raw?: string; currency?: string | null; amount?: number | null; error?: string };
    },
    staleTime: 120_000,
  });

  const statusOptions = useMemo(() => {
    const seen = new Set<string>();
    (stats?.by_status || []).forEach((s) => { if (s.status) seen.add(String(s.status).toLowerCase()); });
    FALLBACK_STATUSES.forEach((s) => seen.add(s));
    if (statusFilter !== 'all') seen.add(statusFilter);
    return Array.from(seen).sort();
  }, [stats?.by_status, statusFilter]);

  const rows = page_?.rows || [];
  const total = page_?.total || 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const chartData = (stats?.daily || []).map((d) => ({
    day: format(new Date(`${d.day}T00:00:00`), 'dd MMM'),
    calls: d.calls,
    answered: d.answered,
    minutes: d.minutes,
  }));

  const currency = credits?.currency || 'UGX';
  const remaining = credits?.error
    ? 'Unavailable'
    : credits?.amount != null
      ? fmtMoney(credits.amount, currency)
      : credits?.balance_raw || '—';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <PhoneCall className="h-5 w-5 text-primary" />
            Voice API Calls
          </h2>
          <p className="text-sm text-muted-foreground">
            Every call placed through the voice gateway — status, duration, spend and remaining credits.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={range} onValueChange={(v) => { setRange(v); setPage(0); }}>
            <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {RANGE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { refetch(); refetchStats(); refetchCredits(); }}
            disabled={isFetching}
          >
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard
          title="Total Calls"
          value={statsLoading ? '…' : (stats?.total_calls ?? 0).toLocaleString()}
          icon={PhoneCall}
          subtitle={`${stats?.answered ?? 0} answered`}
        />
        <KPICard
          title="Failed / Unanswered"
          value={statsLoading ? '…' : (stats?.failed ?? 0).toLocaleString()}
          icon={XCircle}
          subtitle={`${stats?.active ?? 0} live now`}
        />
        <KPICard
          title="Spend on Calls"
          value={statsLoading ? '…' : fmtMoney(stats?.total_cost)}
          icon={Coins}
          subtitle={`${stats?.total_minutes ?? 0} minutes talked`}
        />
        <KPICard
          title="Remaining Credits"
          value={creditsLoading ? '…' : remaining}
          icon={Wallet}
          subtitle={credits?.error ? 'Gateway balance not reachable' : 'Live gateway balance'}
        />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard
          title="Avg Call Time"
          value={statsLoading ? '…' : fmtDuration(stats?.avg_duration_seconds ?? 0)}
          icon={Clock}
          subtitle="Answered calls only"
        />
        <KPICard
          title="Avg Cost / Call"
          value={statsLoading ? '…' : fmtMoney(stats?.avg_cost)}
          icon={Coins}
          subtitle="Charged calls only"
        />
        <KPICard
          title="Answer Rate"
          value={statsLoading || !stats?.total_calls
            ? '—'
            : `${Math.round(((stats?.answered ?? 0) / stats.total_calls) * 100)}%`}
          icon={CheckCircle2}
          subtitle="Reached the other party"
        />
        <KPICard
          title="Live Calls"
          value={statsLoading ? '…' : (stats?.active ?? 0).toLocaleString()}
          icon={Radio}
          subtitle="Currently connected"
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Daily call volume</CardTitle>
        </CardHeader>
        <CardContent className="h-[260px]">
          {chartData.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
              No calls in this period.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="day" fontSize={11} />
                <YAxis fontSize={11} />
                <Tooltip />
                <Legend />
                <Bar dataKey="calls" name="Calls" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                <Bar dataKey="answered" name="Answered" fill="hsl(var(--chart-2, var(--primary)))" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {(stats?.by_status?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-2">
          {stats!.by_status.map((s) => (
            <Badge key={s.status} className={statusTone(s.status)}>
              {prettyStatus(s.status)} · {s.calls.toLocaleString()}
            </Badge>
          ))}
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-base">
              Call log
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {total.toLocaleString()} record{total === 1 ? '' : 's'}
              </span>
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                  placeholder="Name, phone, role or session id"
                  className="pl-8 w-[260px]"
                />
              </div>
              <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(0); }}>
                <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {statusOptions.map((s) => (
                    <SelectItem key={s} value={s}>{prettyStatus(s)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-12 flex items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading calls…
            </div>
          ) : rows.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">No calls match these filters.</div>
          ) : (
            <ScrollArea className="w-full">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-muted-foreground border-b">
                    <th className="py-2 pr-3 font-medium">When</th>
                    <th className="py-2 pr-3 font-medium">Called</th>
                    <th className="py-2 pr-3 font-medium">By</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 pr-3 font-medium">Duration</th>
                    <th className="py-2 pr-3 font-medium text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b last:border-0 align-top">
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <div>{format(new Date(r.created_at), 'dd MMM HH:mm')}</div>
                        <div className="text-xs text-muted-foreground">
                          {r.transport || r.direction || 'voice'}
                        </div>
                      </td>
                      <td className="py-2 pr-3">
                        <div className="font-medium">{r.target_name || 'Unknown'}</div>
                        <div className="text-xs text-muted-foreground">
                          {r.target_phone || '—'}{r.target_role ? ` · ${prettyStatus(r.target_role)}` : ''}
                        </div>
                      </td>
                      <td className="py-2 pr-3">
                        <div>{r.staff_name || '—'}</div>
                        <div className="text-xs text-muted-foreground">{r.staff_phone || ''}</div>
                      </td>
                      <td className="py-2 pr-3">
                        <Badge className={statusTone(r.status)}>{prettyStatus(r.status)}</Badge>
                        {(r.hangup_cause || r.failure_reason) && (
                          <div className="text-xs text-muted-foreground mt-1 max-w-[220px] truncate">
                            {r.failure_reason || r.hangup_cause}
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">{fmtDuration(r.duration_seconds)}</td>
                      <td className="py-2 pr-3 text-right whitespace-nowrap">
                        {r.cost_amount ? fmtMoney(r.cost_amount, r.cost_currency || 'UGX') : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollArea>
          )}

          <div className="flex items-center justify-between pt-4">
            <div className="text-xs text-muted-foreground">
              Page {page + 1} of {pageCount} · {PAGE_SIZE} per page
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page + 1 >= pageCount}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
