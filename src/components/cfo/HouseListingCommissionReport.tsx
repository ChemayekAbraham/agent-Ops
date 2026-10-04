import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Home, Loader2, Download, Calendar, TrendingUp, Users, Award,
  Zap, ShieldCheck, UserPlus, FileText,
} from 'lucide-react';
import { toast } from 'sonner';
import { generateHouseListingCommissionPdf } from '@/lib/houseListingCommissionPdf';

type Preset = 'all' | 'today' | '7d' | '30d' | 'month' | 'custom';

interface TypeRow { type: string; amount: number; count: number }
interface AgentRow { agent_id: string; agent_name: string; phone: string; amount: number; count: number }
interface Report {
  total_amount: number;
  total_count: number;
  agent_count: number;
  by_type: TypeRow[];
  by_agent: AgentRow[];
}

const TYPE_META: Record<string, { label: string; icon: React.ReactNode }> = {
  verification_bonus: { label: 'Verification bonus', icon: <ShieldCheck className="h-4 w-4" /> },
  instant_reward: { label: 'Instant listing reward', icon: <Zap className="h-4 w-4" /> },
  recruiter_override: { label: 'Recruiter override', icon: <UserPlus className="h-4 w-4" /> },
  other: { label: 'Other listing commission', icon: <Award className="h-4 w-4" /> },
};

export function HouseListingCommissionReport() {
  const [preset, setPreset] = useState<Preset>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const bounds = useMemo(() => {
    const now = new Date();
    const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
    const endOfDay = (d: Date) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
    const DAY = 24 * 3600 * 1000;
    if (preset === 'today') return { from: startOfDay(now).toISOString(), to: null as string | null };
    if (preset === '7d') return { from: startOfDay(new Date(now.getTime() - 6 * DAY)).toISOString(), to: null as string | null };
    if (preset === '30d') return { from: startOfDay(new Date(now.getTime() - 29 * DAY)).toISOString(), to: null as string | null };
    if (preset === 'month') return { from: startOfDay(new Date(now.getFullYear(), now.getMonth(), 1)).toISOString(), to: null as string | null };
    if (preset === 'custom') return {
      from: customFrom ? startOfDay(new Date(customFrom)).toISOString() : null,
      to: customTo ? endOfDay(new Date(customTo)).toISOString() : null,
    };
    return { from: null as string | null, to: null as string | null };
  }, [preset, customFrom, customTo]);

  const label = useMemo(() => {
    if (preset === 'all') return 'All time';
    if (preset === 'today') return 'Today';
    if (preset === '7d') return 'Last 7 days';
    if (preset === '30d') return 'Last 30 days';
    if (preset === 'month') return 'This month';
    const f = customFrom ? new Date(customFrom).toLocaleDateString('en-UG', { day: 'numeric', month: 'short', year: 'numeric' }) : '…';
    const t = customTo ? new Date(customTo).toLocaleDateString('en-UG', { day: 'numeric', month: 'short', year: 'numeric' }) : '…';
    return `${f} → ${t}`;
  }, [preset, customFrom, customTo]);

  const { data, isFetching, isError, refetch } = useQuery({
    queryKey: ['house-listing-commission-report', bounds.from, bounds.to],
    queryFn: async (): Promise<Report> => {
      const { data, error } = await supabase.rpc('generate_house_listing_commission_report', {
        p_from: bounds.from,
        p_to: bounds.to,
      });
      if (error) throw error;
      const r = (data ?? {}) as any;
      return {
        total_amount: Number(r.total_amount || 0),
        total_count: Number(r.total_count || 0),
        agent_count: Number(r.agent_count || 0),
        by_type: (r.by_type || []) as TypeRow[],
        by_agent: (r.by_agent || []) as AgentRow[],
      };
    },
    staleTime: 30_000,
  });

  const exportCsv = () => {
    if (!data) return;
    const rows: string[] = [];
    const esc = (v: string | number) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const line = (cols: (string | number)[]) => rows.push(cols.map(esc).join(','));

    line(['House Listing Commission Report']);
    line(['Period', label]);
    line(['Generated', new Date().toLocaleString('en-UG')]);
    rows.push('');

    line(['SUMMARY']);
    line(['Metric', 'Value']);
    line(['Total Commission Paid (UGX)', data.total_amount]);
    line(['Payments', data.total_count]);
    line(['Agents Paid', data.agent_count]);
    rows.push('');

    line(['COMMISSION BY TYPE']);
    line(['Commission Type', 'Payments', 'Amount (UGX)', 'Share (%)']);
    for (const t of data.by_type) {
      const pct = data.total_amount > 0 ? Math.round((t.amount / data.total_amount) * 100) : 0;
      line([TYPE_META[t.type]?.label || t.type, t.count, t.amount, pct]);
    }
    rows.push('');

    line(['COMMISSION BY AGENT']);
    line(['Rank', 'Agent', 'Phone', 'Payments', 'Amount (UGX)']);
    data.by_agent.forEach((a, i) => line([i + 1, a.agent_name, a.phone || '', a.count, a.amount]));

    const blob = new Blob(['\uFEFF' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const filename = `house_listing_commission_${new Date().toISOString().slice(0, 10)}.csv`;
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    toast.success('Report exported');

    // Bulk export of commission by agent -- names, phones, amounts -- not
    // logged before this. Plain client-side insert so the audit_logs
    // IP-capture trigger sees the real browser IP directly. Never blocks
    // the actual download.
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        await supabase.from('audit_logs').insert({
          user_id: user?.id ?? null,
          action_type: 'csv_exported',
          table_name: 'export',
          record_id: null,
          metadata: { filename, agent_count: data.by_agent.length },
        });
      } catch (e) {
        console.warn('[HouseListingCommissionReport] audit log insert failed:', e);
      }
    })();
  };

  const [pdfBusy, setPdfBusy] = useState(false);
  const exportPdf = async () => {
    if (!data) return;
    setPdfBusy(true);
    try {
      const blob = await generateHouseListingCommissionPdf({
        periodLabel: label,
        totalAmount: data.total_amount,
        totalCount: data.total_count,
        agentCount: data.agent_count,
        byType: data.by_type.map(t => ({ label: TYPE_META[t.type]?.label || t.type, amount: t.amount, count: t.count })),
        byAgent: data.by_agent.map(a => ({ name: a.agent_name, phone: a.phone, amount: a.amount, count: a.count })),
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `house_listing_commission_${new Date().toISOString().slice(0, 10)}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
      toast.success('PDF downloaded');
    } catch (e) {
      console.error(e);
      toast.error('Could not generate PDF');
    } finally {
      setPdfBusy(false);
    }
  };

  const chip = (p: Preset, text: string) => (
    <button
      onClick={() => setPreset(p)}
      className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
        preset === p ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/70'
      }`}
    >
      {text}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="min-w-0">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Home className="h-5 w-5 text-primary" />
          House Listing Commission Report
        </h2>
        <p className="text-[11px] text-muted-foreground mt-0.5 max-w-md">
          Accurate total of every commission paid to agents for listing houses — instant listing rewards,
          verification bonuses and recruiter overrides — read straight from the ledger.
        </p>
      </div>

      {/* Date filter */}
      <div className="rounded-2xl border border-border bg-card p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Calendar className="h-3.5 w-3.5" /> Report Period
          </p>
          <span className="text-[10px] font-medium text-primary">{label}</span>
        </div>
        <div className="flex items-center gap-1.5 overflow-x-auto -mx-1 px-1 pb-0.5">
          {chip('all', 'All time')}
          {chip('today', 'Today')}
          {chip('7d', '7 days')}
          {chip('30d', '30 days')}
          {chip('month', 'This month')}
          {chip('custom', 'Custom')}
        </div>
        {preset === 'custom' && (
          <div className="flex items-center gap-2 pt-0.5">
            <div className="flex-1">
              <Label className="text-[10px] text-muted-foreground">From</Label>
              <Input type="date" value={customFrom} max={customTo || undefined} onChange={e => setCustomFrom(e.target.value)} className="h-8 text-xs" />
            </div>
            <div className="flex-1">
              <Label className="text-[10px] text-muted-foreground">To</Label>
              <Input type="date" value={customTo} min={customFrom || undefined} onChange={e => setCustomTo(e.target.value)} className="h-8 text-xs" />
            </div>
          </div>
        )}
      </div>

      {isFetching ? (
        <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : isError ? (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">
          Could not load the report. <button className="text-primary underline" onClick={() => refetch()}>Retry</button>
        </CardContent></Card>
      ) : data ? (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-1 gap-2">
            <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <TrendingUp className="h-3.5 w-3.5" /> Total Commission Paid
              </p>
              <p className="text-2xl font-bold mt-1">{formatUGX(data.total_amount)}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">{data.total_count.toLocaleString()} payments · {label}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-2xl border border-border bg-card p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5"><Users className="h-3.5 w-3.5" /> Agents Paid</p>
              <p className="text-xl font-bold mt-1">{data.agent_count.toLocaleString()}</p>
            </div>
            <div className="rounded-2xl border border-border bg-card p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5"><Award className="h-3.5 w-3.5" /> Payments</p>
              <p className="text-xl font-bold mt-1">{data.total_count.toLocaleString()}</p>
            </div>
          </div>

          {/* Export actions */}
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" className="h-8 flex-1 gap-1.5 text-xs" onClick={exportCsv} disabled={!data.total_count}>
              <Download className="h-3.5 w-3.5" /> Export CSV
            </Button>
            <Button size="sm" className="h-8 flex-1 gap-1.5 text-xs" onClick={exportPdf} disabled={!data.total_count || pdfBusy}>
              {pdfBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />} Download PDF
            </Button>
          </div>

          {/* By type */}
          <div className="rounded-2xl border border-border bg-card p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Commission by Type</p>
            <div className="space-y-2">
              {data.by_type.length === 0 && (
                <p className="text-sm text-muted-foreground py-4 text-center">No commission paid in this period.</p>
              )}
              {data.by_type.map(t => {
                const pct = data.total_amount > 0 ? Math.round((t.amount / data.total_amount) * 100) : 0;
                return (
                  <div key={t.type} className="rounded-xl border border-border bg-muted/20 p-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium flex items-center gap-1.5">{TYPE_META[t.type]?.icon}{TYPE_META[t.type]?.label || t.type}</span>
                      <span className="text-sm font-bold">{formatUGX(t.amount)}</span>
                    </div>
                    <div className="flex items-center justify-between mt-1">
                      <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden mr-2">
                        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-[10px] text-muted-foreground shrink-0">{t.count} · {pct}%</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* By agent */}
          <div className="rounded-2xl border border-border bg-card p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">By Agent ({data.by_agent.length})</p>
            <div className="space-y-1.5 max-h-[480px] overflow-y-auto">
              {data.by_agent.length === 0 && (
                <p className="text-sm text-muted-foreground py-4 text-center">No agents paid in this period.</p>
              )}
              {data.by_agent.map((a, i) => (
                <div key={a.agent_id || i} className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/10 px-2.5 py-1.5">
                  <div className="min-w-0 flex items-center gap-2">
                    <span className="text-[10px] font-bold text-muted-foreground w-5 shrink-0">{i + 1}</span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{a.agent_name}</p>
                      {a.phone && <p className="text-[10px] text-muted-foreground truncate">{a.phone}</p>}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold">{formatUGX(a.amount)}</p>
                    <p className="text-[10px] text-muted-foreground">{a.count} listing{a.count === 1 ? '' : 's'}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

export default HouseListingCommissionReport;
