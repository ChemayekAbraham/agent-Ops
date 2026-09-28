import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Download, FileBarChart, Phone, Pencil, Check, X, Loader2 } from 'lucide-react';
import { format, startOfWeek, endOfWeek, subWeeks, startOfMonth, endOfMonth, differenceInCalendarDays } from 'date-fns';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { calculateRentRepayment } from '@/lib/rentCalculations';
import {
  generateAgentAllocationPdf,
  AllocStatus,
  AllocTenantRow,
  AllocAgentBlock,
} from '@/lib/agentAllocationReportPdf';

type RangePreset = 'last-7' | 'this-week' | 'last-week' | 'this-month' | 'all';

const getRange = (preset: RangePreset): { start: Date | null; end: Date } => {
  const now = new Date();
  switch (preset) {
    case 'this-week': return { start: startOfWeek(now, { weekStartsOn: 1 }), end: endOfWeek(now, { weekStartsOn: 1 }) };
    case 'last-week': {
      const lw = subWeeks(now, 1);
      return { start: startOfWeek(lw, { weekStartsOn: 1 }), end: endOfWeek(lw, { weekStartsOn: 1 }) };
    }
    case 'this-month': return { start: startOfMonth(now), end: endOfMonth(now) };
    case 'all': return { start: null, end: now };
    case 'last-7':
    default: {
      const start = new Date(now); start.setDate(start.getDate() - 6); start.setHours(0, 0, 0, 0);
      const end = new Date(now); end.setHours(23, 59, 59, 999);
      return { start, end };
    }
  }
};

const STATUS_BADGE: Record<AllocStatus, { label: string; cls: string }> = {
  on_track:     { label: 'On Track',     cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30' },
  slow:         { label: 'Slow',         cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30' },
  behind:       { label: 'Behind',       cls: 'bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/30' },
  default_risk: { label: 'Default Risk', cls: 'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30' },
  completed:    { label: 'Completed',    cls: 'bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/30' },
};

const AGENT_BADGE: Record<AllocAgentBlock['status'], { label: string; cls: string }> = {
  excellent: { label: 'Excellent', cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30' },
  good:      { label: 'Good',      cls: 'bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/30' },
  watch:     { label: 'Watch',     cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30' },
  critical:  { label: 'Critical',  cls: 'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30' },
};

const fmt = (n: number) => Math.round(n).toLocaleString();
const fmtPct = (n: number) => `${n.toFixed(1)}%`;

function tenantStatus(row: {
  paid: number; outstanding: number; daily: number; duration_days: number;
  start_date: string | null; last_payment: string | null;
}): { status: AllocStatus; days_overdue: number } {
  if (row.outstanding <= 0 && row.paid > 0) return { status: 'completed', days_overdue: 0 };
  const now = new Date();
  const daysSinceLast = row.last_payment ? differenceInCalendarDays(now, new Date(row.last_payment)) : 9999;
  const daysOverdue = row.last_payment ? Math.max(0, daysSinceLast - 1) : 0;

  if (row.last_payment === null && row.daily > 0) {
    // never paid
    return { status: 'default_risk', days_overdue: row.start_date ? Math.max(0, differenceInCalendarDays(now, new Date(row.start_date))) : 0 };
  }
  if (daysSinceLast >= 14 && row.outstanding > 0) {
    return { status: 'default_risk', days_overdue: daysOverdue };
  }
  if (!row.start_date || row.daily <= 0) {
    return { status: 'slow', days_overdue: daysOverdue };
  }
  const daysElapsed = Math.max(0, differenceInCalendarDays(now, new Date(row.start_date)));
  const expected = row.daily * Math.min(daysElapsed, row.duration_days || daysElapsed);
  if (expected <= 0) return { status: 'on_track', days_overdue: 0 };
  const ratio = row.paid / expected;
  if (ratio >= 1 && daysSinceLast <= 3) return { status: 'on_track', days_overdue: 0 };
  if (ratio >= 0.5) return { status: 'slow', days_overdue: daysOverdue };
  return { status: 'behind', days_overdue: daysOverdue };
}

function agentStatus(rate: number): AllocAgentBlock['status'] {
  if (rate >= 85) return 'excellent';
  if (rate >= 65) return 'good';
  if (rate >= 40) return 'watch';
  return 'critical';
}

export function AgentAllocationReport() {
  const queryClient = useQueryClient();
  const [preset, setPreset] = useState<RangePreset>('all');
  const range = useMemo(() => getRange(preset), [preset]);
  const startISO = range.start ? range.start.toISOString() : null;
  const endISO = range.end.toISOString();
  const periodLabel = range.start
    ? `${format(range.start, 'MMM d')} – ${format(range.end, 'MMM d, yyyy')}`
    : `All time · as of ${format(range.end, 'MMM d, yyyy')}`;

  const { data, isLoading } = useQuery({
    queryKey: ['agent-allocation-report', startISO, endISO],
    staleTime: 60_000,
    queryFn: async (): Promise<{ blocks: AllocAgentBlock[]; kpi: { agents: number; tenants: number; allocated: number; repaid: number; rate: number; }; }> => {
      // 1) Pull rent_requests (paginated)
      type RR = {
        id: string;
        agent_id: string | null;
        tenant_id: string | null;
        rent_amount: number | null;
        daily_repayment: number | null;
        duration_days: number | null;
        total_repayment: number | null;
        amount_repaid: number | null;
        status: string | null;
        created_at: string | null;
        funded_at: string | null;
        disbursed_at: string | null;
      };
      const reqs: RR[] = [];
      {
        const PAGE = 1000;
        let from = 0;
        for (let p = 0; p < 20; p++) {
          let q = supabase.from('rent_requests')
            .select('id, agent_id, tenant_id, rent_amount, daily_repayment, duration_days, total_repayment, amount_repaid, status, created_at, funded_at, disbursed_at')
            .not('agent_id', 'is', null)
            .not('tenant_id', 'is', null);
          if (startISO) q = q.gte('created_at', startISO);
          q = q.lte('created_at', endISO).range(from, from + PAGE - 1);
          const { data, error } = await q;
          if (error || !data || data.length === 0) break;
          reqs.push(...(data as any));
          if (data.length < PAGE) break;
          from += PAGE;
        }
      }

      // 2) Pull collections (for last payment date / payment counts) — paginated, filtered by tenant
      const tenantIds = Array.from(new Set(reqs.map(r => r.tenant_id!).filter(Boolean)));
      const agentIds  = Array.from(new Set(reqs.map(r => r.agent_id!).filter(Boolean)));

      type Coll = { agent_id: string; tenant_id: string | null; amount: number; created_at: string };
      const collections: Coll[] = [];
      if (agentIds.length) {
        const PAGE = 1000;
        const BATCH = 100;
        for (let i = 0; i < agentIds.length; i += BATCH) {
          const slice = agentIds.slice(i, i + BATCH);
          let from = 0;
          for (let p = 0; p < 20; p++) {
            const { data, error } = await supabase.from('agent_collections')
              .select('agent_id, tenant_id, amount, created_at').is('reversed_at', null)
              .in('agent_id', slice)
              .order('created_at', { ascending: false })
              .range(from, from + PAGE - 1);
            if (error || !data || data.length === 0) break;
            collections.push(...(data as any));
            if (data.length < PAGE) break;
            from += PAGE;
          }
        }
      }

      // 3) Pull profiles for agents + tenants
      const allIds = Array.from(new Set([...agentIds, ...tenantIds]));
      const profMap: Record<string, { name: string; phone: string }> = {};
      if (allIds.length) {
        const BATCH = 50;
        for (let i = 0; i < allIds.length; i += BATCH) {
          const { data: profs } = await supabase.from('profiles')
            .select('id, full_name, phone')
            .in('id', allIds.slice(i, i + BATCH));
          (profs || []).forEach(p => { profMap[p.id] = { name: p.full_name || p.id.slice(0, 8), phone: p.phone || '' }; });
        }
      }

      // 4) Index last payment per (agent, tenant)
      const lastPaymentKey = (a: string, t: string) => `${a}::${t}`;
      const lastPaymentMap: Record<string, string> = {};
      collections.forEach(c => {
        if (!c.tenant_id) return;
        const k = lastPaymentKey(c.agent_id, c.tenant_id);
        if (!lastPaymentMap[k] || new Date(c.created_at) > new Date(lastPaymentMap[k])) {
          lastPaymentMap[k] = c.created_at;
        }
      });

      // 5) Group by agent → build tenant rows
      const byAgent: Record<string, RR[]> = {};
      reqs.forEach(r => {
        if (!r.agent_id) return;
        (byAgent[r.agent_id] ||= []).push(r);
      });

      const blocks: AllocAgentBlock[] = Object.entries(byAgent).map(([agentId, list]) => {
        // de-dupe per tenant: keep latest rent_request
        const byTenant: Record<string, RR> = {};
        list.forEach(r => {
          if (!r.tenant_id) return;
          const cur = byTenant[r.tenant_id];
          const ts = (x: RR) => new Date(x.disbursed_at || x.funded_at || x.created_at || 0).getTime();
          if (!cur || ts(r) > ts(cur)) byTenant[r.tenant_id] = r;
        });

        const tenants: AllocTenantRow[] = Object.values(byTenant).map(r => {
          const start = r.disbursed_at || r.funded_at || r.created_at;
          const last = lastPaymentMap[lastPaymentKey(agentId, r.tenant_id!)] || null;
          const rent = Number(r.rent_amount || 0);
          const duration = Number(r.duration_days || 0);
          // Canonical formula is the source of truth (DB trigger enforces it on new rows;
          // legacy rows may carry stale total_repayment / daily_repayment values).
          const canonical = rent > 0 && duration > 0 ? calculateRentRepayment(rent, duration) : null;
          const storedTotal = Number(r.total_repayment || 0);
          const total = canonical ? canonical.totalRepayment : (storedTotal || rent);
          const paid = Number(r.amount_repaid || 0);
          const outstanding = Math.max(0, total - paid);
          const daily = canonical ? canonical.dailyRepayment : Number(r.daily_repayment || 0);
          const pct = total > 0 ? (paid / total) * 100 : 0;
          const { status, days_overdue } = tenantStatus({
            paid, outstanding, daily, duration_days: duration, start_date: start, last_payment: last,
          });
          const prof = profMap[r.tenant_id!] || { name: r.tenant_id!.slice(0, 8), phone: '' };
          return {
          request_id: r.id,
          tenant_id: r.tenant_id!,
            tenant_name: prof.name,
            tenant_phone: prof.phone,
            start_date: start,
            rent_given: rent,
            daily,
            duration_days: duration,
            paid,
            outstanding,
            pct_paid: pct,
            last_payment: last,
            days_overdue,
            status,
          };
        });

        const allocated = tenants.reduce((s, t) => s + t.rent_given, 0);
        const repaid = tenants.reduce((s, t) => s + t.paid, 0);
        const outstanding = tenants.reduce((s, t) => s + t.outstanding, 0);
        const collection_rate = allocated > 0 ? (repaid / allocated) * 100 : 0;
        const onTime = tenants.filter(t => t.status === 'on_track' || t.status === 'completed').length;
        const def = tenants.filter(t => t.status === 'default_risk').length;
        const on_time_pct = tenants.length ? (onTime / tenants.length) * 100 : 0;
        const default_pct = tenants.length ? (def / tenants.length) * 100 : 0;
        const prof = profMap[agentId] || { name: agentId.slice(0, 8), phone: '' };

        return {
          agent_id: agentId,
          agent_name: prof.name,
          agent_phone: prof.phone,
          tenants: tenants.sort((a, b) => b.rent_given - a.rent_given),
          totals: { allocated, repaid, outstanding, collection_rate, on_time_pct, default_pct },
          status: agentStatus(collection_rate),
        };
      })
        .filter(b => b.tenants.length > 0)
        .sort((a, b) => b.totals.collection_rate - a.totals.collection_rate);

      const kpi = {
        agents: blocks.length,
        tenants: blocks.reduce((s, b) => s + b.tenants.length, 0),
        allocated: blocks.reduce((s, b) => s + b.totals.allocated, 0),
        repaid: blocks.reduce((s, b) => s + b.totals.repaid, 0),
        rate: 0,
      };
      kpi.rate = kpi.allocated > 0 ? (kpi.repaid / kpi.allocated) * 100 : 0;

      return { blocks, kpi };
    },
  });

  const blocks = data?.blocks || [];
  const kpi = data?.kpi || { agents: 0, tenants: 0, allocated: 0, repaid: 0, rate: 0 };

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['agent-allocation-report'] });

  const saveField = async (
    requestId: string,
    field: 'rent_amount' | 'amount_repaid' | 'duration_days',
    value: number,
  ) => {
    // What a tenant owes is not editable from here, and since 20260928150000
    // the row-level policy refuses it outright. Saying so is better than
    // letting the write fail with a permissions error.
    if (field === 'amount_repaid') {
      toast.error('Repaid cannot be edited here', {
        description: 'Change the outstanding balance in Tenant Ops. It goes to the CFO for approval.',
      });
      throw new Error('amount_repaid is not editable from the allocation report');
    }
    const { error } = await supabase
      .from('rent_requests')
      .update({ [field]: value })
      .eq('id', requestId);
    if (error) throw error;
  };

  const handleDownloadPdf = async () => {
    if (!blocks.length) { toast.error('No data to export'); return; }
    try {
      const blob = await generateAgentAllocationPdf({ blocks, periodLabel });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `agent_allocations_${format(range.end, 'yyyy-MM-dd')}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('PDF downloaded');
    } catch (e: any) {
      toast.error('Failed to generate PDF', { description: e?.message });
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-indigo-600 text-white shadow-sm">
            <FileBarChart className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base sm:text-lg font-bold leading-tight">Agent Allocations & Tenant Repayment</h2>
            <p className="text-xs text-muted-foreground">{periodLabel}</p>
          </div>
        </div>
        <div className="flex gap-2 items-center">
          <Select value={preset} onValueChange={(v) => setPreset(v as RangePreset)}>
            <SelectTrigger className="w-[150px] h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Time</SelectItem>
              <SelectItem value="last-7">Last 7 Days</SelectItem>
              <SelectItem value="this-week">This Week</SelectItem>
              <SelectItem value="last-week">Last Week</SelectItem>
              <SelectItem value="this-month">This Month</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={handleDownloadPdf} className="h-9 gap-2" disabled={isLoading || !blocks.length}>
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">Download PDF</span>
          </Button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <KPI label="Agents" value={String(kpi.agents)} />
        <KPI label="Tenants" value={String(kpi.tenants)} />
        <KPI label="Allocated" value={`UGX ${fmt(kpi.allocated)}`} />
        <KPI label="Repaid" value={`UGX ${fmt(kpi.repaid)}`} valueCls="text-emerald-600" />
        <KPI label="Collection Rate" value={fmtPct(kpi.rate)} valueCls="text-primary" />
      </div>

      {/* Accordion of agents */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
        </div>
      ) : blocks.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
          No agent allocations in this period
        </div>
      ) : (
        <Accordion type="multiple" className="space-y-2">
          {blocks.map((b) => (
            <AccordionItem
              key={b.agent_id}
              value={b.agent_id}
              className="rounded-2xl border border-border bg-card overflow-hidden"
            >
              <AccordionTrigger className="px-4 hover:no-underline">
                <div className="flex flex-1 items-center justify-between gap-3 pr-2">
                  <div className="text-left min-w-0">
                    <div className="font-semibold truncate">{b.agent_name}</div>
                    <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                      {b.agent_phone && <><Phone className="h-3 w-3" />{b.agent_phone}<span className="mx-1">·</span></>}
                      {b.tenants.length} tenants
                    </div>
                  </div>
                  <div className="hidden sm:flex items-center gap-4 text-xs">
                    <div className="text-right">
                      <div className="text-muted-foreground">Allocated</div>
                      <div className="font-mono font-semibold">{fmt(b.totals.allocated)}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-muted-foreground">Repaid</div>
                      <div className="font-mono font-semibold text-emerald-600">{fmt(b.totals.repaid)}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-muted-foreground">Rate</div>
                      <div className="font-mono font-semibold text-primary">{fmtPct(b.totals.collection_rate)}</div>
                    </div>
                  </div>
                  <span className={cn('px-2 py-0.5 rounded-md text-[10px] font-semibold border whitespace-nowrap', AGENT_BADGE[b.status].cls)}>
                    {AGENT_BADGE[b.status].label}
                  </span>
                </div>
              </AccordionTrigger>
              <AccordionContent className="px-0 pb-0">
                {/* Mobile-only summary row */}
                <div className="sm:hidden grid grid-cols-3 gap-2 px-4 pb-3 text-xs">
                  <div><div className="text-muted-foreground">Allocated</div><div className="font-semibold">{fmt(b.totals.allocated)}</div></div>
                  <div><div className="text-muted-foreground">Repaid</div><div className="font-semibold text-emerald-600">{fmt(b.totals.repaid)}</div></div>
                  <div><div className="text-muted-foreground">Rate</div><div className="font-semibold text-primary">{fmtPct(b.totals.collection_rate)}</div></div>
                  <div><div className="text-muted-foreground">Outstanding</div><div className="font-semibold text-orange-600">{fmt(b.totals.outstanding)}</div></div>
                  <div><div className="text-muted-foreground">On-Time</div><div className="font-semibold">{fmtPct(b.totals.on_time_pct)}</div></div>
                  <div><div className="text-muted-foreground">Default</div><div className="font-semibold text-red-600">{fmtPct(b.totals.default_pct)}</div></div>
                </div>

                {/* Desktop table */}
                <div className="hidden md:block overflow-x-auto border-t border-border">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="px-2 py-2 text-left font-semibold w-8">#</th>
                        <th className="px-2 py-2 text-left font-semibold">Tenant</th>
                        <th className="px-2 py-2 text-left font-semibold">Phone</th>
                        <th className="px-2 py-2 text-center font-semibold">Start</th>
                        <th className="px-2 py-2 text-right font-semibold">Rent Given</th>
                        <th className="px-2 py-2 text-right font-semibold">Daily</th>
                        <th className="px-2 py-2 text-right font-semibold">Days</th>
                        <th className="px-2 py-2 text-right font-semibold">Paid</th>
                        <th className="px-2 py-2 text-right font-semibold">Outstanding</th>
                        <th className="px-2 py-2 text-right font-semibold">% Paid</th>
                        <th className="px-2 py-2 text-center font-semibold">Last Pmt</th>
                        <th className="px-2 py-2 text-right font-semibold">Overdue</th>
                        <th className="px-2 py-2 text-center font-semibold">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {b.tenants.map((t, i) => (
                        <tr key={i} className={cn('border-b border-border', i % 2 === 0 && 'bg-muted/20')}>
                          <td className="px-2 py-2">{i + 1}</td>
                          <td className="px-2 py-2 font-medium">{t.tenant_name}</td>
                          <td className="px-2 py-2 text-muted-foreground">{t.tenant_phone || '—'}</td>
                          <td className="px-2 py-2 text-center">{t.start_date ? format(new Date(t.start_date), 'dd MMM yy') : '—'}</td>
                          <td className="px-2 py-2 text-right font-mono">
                            <EditableNumber value={t.rent_given} onSave={async (v) => { await saveField(t.request_id, 'rent_amount', v); await refresh(); }} />
                          </td>
                          <td className="px-2 py-2 text-right font-mono">{fmt(t.daily)}</td>
                          <td className="px-2 py-2 text-right">
                            <EditableNumber value={t.duration_days || 0} onSave={async (v) => { await saveField(t.request_id, 'duration_days', v); await refresh(); }} />
                          </td>
                          <td className="px-2 py-2 text-right font-mono text-emerald-600">
                            <EditableNumber value={t.paid} onSave={async (v) => { await saveField(t.request_id, 'amount_repaid', v); await refresh(); }} />
                          </td>
                          <td className="px-2 py-2 text-right font-mono text-orange-600">{fmt(t.outstanding)}</td>
                          <td className="px-2 py-2 text-right">{fmtPct(t.pct_paid)}</td>
                          <td className="px-2 py-2 text-center text-muted-foreground">{t.last_payment ? format(new Date(t.last_payment), 'dd MMM yy') : '—'}</td>
                          <td className={cn('px-2 py-2 text-right', t.days_overdue > 7 && 'text-red-600 font-semibold')}>{t.days_overdue > 0 ? t.days_overdue : '—'}</td>
                          <td className="px-2 py-2 text-center">
                            <span className={cn('inline-flex px-2 py-0.5 rounded-md text-[10px] font-semibold border', STATUS_BADGE[t.status].cls)}>
                              {STATUS_BADGE[t.status].label}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Mobile cards */}
                <div className="md:hidden space-y-2 px-3 pb-3 border-t border-border pt-3">
                  {b.tenants.map((t, i) => (
                    <div key={i} className="rounded-xl border border-border bg-background p-3 space-y-1.5">
                      <div className="flex justify-between items-start">
                        <div className="min-w-0">
                          <div className="font-semibold text-sm truncate">{t.tenant_name}</div>
                          <div className="text-[11px] text-muted-foreground">{t.tenant_phone || '—'}</div>
                        </div>
                        <span className={cn('px-2 py-0.5 rounded-md text-[10px] font-semibold border whitespace-nowrap', STATUS_BADGE[t.status].cls)}>
                          {STATUS_BADGE[t.status].label}
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-[11px]">
                        <div><div className="text-muted-foreground">Rent</div><EditableNumber value={t.rent_given} className="font-semibold" onSave={async (v) => { await saveField(t.request_id, 'rent_amount', v); await refresh(); }} /></div>
                        <div><div className="text-muted-foreground">Paid</div><EditableNumber value={t.paid} className="font-semibold text-emerald-600" onSave={async (v) => { await saveField(t.request_id, 'amount_repaid', v); await refresh(); }} /></div>
                        <div><div className="text-muted-foreground">Outstanding</div><div className="font-semibold text-orange-600">{fmt(t.outstanding)}</div></div>
                        <div><div className="text-muted-foreground">Daily</div><div className="font-semibold">{fmt(t.daily)}</div></div>
                        <div><div className="text-muted-foreground">% Paid</div><div className="font-semibold">{fmtPct(t.pct_paid)}</div></div>
                        <div><div className="text-muted-foreground">Days</div><EditableNumber value={t.duration_days || 0} className="font-semibold" onSave={async (v) => { await saveField(t.request_id, 'duration_days', v); await refresh(); }} /></div>
                        <div><div className="text-muted-foreground">Overdue</div><div className={cn('font-semibold', t.days_overdue > 7 && 'text-red-600')}>{t.days_overdue > 0 ? `${t.days_overdue}d` : '—'}</div></div>
                      </div>
                    </div>
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      )}
    </div>
  );
}

function KPI({ label, value, valueCls }: { label: string; value: string; valueCls?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{label}</div>
      <div className={cn('text-base sm:text-lg font-bold mt-1', valueCls)}>{value}</div>
    </div>
  );
}

function EditableNumber({
  value,
  onSave,
  className,
}: {
  value: number;
  onSave: (v: number) => Promise<void>;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const [saving, setSaving] = useState(false);

  const start = () => { setDraft(String(value)); setEditing(true); };
  const cancel = () => { setEditing(false); setDraft(String(value)); };
  const commit = async () => {
    const n = Number(String(draft).replace(/[^\d.-]/g, ''));
    if (!Number.isFinite(n) || n < 0) { toast.error('Invalid number'); return; }
    if (n === value) { setEditing(false); return; }
    setSaving(true);
    try {
      await onSave(n);
      toast.success('Saved');
      setEditing(false);
    } catch (e: any) {
      toast.error('Save failed', { description: e?.message });
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <Input
          autoFocus
          inputMode="numeric"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') cancel(); }}
          className="h-7 w-24 text-xs font-mono px-2"
          disabled={saving}
        />
        <button type="button" onClick={commit} disabled={saving} className="text-emerald-600 hover:text-emerald-700">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
        </button>
        <button type="button" onClick={cancel} disabled={saving} className="text-muted-foreground hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={start}
      className={cn(
        'inline-flex items-center gap-1 hover:bg-muted/60 rounded px-1 -mx-1 transition-colors group',
        className,
      )}
      title="Click to edit"
    >
      <span className="font-mono">{fmt(value)}</span>
      <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60" />
    </button>
  );
}