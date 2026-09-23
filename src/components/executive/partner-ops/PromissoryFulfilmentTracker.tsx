import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import { CheckCircle2, ChevronDown, ChevronUp, Clock, HandCoins, Timer, Users } from 'lucide-react';
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from 'recharts';

/**
 * Read-only "Fulfilled promises" tracker for the Promissory Notes page.
 *
 * A promise is fulfilled when its note reaches status 'activated' (partner's
 * money committed through COO approval + Partner Ops deployment). Everything
 * here is derived from promissory_notes columns that already exist
 * (recorded_on, fulfilment_due_on, approved_at, amount) — no writes, no new
 * backend, no extra financial logic.
 */

interface TrackerNote {
  id: string;
  partner_name: string;
  phone_number: string | null;
  partner_user_id: string | null;
  agent_id: string;
  amount: number;
  status: string;
  recorded_on: string; // date
  fulfilment_due_on: string | null; // date
  approved_at: string | null; // timestamptz
  created_at: string;
}

const dayMs = 86400000;
const asDate = (d: string) => new Date(`${d}T00:00:00`);
const approvedDate = (n: TrackerNote) => (n.approved_at ? n.approved_at.slice(0, 10) : null);

function startOfWeek(d: Date) {
  const x = new Date(d);
  const dow = (x.getDay() + 6) % 7; // Monday start
  x.setDate(x.getDate() - dow);
  x.setHours(0, 0, 0, 0);
  return x;
}

const weekKey = (d: Date) => startOfWeek(d).toISOString().slice(0, 10);

export function PromissoryFulfilmentTracker() {
  const [open, setOpen] = useState(false);

  const { data: notes = [], isLoading, isError, error } = useQuery({
    queryKey: ['promissory-fulfilment-tracker'],
    enabled: open,
    staleTime: 120_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('promissory_notes')
        .select('id, partner_name, phone_number, partner_user_id, agent_id, amount, status, recorded_on, fulfilment_due_on, approved_at, created_at')
        .in('status', ['pending', 'activated'])
        .order('recorded_on', { ascending: false })
        .limit(5000);
      if (error) throw error;
      return (data || []) as TrackerNote[];
    },
  });

  const agentIds = useMemo(
    () => Array.from(new Set(notes.map(n => n.agent_id).filter(Boolean))),
    [notes],
  );

  const { data: agentNames = {} } = useQuery({
    queryKey: ['promissory-fulfilment-agent-names', agentIds],
    enabled: open && agentIds.length > 0,
    staleTime: 300_000,
    queryFn: async () => {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', agentIds);
        if (error) return {};
        const map: Record<string, string> = {};
        for (const p of data || []) map[(p as any).id] = (p as any).full_name || '';
        return map;
      } catch {
        return {};
      }
    },
  });

  const stats = useMemo(() => {
    const fulfilled = notes.filter(n => n.status === 'activated' && n.approved_at);
    const pending = notes.filter(n => n.status === 'pending');

    const promisedTotal = notes.reduce((s, n) => s + Number(n.amount || 0), 0);
    const fulfilledTotal = fulfilled.reduce((s, n) => s + Number(n.amount || 0), 0);
    const openTotal = pending.reduce((s, n) => s + Number(n.amount || 0), 0);

    const withDue = fulfilled.filter(n => n.fulfilment_due_on && approvedDate(n));
    const onTime = withDue.filter(n => asDate(approvedDate(n)!) <= asDate(n.fulfilment_due_on!));

    const daysToFulfil = fulfilled
      .map(n => (asDate(approvedDate(n)!).getTime() - asDate(n.recorded_on).getTime()) / dayMs)
      .filter(d => Number.isFinite(d) && d >= 0);
    const avgDaysToFulfil = daysToFulfil.length
      ? daysToFulfil.reduce((a, b) => a + b, 0) / daysToFulfil.length
      : null;

    // Weekly trend: promised (by recorded_on) vs fulfilled (by approved date)
    const weeks = new Map<string, { week: string; promised: number; fulfilled: number }>();
    const bucket = (key: string) => {
      if (!weeks.has(key)) weeks.set(key, { week: key, promised: 0, fulfilled: 0 });
      return weeks.get(key)!;
    };
    for (const n of notes) {
      if (n.recorded_on) bucket(weekKey(asDate(n.recorded_on))).promised += Number(n.amount || 0);
      const ad = n.status === 'activated' ? approvedDate(n) : null;
      if (ad) bucket(weekKey(asDate(ad))).fulfilled += Number(n.amount || 0);
    }
    const trend = Array.from(weeks.values()).sort((a, b) => a.week.localeCompare(b.week));

    // Per-partner reliability
    const partners = new Map<string, {
      key: string; name: string; promises: number; fulfilled: number;
      onTime: number; withDue: number; daysLateTotal: number; lateCount: number;
      fulfilledValue: number;
    }>();
    for (const n of notes) {
      const key = n.partner_user_id || n.phone_number || n.partner_name.toLowerCase().trim();
      if (!partners.has(key)) {
        partners.set(key, {
          key, name: n.partner_name, promises: 0, fulfilled: 0, onTime: 0,
          withDue: 0, daysLateTotal: 0, lateCount: 0, fulfilledValue: 0,
        });
      }
      const p = partners.get(key)!;
      p.promises += 1;
      if (n.status === 'activated' && n.approved_at) {
        p.fulfilled += 1;
        p.fulfilledValue += Number(n.amount || 0);
        const ad = approvedDate(n)!;
        if (n.fulfilment_due_on) {
          p.withDue += 1;
          const late = Math.round((asDate(ad).getTime() - asDate(n.fulfilment_due_on).getTime()) / dayMs);
          p.daysLateTotal += late;
          p.lateCount += 1;
          if (late <= 0) p.onTime += 1;
        }
      }
    }
    const partnerRows = Array.from(partners.values())
      .filter(p => p.promises >= 1)
      .sort((a, b) => b.fulfilledValue - a.fulfilledValue);

    return {
      totalCount: notes.length,
      fulfilledCount: fulfilled.length,
      pendingCount: pending.length,
      promisedTotal,
      fulfilledTotal,
      openTotal,
      fulfilRateCount: notes.length ? (fulfilled.length / notes.length) * 100 : 0,
      fulfilRateValue: promisedTotal > 0 ? (fulfilledTotal / promisedTotal) * 100 : 0,
      onTimeCount: onTime.length,
      withDueCount: withDue.length,
      avgDaysToFulfil,
      trend,
      partnerRows,
      fulfilledRows: fulfilled
        .slice()
        .sort((a, b) => (approvedDate(b)! || '').localeCompare(approvedDate(a)! || ''))
        .slice(0, 100),
    };
  }, [notes]);

  const fmtPct = (v: number) => `${v.toFixed(0)}%`;

  return (
    <Card className="border-primary/20">
      <CardContent className="p-3 space-y-3">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          className="w-full flex items-center justify-between gap-2 text-left"
        >
          <span className="flex items-center gap-2">
            <HandCoins className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold">Promise fulfilment tracker</span>
            <span className="text-[10px] text-muted-foreground hidden sm:inline">
              how promised money turns into real support
            </span>
          </span>
          {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </button>

        {open && (
          <>
            {isLoading ? (
              <p className="text-xs text-muted-foreground py-4 text-center">Loading fulfilment data…</p>
            ) : isError ? (
              <p className="text-xs text-destructive py-2">
                Could not load fulfilment data: {(error as any)?.message}
              </p>
            ) : (
              <>
                {/* Headline tiles */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                  <div className="rounded-lg border bg-emerald-50 border-emerald-200 p-2.5">
                    <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3" /> Fulfilment rate
                    </p>
                    <p className="text-base font-bold mt-0.5">{fmtPct(stats.fulfilRateCount)}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {stats.fulfilledCount} of {stats.totalCount} promises · {fmtPct(stats.fulfilRateValue)} by value
                    </p>
                  </div>
                  <div className="rounded-lg border bg-sky-50 border-sky-200 p-2.5">
                    <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <Clock className="h-3 w-3" /> On-time fulfilment
                    </p>
                    <p className="text-base font-bold mt-0.5">
                      {stats.withDueCount ? fmtPct((stats.onTimeCount / stats.withDueCount) * 100) : '—'}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {stats.onTimeCount} of {stats.withDueCount} fulfilled by the promised date
                    </p>
                  </div>
                  <div className="rounded-lg border bg-amber-50 border-amber-200 p-2.5">
                    <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <Timer className="h-3 w-3" /> Average wait to fulfil
                    </p>
                    <p className="text-base font-bold mt-0.5">
                      {stats.avgDaysToFulfil === null ? '—' : `${stats.avgDaysToFulfil.toFixed(1)} days`}
                    </p>
                    <p className="text-[10px] text-muted-foreground">from promise recorded to money committed</p>
                  </div>
                  <div className="rounded-lg border bg-violet-50 border-violet-200 p-2.5">
                    <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <HandCoins className="h-3 w-3" /> Fulfilled vs still promised
                    </p>
                    <p className="text-base font-bold mt-0.5">{formatUGX(stats.fulfilledTotal)}</p>
                    <p className="text-[10px] text-muted-foreground">
                      still open: {formatUGX(stats.openTotal)} ({stats.pendingCount} promise{stats.pendingCount === 1 ? '' : 's'})
                    </p>
                  </div>
                </div>

                {/* Trend */}
                {stats.trend.length > 1 && (
                  <div className="rounded-lg border p-2">
                    <p className="text-[11px] font-medium mb-1">Weekly promised vs fulfilled (UGX)</p>
                    <div className="h-52">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={stats.trend} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                          <XAxis
                            dataKey="week"
                            tick={{ fontSize: 10 }}
                            tickFormatter={(w: string) => w.slice(5)}
                          />
                          <YAxis
                            tick={{ fontSize: 10 }}
                            tickFormatter={(v: number) => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(0)}M` : v >= 1_000 ? `${(v / 1_000).toFixed(0)}K` : `${v}`)}
                            width={42}
                          />
                          <Tooltip
                            formatter={(v: any) => formatUGX(Number(v))}
                            labelFormatter={(w: any) => `Week of ${w}`}
                          />
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          <Area type="monotone" dataKey="promised" name="Promised" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.12} strokeWidth={2} />
                          <Line type="monotone" dataKey="fulfilled" name="Fulfilled" stroke="#10b981" strokeWidth={2} dot={false} />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}

                {/* Per-partner reliability */}
                <div className="rounded-lg border p-2">
                  <p className="text-[11px] font-medium mb-1.5 flex items-center gap-1">
                    <Users className="h-3 w-3" /> Partner reliability
                  </p>
                  <div className="max-h-64 overflow-y-auto divide-y">
                    {stats.partnerRows.slice(0, 40).map(p => {
                      const avgLate = p.lateCount ? p.daysLateTotal / p.lateCount : null;
                      return (
                        <div key={p.key} className="py-1.5 flex items-center gap-2 text-xs">
                          <div className="min-w-0 flex-1">
                            <p className="font-medium truncate">{p.name}</p>
                            <p className="text-[10px] text-muted-foreground">
                              {p.fulfilled}/{p.promises} fulfilled
                              {p.withDue > 0 && ` · ${p.onTime}/${p.withDue} on time`}
                              {avgLate !== null && (
                                avgLate > 0
                                  ? ` · avg ${avgLate.toFixed(0)} day${Math.round(avgLate) === 1 ? '' : 's'} late`
                                  : ` · avg ${Math.abs(avgLate).toFixed(0)} day${Math.round(Math.abs(avgLate)) === 1 ? '' : 's'} early`
                              )}
                            </p>
                          </div>
                          <Badge
                            variant="outline"
                            className={cn(
                              'shrink-0 text-[10px]',
                              p.fulfilled === p.promises
                                ? 'border-emerald-300 text-emerald-700'
                                : p.fulfilled === 0
                                  ? 'border-amber-300 text-amber-700'
                                  : 'border-sky-300 text-sky-700',
                            )}
                          >
                            {formatUGX(p.fulfilledValue)}
                          </Badge>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Recently fulfilled */}
                <div className="rounded-lg border p-2">
                  <p className="text-[11px] font-medium mb-1.5">Recently fulfilled promises</p>
                  <div className="max-h-72 overflow-y-auto divide-y">
                    {stats.fulfilledRows.map(n => {
                      const ad = approvedDate(n)!;
                      const late = n.fulfilment_due_on
                        ? Math.round((asDate(ad).getTime() - asDate(n.fulfilment_due_on).getTime()) / dayMs)
                        : null;
                      return (
                        <div key={n.id} className="py-1.5 flex items-center gap-2 text-xs">
                          <div className="min-w-0 flex-1">
                            <p className="font-medium truncate">{n.partner_name}</p>
                            <p className="text-[10px] text-muted-foreground truncate">
                              Agent: {agentNames[n.agent_id] || '—'} · promised {n.recorded_on}
                              {n.fulfilment_due_on && ` · due ${n.fulfilment_due_on}`} · fulfilled {ad}
                            </p>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="font-semibold">{formatUGX(Number(n.amount || 0))}</p>
                            {late !== null && (
                              <p className={cn('text-[10px]', late > 0 ? 'text-amber-600' : 'text-emerald-600')}>
                                {late > 0 ? `${late}d late` : late < 0 ? `${Math.abs(late)}d early` : 'on the day'}
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {stats.fulfilledRows.length === 0 && (
                      <p className="py-3 text-center text-[11px] text-muted-foreground">No fulfilled promises yet.</p>
                    )}
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
