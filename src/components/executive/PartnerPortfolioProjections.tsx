import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useMemo, useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid } from 'recharts';
import { TrendingUp, Repeat, FileText, Users, ChevronRight } from 'lucide-react';
import { ForwardBreakdownSheet, type ForwardStream } from './ForwardBreakdownSheet';

interface PartnerRow {
  partner_id: string;
  partner_name: string;
  phone: string | null;
  portfolios: number;
  deployed: number;
  compounding_deployed: number;
  payout_deployed: number;
  expected_monthly_return: number;
  projected_monthly_payout: number;
  projected_compound_growth: number;
  projected_horizon_payout?: number;
  roi_earned_to_date: number;
  next_roi_date: string | null;
  top_rate: number;
}

interface SeriesRow {
  month: string;
  projected_roi_payout: number;
  projected_compounding: number;
  promissory_expected: number;
}

const fmt = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : Math.round(n || 0).toLocaleString();

export type Bucket = 'day' | 'week' | 'month' | 'year';

export interface Horizon {
  days: number;
  bucket: Bucket;
  label: string;
}

export const HORIZON_PRESETS: Horizon[] = [
  { days: 7, bucket: 'day', label: 'Next 7 days' },
  { days: 14, bucket: 'day', label: 'Next 14 days' },
  { days: 30, bucket: 'day', label: 'Next 30 days' },
  { days: 90, bucket: 'week', label: 'Next 90 days (weekly)' },
  { days: 180, bucket: 'month', label: 'Next 6 months' },
  { days: 365, bucket: 'month', label: 'Next 1 year' },
  { days: 730, bucket: 'month', label: 'Next 2 years' },
  { days: 1095, bucket: 'year', label: 'Next 3 years' },
  { days: 1460, bucket: 'year', label: 'Next 4 years' },
  { days: 1826, bucket: 'year', label: 'Next 5 years' },
];

const UNIT_DAYS: Record<string, number> = { days: 1, weeks: 7, months: 30, years: 365 };
const UNIT_BUCKET: Record<string, Bucket> = { days: 'day', weeks: 'week', months: 'month', years: 'year' };

export function usePartnerCapitalProjections(horizon: Horizon | number = 180) {
  const h: Horizon = typeof horizon === 'number'
    ? { days: horizon, bucket: horizon <= 31 ? 'day' : horizon <= 400 ? 'month' : 'year', label: '' }
    : horizon;
  return useQuery({
    queryKey: ['partner-capital-projections', h.days, h.bucket],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('get_partner_capital_projections', {
        p_months: Math.max(1, Math.round(h.days / 30)),
        p_days: h.days,
        p_bucket: h.bucket,
      });
      if (error) throw error;
      const payload = (data || {}) as any;
      return {
        partners: (payload.partners || []) as PartnerRow[],
        series: (payload.series || []) as SeriesRow[],
        totals: (payload.totals || {}) as Record<string, number>,
      };
    },
    staleTime: 600000,
  });
}

function HorizonPicker({ value, onChange }: { value: Horizon; onChange: (h: Horizon) => void }) {
  const [custom, setCustom] = useState(false);
  const [amount, setAmount] = useState('3');
  const [unit, setUnit] = useState<keyof typeof UNIT_DAYS>('months');

  const applyCustom = () => {
    const n = Math.max(1, Math.round(Number(amount) || 1));
    const days = Math.min(1826, n * UNIT_DAYS[unit]);
    onChange({ days, bucket: UNIT_BUCKET[unit], label: `Next ${n} ${unit}` });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={custom ? 'custom' : String(value.days)}
        onValueChange={v => {
          if (v === 'custom') { setCustom(true); return; }
          setCustom(false);
          const p = HORIZON_PRESETS.find(x => String(x.days) === v);
          if (p) onChange(p);
        }}
      >
        <SelectTrigger className="h-8 w-[190px] text-xs"><SelectValue placeholder="Horizon" /></SelectTrigger>
        <SelectContent>
          {HORIZON_PRESETS.map(p => (
            <SelectItem key={p.days} value={String(p.days)} className="text-xs">{p.label}</SelectItem>
          ))}
          <SelectItem value="custom" className="text-xs">Custom…</SelectItem>
        </SelectContent>
      </Select>

      {custom && (
        <div className="flex items-center gap-1">
          <Input value={amount} onChange={e => setAmount(e.target.value)} className="h-8 w-16 text-xs" inputMode="numeric" />
          <Select value={unit} onValueChange={(v: any) => setUnit(v)}>
            <SelectTrigger className="h-8 w-[104px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="days" className="text-xs">Days</SelectItem>
              <SelectItem value="weeks" className="text-xs">Weeks</SelectItem>
              <SelectItem value="months" className="text-xs">Months</SelectItem>
              <SelectItem value="years" className="text-xs">Years</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" className="h-8 text-xs" onClick={applyCustom}>Apply</Button>
        </div>
      )}

      <Badge variant="outline" className="text-[9px]">{value.label || `${value.days} days`} · {value.bucket}ly buckets</Badge>
    </div>
  );
}

export function ProjectedReturnsChart({ months = 6, horizon, onHorizonChange }: { months?: number; horizon?: Horizon; onHorizonChange?: (h: Horizon) => void }) {
  const [internal, setInternal] = useState<Horizon>(
    horizon || HORIZON_PRESETS.find(p => p.days === months * 30) || { days: months * 30, bucket: 'month', label: `Next ${months} months` }
  );
  const active = horizon || internal;
  const setActive = (h: Horizon) => { setInternal(h); onHorizonChange?.(h); };

  const { data, isLoading } = usePartnerCapitalProjections(active);
  const [stream, setStream] = useState<ForwardStream | null>(null);

  const t = data?.totals || {};
  return (
    <div className="space-y-3">
      <HorizonPicker value={active} onChange={setActive} />
      <ForwardBreakdownSheet stream={stream} horizon={active} onOpenChange={o => !o && setStream(null)} />
      {isLoading || !data ? <div className="h-[240px] rounded-lg bg-muted/40 animate-pulse" /> : (
      <>
      <div className="grid grid-cols-3 gap-2">
        <button type="button" onClick={() => setStream('roi')} className="text-left rounded-lg bg-blue-500/10 p-2.5 hover:bg-blue-500/20 transition-colors">
          <p className="text-[10px] text-muted-foreground flex items-center gap-1"><TrendingUp className="h-3 w-3" />Projected ROI / month<ChevronRight className="h-3 w-3 ml-auto" /></p>
          <p className="text-base font-bold text-blue-600">UGX {fmt(Number(t.projected_monthly_payout || 0))}</p>
          <p className="text-[9px] text-muted-foreground">Horizon total: UGX {fmt(Number(t.projected_horizon_payout || 0))}</p>
        </button>
        <button type="button" onClick={() => setStream('compounding')} className="text-left rounded-lg bg-violet-500/10 p-2.5 hover:bg-violet-500/20 transition-colors">
          <p className="text-[10px] text-muted-foreground flex items-center gap-1"><Repeat className="h-3 w-3" />Compounding ({active.label || `${active.days}d`})<ChevronRight className="h-3 w-3 ml-auto" /></p>
          <p className="text-base font-bold text-violet-600">UGX {fmt(Number(t.projected_compound_growth || 0))}</p>
          <p className="text-[9px] text-muted-foreground">Tap for partner detail</p>
        </button>
        <button type="button" onClick={() => setStream('notes')} className="text-left rounded-lg bg-amber-500/10 p-2.5 hover:bg-amber-500/20 transition-colors">
          <p className="text-[10px] text-muted-foreground flex items-center gap-1"><FileText className="h-3 w-3" />Notes receivable<ChevronRight className="h-3 w-3 ml-auto" /></p>
          <p className="text-base font-bold text-amber-600">UGX {fmt(Number(t.promissory_expected || 0))}</p>
          <p className="text-[9px] text-muted-foreground">Tap for who owes what</p>
        </button>
      </div>

      <div>
        <p className="text-[10px] text-muted-foreground mb-1">Forward obligations &amp; receivables — {(active.label || `${active.days} days`).toLowerCase()} (UGX)</p>
        <ResponsiveContainer width="100%" height={190}>
          <BarChart data={data.series}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
            <XAxis dataKey="month" tick={{ fontSize: 9 }} />
            <YAxis tick={{ fontSize: 9 }} tickFormatter={(v: number) => fmt(v)} width={40} />
            <Tooltip contentStyle={{ fontSize: 11 }} formatter={(v: number) => `UGX ${fmt(v)}`} />
            <Legend wrapperStyle={{ fontSize: 9 }} />
            <Bar dataKey="projected_roi_payout" name="Projected ROI payout" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
            <Bar dataKey="projected_compounding" name="Projected compounding" fill="hsl(262 83% 58%)" radius={[3, 3, 0, 0]} />
            <Bar dataKey="promissory_expected" name="Promissory receivable" fill="hsl(38 92% 50%)" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
        <p className="text-[9px] text-muted-foreground mt-1">
          ROI payout = flat monthly rate on payout-mode capital. Compounding = month-on-month growth on reinvesting capital. Receivables bucket unscheduled notes into the current month.
        </p>
      </div>
      </>
      )}
    </div>
  );
}

export function PartnerPortfolioTable({ months = 6, horizon }: { months?: number; horizon?: Horizon }) {
  const active: Horizon = horizon || { days: months * 30, bucket: 'month', label: `Next ${months} months` };
  const { data, isLoading } = usePartnerCapitalProjections(active);
  const [q, setQ] = useState('');

  const rows = useMemo(() => {
    const list = data?.partners || [];
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(p => `${p.partner_name} ${p.phone || ''}`.toLowerCase().includes(needle));
  }, [data, q]);

  if (isLoading) return <div className="h-[220px] rounded-lg bg-muted/40 animate-pulse" />;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search partner or phone…" className="h-8 text-xs" />
        <Badge variant="outline" className="text-[9px] whitespace-nowrap">
          <Users className="h-3 w-3 mr-1" />{rows.length} partners
        </Badge>
      </div>
      <ScrollArea className="h-[300px] rounded-md border">
        <table className="w-full text-[11px]">
          <thead className="sticky top-0 bg-muted/80 backdrop-blur">
            <tr className="text-left">
              <th className="p-2 font-medium">Partner</th>
              <th className="p-2 font-medium text-right">Plans</th>
              <th className="p-2 font-medium text-right">Deployed</th>
              <th className="p-2 font-medium text-right">ROI / month</th>
              <th className="p-2 font-medium text-right">Compounding ({active.label || `${active.days}d`})</th>
              <th className="p-2 font-medium text-right">Next payout</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(p => (
              <tr key={p.partner_id} className="border-t">
                <td className="p-2">
                  <p className="font-medium truncate max-w-[160px]">{p.partner_name}</p>
                  <p className="text-[9px] text-muted-foreground">
                    {p.top_rate}% · {p.compounding_deployed > 0 ? 'compounding' : 'payout'}
                  </p>
                </td>
                <td className="p-2 text-right">{p.portfolios}</td>
                <td className="p-2 text-right font-medium">{fmt(Number(p.deployed))}</td>
                <td className="p-2 text-right text-blue-600">{fmt(Number(p.projected_monthly_payout))}</td>
                <td className="p-2 text-right text-violet-600">{fmt(Number(p.projected_compound_growth))}</td>
                <td className="p-2 text-right text-muted-foreground">{p.next_roi_date || '—'}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">No partners match.</td></tr>
            )}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  );
}