import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { KPICard } from '@/components/executive/KPICard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { toast } from '@/hooks/use-toast';
import {
  ResponsiveContainer, ComposedChart, Area, Bar, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend,
} from 'recharts';
import {
  Banknote, TrendingDown, AlertTriangle, CheckCircle2, XCircle,
  Wallet, Loader2, BellRing, Percent, Users, CalendarClock, Sparkles, CalendarDays, Search, X,
  PauseCircle, PlayCircle,
} from 'lucide-react';
import { format, subDays, startOfMonth, isSameDay } from 'date-fns';
import AdvancePauseDialog from '@/components/advances/AdvancePauseDialog';

const num = (v: any) => Number(v ?? 0);

interface MonitorRow {
  advance_id: string;
  agent_id: string;
  full_name: string | null;
  phone: string | null;
  avatar_url: string | null;
  status: string;
  principal: number;
  outstanding_balance: number;
  arrears_balance: number;
  access_fee: number;
  scheduled_daily: number;
  issued_at: string;
  expires_at: string;
  is_overdue: boolean;
  withdrawable: number;
  repaid_today: number;
  deduction_status_today: string | null;
  paid_today: boolean;
  repaid_window: number;
  missed_days_window: number;
  paid_days_window: number;
  last_deduction_date: string | null;
  last_deduction_amount: number | null;
  collections_today: number;
  collections_count_today: number;
}

const initials = (name?: string | null) =>
  (name || '?').split(' ').map((s) => s[0]).slice(0, 2).join('').toUpperCase();

export function AgentAdvanceRepaymentMonitor() {
  const [days] = useState(7);
  const [remindingId, setRemindingId] = useState<string | null>(null);
  const [bulkSending, setBulkSending] = useState(false);
  const [search, setSearch] = useState('');
  const [pauseTarget, setPauseTarget] = useState<{ id: string; name: string | null; paused: boolean } | null>(null);

  const { data: rows, isLoading, refetch } = useQuery({
    queryKey: ['agent-advance-repayment-monitor', days],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_advance_repayment_monitor', { _days: days });
      if (error) throw error;
      return (data || []) as MonitorRow[];
    },
    staleTime: 60_000,
    refetchOnMount: 'always',
  });

  // Qualifying agent base — same source of truth the Agent Ops dashboard
  // and the daily email report use. Adoption = agents with a live advance /
  // qualifying agent base.
  const { data: qualifyingAgentCount } = useQuery({
    queryKey: ['agent-advance-monitor-qualifying-count'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('agent_ops_qualifying_agent_ids');
      if (error) throw error;
      const ids = ((data || []) as Array<{ agent_id: string }>).map((r) => r.agent_id).filter(Boolean);
      return new Set(ids).size;
    },
    staleTime: 5 * 60_000,
  });

  // Pause state lives on `agent_advances` — the monitor RPC doesn't carry it.
  const { data: pausedMap } = useQuery({
    queryKey: ['agent-advance-paused-map'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_advances')
        .select('id, pause_reason, paused_at')
        .eq('deduction_paused', true);
      if (error) throw error;
      const map: Record<string, { reason: string | null; at: string | null }> = {};
      (data || []).forEach((r: any) => { map[r.id] = { reason: r.pause_reason, at: r.paused_at }; });
      return map;
    },
    staleTime: 30_000,
  });
  const paused = pausedMap || {};

  // Ledger for the repayment-rate + collection + interest trend (last ~35 days).
  const { data: ledger } = useQuery({
    queryKey: ['agent-advance-repayment-trend'],
    queryFn: async () => {
      const since = format(subDays(new Date(), 35), 'yyyy-MM-dd');
      const { data, error } = await supabase
        .from('agent_advance_ledger')
        .select('date, amount_deducted, interest_accrued, deduction_status')
        .gte('date', since)
        .order('date', { ascending: true });
      if (error) throw error;
      return data || [];
    },
    staleTime: 60_000,
  });

  const trend = useMemo(() => {
    const byDay: Record<string, { collected: number; interest: number; paid: number; total: number }> = {};
    for (const r of ledger || []) {
      const d = String((r as any).date);
      byDay[d] ??= { collected: 0, interest: 0, paid: 0, total: 0 };
      byDay[d].collected += num((r as any).amount_deducted);
      byDay[d].interest += num((r as any).interest_accrued);
      byDay[d].total += 1;
      if ((r as any).deduction_status === 'full' || (r as any).deduction_status === 'partial') byDay[d].paid += 1;
    }
    return Object.entries(byDay)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .slice(-14)
      .map(([date, v]) => ({
        date: format(new Date(date), 'MMM d'),
        collected: v.collected,
        interest: v.interest,
        rate: v.total > 0 ? Math.round((v.paid / v.total) * 100) : 0,
      }));
  }, [ledger]);

  // Interest revenue rollups: today + month-to-date. `interest_accrued` is the
  // interest Welile recognises on that ledger day (i.e. what the platform has
  // actually made from the outstanding advance for that day).
  const revenue = useMemo(() => {
    const today = new Date();
    const mStart = startOfMonth(today);
    let interestToday = 0, interestMTD = 0, collectedMTD = 0;
    for (const r of ledger || []) {
      const d = new Date(String((r as any).date));
      const iAcc = num((r as any).interest_accrued);
      const amt = num((r as any).amount_deducted);
      if (isSameDay(d, today)) interestToday += iAcc;
      if (d >= mStart) { interestMTD += iAcc; collectedMTD += amt; }
    }
    const daysElapsed = Math.max(1, today.getDate());
    return {
      interestToday,
      interestMTD,
      collectedMTD,
      dailyAvgInterest: interestMTD / daysElapsed,
    };
  }, [ledger]);

  const stats = useMemo(() => {
    const list = rows || [];
    const q = search.trim().toLowerCase();
    const matchesQuery = (r: MonitorRow) => {
      if (!q) return true;
      return (
        String(r.full_name || '').toLowerCase().includes(q) ||
        String(r.phone || '').toLowerCase().includes(q) ||
        String(r.status || '').toLowerCase().includes(q)
      );
    };
    const visible = list.filter(matchesQuery);
    const paid = visible.filter((r) => r.paid_today);
    const unpaid = visible.filter((r) => !r.paid_today);
    return {
      total: list.length,
      visibleTotal: visible.length,
      paidCount: paid.length,
      unpaidCount: unpaid.length,
      collectedToday: paid.reduce((s, r) => s + num(r.repaid_today), 0),
      totalOutstanding: visible.reduce((s, r) => s + num(r.outstanding_balance), 0),
      totalArrears: visible.reduce((s, r) => s + num(r.arrears_balance), 0),
      rateToday: visible.length ? Math.round((paid.length / visible.length) * 100) : 0,
      unpaid,
      paid,
    };
  }, [rows, search]);

  const adoptionPct = useMemo(() => {
    const base = qualifyingAgentCount || 0;
    if (!base) return 0;
    return Math.round((stats.total / base) * 1000) / 10;
  }, [qualifyingAgentCount, stats.total]);

  const sendReminder = async (agentIds: string[], singleId?: string) => {
    if (!agentIds.length) return;
    if (singleId) setRemindingId(singleId); else setBulkSending(true);
    try {
      const { data, error } = await supabase.functions.invoke('send-advance-payment-reminder', {
        body: { agent_ids: agentIds },
      });
      if (error) throw error;
      toast({ title: 'Reminders sent', description: `${data?.sent ?? 0} sent, ${data?.failed ?? 0} failed.` });
    } catch (e: any) {
      toast({ title: 'Could not send reminders', description: e?.message ?? 'Try again', variant: 'destructive' });
    } finally {
      setRemindingId(null); setBulkSending(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-base font-bold flex items-center gap-2">
            <TrendingDown className="h-4 w-4 text-emerald-600" /> Advance Repayment Monitor
          </h3>
          <p className="text-xs text-muted-foreground">
            Daily auto-deductions run at 6:00 PM (EAT). Missed days are auto-recovered from the agent's next earnings.
          </p>
        </div>
        {stats.unpaidCount > 0 && (
          <Button
            size="sm"
            variant="destructive"
            disabled={bulkSending}
            onClick={() => sendReminder(stats.unpaid.map((r) => r.agent_id))}
          >
            {bulkSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <BellRing className="h-4 w-4" />}
            Remind {stats.unpaidCount} unpaid
          </Button>
        )}
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KPICard title="Agents with advances" value={stats.total} icon={Users} loading={isLoading} color="bg-purple-100 text-purple-700" />
        {Object.keys(paused).length > 0 && (
          <KPICard
            title="Deductions paused"
            value={Object.keys(paused).length}
            icon={PauseCircle}
            color="bg-amber-100 text-amber-700"
            subtitle="Excluded from all auto-recovery"
          />
        )}
        <KPICard
          title="Advance adoption"
          value={`${adoptionPct}%`}
          icon={Percent}
          loading={isLoading}
          color="bg-fuchsia-100 text-fuchsia-700"
          subtitle={qualifyingAgentCount ? `${stats.total}/${qualifyingAgentCount.toLocaleString()} qualifying agents` : 'Loading base…'}
        />
        <KPICard title="Repaid today" value={`${stats.paidCount} · ${formatUGX(stats.collectedToday)}`} icon={CheckCircle2} loading={isLoading} color="bg-emerald-100 text-emerald-700" subtitle={`${stats.rateToday}% repayment rate`} />
        <KPICard title="Not repaid today" value={stats.unpaidCount} icon={XCircle} loading={isLoading} color="bg-rose-100 text-rose-700" />
        <KPICard title="Total arrears" value={formatUGX(stats.totalArrears)} icon={AlertTriangle} loading={isLoading} color="bg-amber-100 text-amber-700" subtitle={`Outstanding ${formatUGX(stats.totalOutstanding)}`} />
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search agents by name, phone or status…"
          className="pl-9 pr-9"
          autoComplete="off"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-muted text-muted-foreground"
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {search && (
        <p className="text-xs text-muted-foreground -mt-2">
          Showing {stats.visibleTotal} of {stats.total} agents matching “{search}”
        </p>
      )}

      {/* Interest revenue KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard title="Interest today" value={formatUGX(revenue.interestToday)} icon={Sparkles} color="bg-indigo-100 text-indigo-700" subtitle={format(new Date(), 'EEE, d MMM')} />
        <KPICard title="Interest this month" value={formatUGX(revenue.interestMTD)} icon={CalendarDays} color="bg-indigo-100 text-indigo-700" subtitle={`Avg ${formatUGX(revenue.dailyAvgInterest)}/day`} />
        <KPICard title="Collected this month" value={formatUGX(revenue.collectedMTD)} icon={Banknote} color="bg-emerald-100 text-emerald-700" subtitle={format(new Date(), 'MMMM yyyy')} />
        <KPICard title="Principal this month" value={formatUGX(Math.max(0, revenue.collectedMTD - revenue.interestMTD))} icon={TrendingDown} color="bg-muted text-muted-foreground" subtitle="Collected − interest" />
      </div>

      {/* Trend chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2"><Percent className="h-4 w-4 text-emerald-600" /> Repayment rate, collections & interest (14 days)</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={trend}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="left" tick={{ fontSize: 11 }} tickFormatter={(v) => `${v}%`} domain={[0, 100]} />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} tickFormatter={(v) => v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${(v / 1e3).toFixed(0)}K`} />
              <Tooltip formatter={(v: any, n: any) => n === 'Repayment rate' ? `${v}%` : formatUGX(Number(v))} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area yAxisId="right" type="monotone" dataKey="collected" name="Collected" fill="#059669" stroke="#059669" fillOpacity={0.15} />
              <Bar yAxisId="right" dataKey="collected" name="Collected" barSize={14} fill="#059669" fillOpacity={0.35} />
              <Bar yAxisId="right" dataKey="interest" name="Interest earned" barSize={14} fill="#6366f1" fillOpacity={0.7} />
              <Line yAxisId="left" type="monotone" dataKey="rate" name="Repayment rate" stroke="#7c3aed" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Not repaid today */}
        <Card className="border-rose-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-rose-700">
              <XCircle className="h-4 w-4" /> Not repaid today ({stats.unpaidCount})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 max-h-[520px] overflow-y-auto">
            {isLoading && <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}
            {!isLoading && stats.unpaid.length === 0 && <p className="text-xs text-muted-foreground py-4 text-center">Everyone with an advance has repaid today. 🎉</p>}
            {stats.unpaid.map((r) => (
              <AgentRepaymentRow
                key={r.advance_id}
                r={r}
                tone="unpaid"
                pausedInfo={paused[r.advance_id]}
                onTogglePause={() => setPauseTarget({ id: r.advance_id, name: r.full_name, paused: !!paused[r.advance_id] })}
                onRemind={() => sendReminder([r.agent_id], r.advance_id)}
                reminding={remindingId === r.advance_id}
              />
            ))}
          </CardContent>
        </Card>

        {/* Repaid today */}
        <Card className="border-emerald-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-emerald-700">
              <CheckCircle2 className="h-4 w-4" /> Repaid today ({stats.paidCount})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 max-h-[520px] overflow-y-auto">
            {isLoading && <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}
            {!isLoading && stats.paid.length === 0 && <p className="text-xs text-muted-foreground py-4 text-center">No repayments collected yet today.</p>}
            {stats.paid.map((r) => (
              <AgentRepaymentRow
                key={r.advance_id}
                r={r}
                tone="paid"
                pausedInfo={paused[r.advance_id]}
                onTogglePause={() => setPauseTarget({ id: r.advance_id, name: r.full_name, paused: !!paused[r.advance_id] })}
              />
            ))}
          </CardContent>
        </Card>
      </div>

      <AdvancePauseDialog
        advanceId={pauseTarget?.id ?? null}
        agentName={pauseTarget?.name ?? null}
        isPaused={!!pauseTarget?.paused}
        open={!!pauseTarget}
        onOpenChange={(o) => { if (!o) setPauseTarget(null); }}
        invalidateKeys={['agent-advance-paused-map', 'agent-advance-repayment-monitor', 'cfo-outstanding-advances']}
      />
    </div>
  );
}

function AgentRepaymentRow({ r, tone, onRemind, reminding, pausedInfo, onTogglePause }: {
  r: MonitorRow; tone: 'paid' | 'unpaid'; onRemind?: () => void; reminding?: boolean;
  pausedInfo?: { reason: string | null; at: string | null };
  onTogglePause?: () => void;
}) {
  const isPaused = !!pausedInfo;
  return (
    <div className={`rounded-xl border bg-card p-2.5 flex items-start gap-2.5 ${isPaused ? 'border-amber-400/60' : 'border-border'}`}>
      <Avatar className="h-9 w-9 shrink-0">
        <AvatarImage src={r.avatar_url ?? undefined} />
        <AvatarFallback className="text-xs">{initials(r.full_name)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm font-semibold truncate">{r.full_name || 'Unknown agent'}</span>
          {r.is_overdue && <Badge variant="destructive" className="text-[9px] px-1 py-0">OVERDUE</Badge>}
          {r.arrears_balance > 0 && <Badge className="bg-amber-100 text-amber-700 text-[9px] px-1 py-0">Arrears {formatUGX(r.arrears_balance)}</Badge>}
          {isPaused && (
            <Badge className="bg-amber-100 text-amber-800 text-[9px] px-1 py-0 gap-1">
              <PauseCircle className="h-2.5 w-2.5" /> PAUSED
            </Badge>
          )}
        </div>
        <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
          <span className="text-muted-foreground flex items-center gap-1"><Banknote className="h-3 w-3" /> Owed: <b className="text-foreground">{formatUGX(r.outstanding_balance)}</b></span>
          <span className="text-muted-foreground flex items-center gap-1"><Wallet className="h-3 w-3" /> Wallet: <b className={r.withdrawable > 0 ? 'text-emerald-600' : 'text-rose-600'}>{formatUGX(r.withdrawable)}</b></span>
          <span className="text-muted-foreground flex items-center gap-1"><CalendarClock className="h-3 w-3" /> Installment due: <b className="text-foreground">{formatUGX(r.scheduled_daily)}</b></span>
          {tone === 'paid'
            ? <span className="text-emerald-600">Paid today: <b>{formatUGX(r.repaid_today)}</b></span>
            : <span className="text-muted-foreground">Last paid: <b className="text-foreground">{r.last_deduction_date ? format(new Date(r.last_deduction_date), 'MMM d') : '—'}</b></span>}
        </div>
        <div className="mt-1 text-[10px] text-muted-foreground">
          7d: {r.paid_days_window} paid · {r.missed_days_window} missed · collected {formatUGX(r.repaid_window)}
          {r.collections_count_today > 0 && <> · today collected {formatUGX(r.collections_today)} ({r.collections_count_today})</>}
        </div>
        {isPaused && (
          <p className="mt-1 text-[10px] text-amber-700 break-words">
            Paused{pausedInfo?.at ? ` ${format(new Date(pausedInfo.at), 'd MMM')}` : ''}: {pausedInfo?.reason || 'no reason recorded'}
          </p>
        )}
      </div>
      <div className="shrink-0 flex flex-col gap-1">
        {tone === 'unpaid' && onRemind && !isPaused && (
          <Button size="sm" variant="outline" className="h-8" disabled={reminding || !r.phone} onClick={onRemind}>
            {reminding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BellRing className="h-3.5 w-3.5" />}
            <span className="hidden sm:inline ml-1">Remind</span>
          </Button>
        )}
        {onTogglePause && (
          <Button
            size="sm"
            variant={isPaused ? 'default' : 'ghost'}
            className="h-8 text-xs"
            onClick={onTogglePause}
          >
            {isPaused ? <PlayCircle className="h-3.5 w-3.5" /> : <PauseCircle className="h-3.5 w-3.5" />}
            <span className="hidden sm:inline ml-1">{isPaused ? 'Resume' : 'Pause'}</span>
          </Button>
        )}
      </div>
    </div>
  );
}