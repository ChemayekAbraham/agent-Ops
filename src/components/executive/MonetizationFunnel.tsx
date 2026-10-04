import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import {
  Activity, FileText, Banknote, TrendingUp, ChevronRight, Coins,
  Users, ArrowDownRight, Gauge, ShieldCheck,
} from 'lucide-react';

const num = (n: number) => Number(n || 0).toLocaleString();
const SINCE = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
const conv = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

/** Revenue attributed to each behavioural event that drives it. */
type StreamRow = {
  key: string;
  icon: any;
  event: string;
  eventCount: number;
  stream: string;
  revenue: number;
  color: string;
  note: string;
};

const TIER_ORDER = ['excellent', 'good', 'fair', 'building', 'new'];
const TIER_COLOR: Record<string, string> = {
  excellent: 'bg-emerald-500', good: 'bg-green-500', fair: 'bg-amber-500',
  building: 'bg-orange-500', new: 'bg-slate-400',
};

/**
 * Monetization Funnel Drill-Down
 *
 * Traces the path from raw behavioural signal → rent journey → funded journey →
 * billed fees → recognised revenue, then drills into which exact revenue streams
 * each behavioural event and trust-score tier drives.
 */
export function MonetizationFunnel() {
  const [expanded, setExpanded] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['ceo-monetization-funnel'],
    staleTime: 600000,
    queryFn: async () => {
      const head = async (table: string, mod?: (q: any) => any) => {
        let q = supabase.from(table as any).select('*', { count: 'exact', head: true });
        if (mod) q = mod(q);
        const { count } = await q;
        return count || 0;
      };
      const evt = (type: string, days = 90) =>
        head('system_events', (q) => q.eq('event_type', type).gte('created_at', SINCE(days)));
      const ledgerSum = async (categories: string[]) => {
        const { data } = await supabase
          .from('general_ledger')
          .select('amount')
          .in('category', categories)
          .eq('direction', 'cash_in')
          .neq('classification', 'admin_correction')
          .limit(20000);
        return (data || []).reduce((s, r) => s + Number(r.amount || 0), 0);
      };

      // Fee ledger (billed + recognised by fee type)
      const { data: feeRows } = await supabase
        .from('fee_revenue_ledger')
        .select('fee_type, total_amount, recognized_amount, tenant_id')
        .limit(20000);
      const fees = feeRows || [];
      const accessBilled = fees.filter((r) => r.fee_type === 'access_fee').reduce((s, r) => s + Number(r.total_amount || 0), 0);
      const platformBilled = fees.filter((r) => r.fee_type !== 'access_fee').reduce((s, r) => s + Number(r.total_amount || 0), 0);
      const totalBilled = accessBilled + platformBilled;
      const totalRecognised = fees.reduce((s, r) => s + Number(r.recognized_amount || 0), 0);

      const [
        signals, journeysStarted, journeysFunded,
        depositEvents, collectionEvents,
        cashFees, commissionPaid,
      ] = await Promise.all([
        head('system_events', (q) => q.gte('created_at', SINCE(90))),
        evt('rent_request_created'),
        evt('rent_request_funded'),
        evt('deposit_approved'),
        evt('agent_collection'),
        ledgerSum(['access_fee_collected', 'tenant_access_fee', 'registration_fee_collected']),
        ledgerSum(['agent_commission_earned', 'agent_commission']),
      ]);

      // ---- Trust-tier → revenue linkage ----
      const tenantIds = Array.from(new Set(fees.map((r) => r.tenant_id).filter(Boolean))) as string[];
      const tierByUser = new Map<string, string>();
      for (let i = 0; i < tenantIds.length; i += 300) {
        const chunk = tenantIds.slice(i, i + 300);
        const { data: tc } = await supabase
          .from('welile_trust_score_cache')
          .select('user_id, tier')
          .in('user_id', chunk);
        (tc || []).forEach((t: any) => tierByUser.set(t.user_id, t.tier));
      }
      const tierAgg: Record<string, { revenue: number; count: number }> = {};
      fees.forEach((r) => {
        const tier = (r.tenant_id && tierByUser.get(r.tenant_id)) || 'new';
        tierAgg[tier] = tierAgg[tier] || { revenue: 0, count: 0 };
        tierAgg[tier].revenue += Number(r.total_amount || 0);
        tierAgg[tier].count += 1;
      });
      const tiers = TIER_ORDER.map((t) => ({ tier: t, ...(tierAgg[t] || { revenue: 0, count: 0 }) }))
        .filter((t) => t.count > 0);

      const streams: StreamRow[] = [
        {
          key: 'access', icon: FileText, event: 'rent_request_created', eventCount: journeysStarted,
          stream: 'Access fee (billed)', revenue: accessBilled, color: 'bg-emerald-500/10 text-emerald-600',
          note: 'Each started rent journey books the access fee',
        },
        {
          key: 'platform', icon: TrendingUp, event: 'rent_request_funded', eventCount: journeysFunded,
          stream: 'Platform fee (billed)', revenue: platformBilled, color: 'bg-green-500/10 text-green-600',
          note: 'Funding a journey books the platform fee',
        },
        {
          key: 'cash', icon: Coins, event: 'deposit_approved', eventCount: depositEvents,
          stream: 'Cash fees collected', revenue: cashFees, color: 'bg-teal-500/10 text-teal-600',
          note: 'Approved deposits bank the fee cash',
        },
        {
          key: 'commission', icon: Users, event: 'agent_collection', eventCount: collectionEvents,
          stream: 'Agent commission facilitated', revenue: commissionPaid, color: 'bg-rose-500/10 text-rose-600',
          note: 'Field collections drive agent commission',
        },
      ];

      return {
        funnel: [
          { key: 'signal', label: 'Behavioural signals', sub: 'All events (90d)', value: signals, icon: Activity, revenue: 0 },
          { key: 'started', label: 'Rent journeys started', sub: 'rent_request_created', value: journeysStarted, icon: FileText, revenue: accessBilled },
          { key: 'funded', label: 'Rent journeys funded', sub: 'rent_request_funded', value: journeysFunded, icon: Banknote, revenue: platformBilled },
          { key: 'billed', label: 'Revenue billed', sub: 'Fees invoiced', value: fees.length, icon: Coins, revenue: totalBilled },
          { key: 'recognised', label: 'Revenue recognised', sub: 'Earned (ASC 606)', value: null, icon: TrendingUp, revenue: totalRecognised },
        ] as { key: string; label: string; sub: string; value: number | null; icon: any; revenue: number }[],
        streams,
        tiers,
        totalBilled,
      };
    },
  });

  const maxTierRev = useMemo(
    () => Math.max(1, ...(data?.tiers || []).map((t) => t.revenue)),
    [data],
  );

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2.5 p-3 sm:p-4 text-left hover:bg-muted/30 transition-colors"
      >
        <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
          <Gauge className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold leading-tight">Monetization Funnel Drill-Down</h3>
          <p className="text-xs text-muted-foreground">
            From behavioural signal → trust → the exact revenue streams it drives
          </p>
        </div>
        <ChevronRight className={cn('h-4 w-4 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
      </button>

      {/* Funnel bars — always visible */}
      <div className="px-3 sm:px-4 pb-3 space-y-1.5">
        {(data?.funnel || []).map((s, i) => {
          const prev = i > 0 ? data?.funnel[i - 1] : null;
          const prevVal = prev?.value ?? null;
          const width = data?.funnel[0]?.value
            ? Math.max(6, Math.round(((s.value ?? 0) / (data.funnel[0].value || 1)) * 100))
            : 6;
          return (
            <div key={s.key} className="relative">
              <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2">
                <s.icon className="h-4 w-4 text-primary shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold truncate">{s.label}</span>
                    <span className="text-sm font-bold tabular-nums shrink-0">
                      {isLoading ? '…' : s.value === null ? formatUGX(s.revenue) : num(s.value)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] text-muted-foreground truncate">{s.sub}</span>
                    {s.revenue > 0 && s.value !== null && (
                      <span className="text-[10px] text-emerald-600 font-medium shrink-0">{formatUGX(s.revenue)}</span>
                    )}
                  </div>
                  {s.value !== null && (
                    <div className="mt-1 h-1 w-full rounded-full bg-muted overflow-hidden">
                      <div className="h-full rounded-full bg-primary/60" style={{ width: `${width}%` }} />
                    </div>
                  )}
                </div>
              </div>
              {prev && s.value !== null && prevVal !== null && (
                <div className="flex items-center gap-1 pl-3 py-0.5 text-[10px] text-muted-foreground">
                  <ArrowDownRight className="h-3 w-3" />
                  {conv(s.value, prevVal)}% conversion from {prev.label.toLowerCase()}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {expanded && (
        <div className="border-t border-border p-3 sm:p-4 space-y-5">
          {/* Event → revenue stream */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              Behavioural event → revenue stream
            </h4>
            <div className="space-y-2">
              {(data?.streams || []).map((r) => (
                <div key={r.key} className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
                  <div className={cn('p-2 rounded-lg shrink-0', r.color)}>
                    <r.icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <code className="text-[11px] font-mono bg-muted px-1.5 py-0.5 rounded">{r.event}</code>
                      <span className="text-[10px] text-muted-foreground">×{num(r.eventCount)}</span>
                      <ChevronRight className="h-3 w-3 text-muted-foreground" />
                      <span className="text-xs font-semibold">{r.stream}</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{r.note}</p>
                  </div>
                  <span className="text-sm font-bold text-emerald-600 shrink-0 tabular-nums">{formatUGX(r.revenue)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Trust tier → revenue */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" /> Trust tier → billed revenue
            </h4>
            {(data?.tiers || []).length === 0 && !isLoading && (
              <p className="text-xs text-muted-foreground">No trust-linked revenue yet.</p>
            )}
            <div className="space-y-2">
              {(data?.tiers || []).map((t) => (
                <div key={t.tier} className="flex items-center gap-3">
                  <span className="w-20 text-xs font-medium capitalize shrink-0">{t.tier}</span>
                  <div className="flex-1 h-5 rounded-full bg-muted overflow-hidden">
                    <div
                      className={cn('h-full rounded-full', TIER_COLOR[t.tier] || 'bg-primary')}
                      style={{ width: `${Math.max(4, Math.round((t.revenue / maxTierRev) * 100))}%` }}
                    />
                  </div>
                  <span className="w-28 text-right text-xs font-bold tabular-nums shrink-0">{formatUGX(t.revenue)}</span>
                  <span className="w-16 text-right text-[10px] text-muted-foreground shrink-0">{num(t.count)} recs</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}