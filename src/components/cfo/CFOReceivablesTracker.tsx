import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { Banknote, TrendingUp, PieChart, ChevronDown, ChevronUp, Receipt } from 'lucide-react';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Progress } from '@/components/ui/progress';

interface Receivable {
  id: string;
  rent_amount: number;
  amount_repaid: number;
  total_repayment: number;
  access_fee: number;
  request_fee: number;
  status: string;
  funded_at: string | null;
  tenant_name: string;
  landlord_name: string;
  daily_repayment: number | null;
  duration_days: number | null;
}

export function CFOReceivablesTracker() {
  const [expanded, setExpanded] = useState(false);
  const [advanceExpanded, setAdvanceExpanded] = useState(false);

  // Advance access fee receivables
  const { data: advanceReceivables = [] } = useQuery({
    queryKey: ['cfo-advance-fee-receivables'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_advances')
        .select('id, agent_id, access_fee, access_fee_collected, access_fee_status, status, expires_at, profiles!agent_advances_agent_id_fkey(full_name)')
        .in('status', ['active', 'overdue'])
        .gt('access_fee', 0)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    staleTime: 300_000,
  });

  const totalAdvanceFees = advanceReceivables.reduce((s: number, a: any) => s + Number(a.access_fee || 0), 0);
  const totalAdvanceCollected = advanceReceivables.reduce((s: number, a: any) => s + Number(a.access_fee_collected || 0), 0);
  const totalAdvanceOutstanding = totalAdvanceFees - totalAdvanceCollected;
  const advanceCollectionRate = totalAdvanceFees > 0 ? (totalAdvanceCollected / totalAdvanceFees) * 100 : 0;

  const { data: receivables, isLoading } = useQuery({
    queryKey: ['cfo-receivables'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('rent_requests')
        .select(`
          id, rent_amount, amount_repaid, total_repayment, access_fee, request_fee,
          status, funded_at, daily_repayment, duration_days, tenant_id, landlord_id
        `)
        .in('status', ['funded', 'disbursed', 'repaying'])
        .order('funded_at', { ascending: false })
        .limit(100);

      if (error) throw error;
      if (!data || data.length === 0) return [] as Receivable[];

      const tenantIds = [...new Set(data.map(r => r.tenant_id).filter(Boolean))] as string[];
      const landlordIds = [...new Set(data.map(r => r.landlord_id).filter(Boolean))] as string[];

      const [profilesRes, landlordsRes] = await Promise.all([
        supabase.from('profiles').select('id, full_name').in('id', tenantIds),
        supabase.from('landlords').select('id, name').in('id', landlordIds),
      ]);

      const profileMap = Object.fromEntries((profilesRes.data || []).map(p => [p.id, p.full_name]));
      const landlordMap = Object.fromEntries((landlordsRes.data || []).map(l => [l.id, l.name]));

      return data.map((r: any) => ({
        id: r.id,
        rent_amount: r.rent_amount || 0,
        amount_repaid: r.amount_repaid || 0,
        total_repayment: r.total_repayment || 0,
        access_fee: r.access_fee || 0,
        request_fee: r.request_fee || 0,
        status: r.status,
        funded_at: r.funded_at,
        daily_repayment: r.daily_repayment,
        duration_days: r.duration_days,
        tenant_name: profileMap[r.tenant_id] || 'Unknown',
        landlord_name: landlordMap[r.landlord_id] || 'Unknown',
      })) as Receivable[];
    },
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  });

  const rows = receivables || [];

  // Revenue recognition calculations
  const totals = rows.reduce((acc, r) => {
    const totalFees = r.access_fee + r.request_fee;
    const grossRepayment = r.total_repayment > 0 ? r.total_repayment : r.rent_amount + totalFees;
    const repaymentRatio = grossRepayment > 0 ? r.amount_repaid / grossRepayment : 0;

    // Proportional revenue recognition
    const recognizedAccessFee = r.access_fee * repaymentRatio;
    const recognizedRequestFee = r.request_fee * repaymentRatio;
    const deferredAccessFee = r.access_fee - recognizedAccessFee;
    const deferredRequestFee = r.request_fee - recognizedRequestFee;

    acc.totalFunded += r.rent_amount;
    acc.totalRepaid += r.amount_repaid;
    acc.totalAccessFees += r.access_fee;
    acc.totalRequestFees += r.request_fee;
    acc.recognizedAccessFees += recognizedAccessFee;
    acc.recognizedRequestFees += recognizedRequestFee;
    acc.deferredAccessFees += deferredAccessFee;
    acc.deferredRequestFees += deferredRequestFee;
    return acc;
  }, {
    totalFunded: 0, totalRepaid: 0,
    totalAccessFees: 0, totalRequestFees: 0,
    recognizedAccessFees: 0, recognizedRequestFees: 0,
    deferredAccessFees: 0, deferredRequestFees: 0,
  });

  const totalRecognized = totals.recognizedAccessFees + totals.recognizedRequestFees;
  const totalDeferred = totals.deferredAccessFees + totals.deferredRequestFees;
  const totalRevenue = totals.totalAccessFees + totals.totalRequestFees;
  const recognitionRate = totalRevenue > 0 ? (totalRecognized / totalRevenue) * 100 : 0;
  const totalOutstanding = totals.totalFunded - totals.totalRepaid;
  const fundedCount = rows.filter(r => r.status === 'funded').length;
  const repayingCount = rows.filter(r => r.status === 'repaying').length;

  const getStatusDot = (status: string) => {
    switch (status) {
      case 'funded': return 'bg-amber-500';
      case 'disbursed': return 'bg-blue-500';
      case 'repaying': return 'bg-emerald-500';
      default: return 'bg-muted-foreground';
    }
  };

  if (isLoading) {
    return <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <TrendingUp className="h-3.5 w-3.5 text-primary" />
          Receivables & Revenue
        </h3>
        <span className="text-[10px] text-muted-foreground">{rows.length} active</span>
      </div>

      {/* Principal KPIs */}
      <div className="grid grid-cols-4 gap-1.5">
        {[
          { label: 'Funded', value: formatUGX(totals.totalFunded) },
          { label: 'Outstanding', value: formatUGX(totalOutstanding), accent: 'text-amber-600' },
          { label: 'Awaiting', value: String(fundedCount) },
          { label: 'Repaying', value: String(repayingCount) },
        ].map(k => (
          <div key={k.label} className="rounded-lg bg-muted/40 px-2 py-1.5 text-center">
            <p className="text-[8px] uppercase tracking-wider text-muted-foreground">{k.label}</p>
            <p className={`text-[11px] font-bold font-mono truncate ${k.accent || ''}`}>{k.value}</p>
          </div>
        ))}
      </div>

      {/* Revenue Recognition Breakdown */}
      <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold flex items-center gap-1.5">
            <PieChart className="h-3 w-3 text-primary" />
            Revenue Recognition
          </h4>
          <Badge variant="outline" className="text-[9px] font-mono border-primary/30 text-primary">
            {recognitionRate.toFixed(1)}% recognized
          </Badge>
        </div>

        {/* Recognition progress bar */}
        <div className="space-y-1">
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>Recognition Progress</span>
            <span className="font-mono">{formatUGX(totalRecognized)} / {formatUGX(totalRevenue)}</span>
          </div>
          <Progress value={recognitionRate} className="h-2" />
        </div>

        {/* Revenue split */}
        <div className="grid grid-cols-2 gap-2">
          {/* Access Fees */}
          <div className="rounded-lg bg-card border border-border/60 p-2 space-y-1.5">
            <p className="text-[9px] font-medium text-muted-foreground uppercase tracking-wider">Access Fees</p>
            <p className="text-sm font-bold font-mono">{formatUGX(totals.totalAccessFees)}</p>
            <div className="flex justify-between text-[9px]">
              <span className="text-emerald-600">✓ {formatUGX(totals.recognizedAccessFees)}</span>
              <span className="text-amber-600">◷ {formatUGX(totals.deferredAccessFees)}</span>
            </div>
          </div>

          {/* Request Fees */}
          <div className="rounded-lg bg-card border border-border/60 p-2 space-y-1.5">
            <p className="text-[9px] font-medium text-muted-foreground uppercase tracking-wider">Request Fees</p>
            <p className="text-sm font-bold font-mono">{formatUGX(totals.totalRequestFees)}</p>
            <div className="flex justify-between text-[9px]">
              <span className="text-emerald-600">✓ {formatUGX(totals.recognizedRequestFees)}</span>
              <span className="text-amber-600">◷ {formatUGX(totals.deferredRequestFees)}</span>
            </div>
          </div>
        </div>

        {/* Summary row */}
        <div className="flex justify-between items-center pt-1 border-t border-border/40">
          <div className="flex items-center gap-3 text-[10px]">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> Recognized</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500 inline-block" /> Deferred</span>
          </div>
          <div className="text-[10px] font-mono">
            <span className="text-emerald-600 font-semibold">{formatUGX(totalRecognized)}</span>
            <span className="text-muted-foreground mx-1">/</span>
            <span className="text-amber-600 font-semibold">{formatUGX(totalDeferred)}</span>
          </div>
        </div>
      </div>

      {/* Expandable list */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors py-1"
      >
        {expanded ? 'Hide' : 'Show'} individual receivables
        {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>

      {expanded && (
        rows.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground">
            <Banknote className="h-6 w-6 mx-auto mb-1.5 opacity-30" />
            <p className="text-xs">No active receivables</p>
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card divide-y divide-border max-h-72 overflow-y-auto">
            {rows.map((r) => {
              const totalFees = r.access_fee + r.request_fee;
              const gross = r.total_repayment > 0 ? r.total_repayment : r.rent_amount + totalFees;
              const pct = gross > 0 ? Math.round((r.amount_repaid / gross) * 100) : 0;
              const ratio = gross > 0 ? r.amount_repaid / gross : 0;
              const revRecognized = totalFees * ratio;

              return (
                <div key={r.id} className="px-3 py-2.5 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${getStatusDot(r.status)}`} />
                      <span className="text-xs font-medium truncate">{r.tenant_name}</span>
                    </div>
                    <span className="text-[10px] font-mono font-semibold shrink-0">{formatUGX(r.rent_amount)}</span>
                  </div>

                  {/* Progress bar */}
                  <div className="flex items-center gap-2">
                    <div className="flex-1 bg-muted rounded-full h-1">
                      <div
                        className={`h-1 rounded-full transition-all ${
                          pct >= 80 ? 'bg-emerald-500' : pct >= 40 ? 'bg-amber-500' : 'bg-destructive'
                        }`}
                        style={{ width: `${Math.min(pct, 100)}%` }}
                      />
                    </div>
                    <span className="text-[10px] font-mono text-muted-foreground w-8 text-right">{pct}%</span>
                  </div>

                  <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    <span className="truncate">→ {r.landlord_name}</span>
                    <span className="font-mono text-emerald-600">Rev: {formatUGX(revRecognized)}</span>
                  </div>

                  {r.funded_at && (
                    <div className="text-[9px] text-muted-foreground text-right">{format(new Date(r.funded_at), 'dd MMM yyyy')}</div>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}
      {/* ════════════════════════════════════════════════════════ */}
      {/* ADVANCE ACCESS FEE RECEIVABLES SECTION */}
      {/* ════════════════════════════════════════════════════════ */}
      <div className="pt-3 border-t border-border/50">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <Receipt className="h-3.5 w-3.5 text-blue-600" />
            Advance Access Fee Receivables
          </h3>
          <span className="text-[10px] text-muted-foreground">{advanceReceivables.length} active</span>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-3 gap-1.5 mb-3">
          {[
            { label: 'Total Fees', value: formatUGX(totalAdvanceFees) },
            { label: 'Collected', value: formatUGX(totalAdvanceCollected), accent: 'text-emerald-600' },
            { label: 'Outstanding', value: formatUGX(totalAdvanceOutstanding), accent: 'text-amber-600' },
          ].map(k => (
            <div key={k.label} className="rounded-lg bg-muted/40 px-2 py-1.5 text-center">
              <p className="text-[8px] uppercase tracking-wider text-muted-foreground">{k.label}</p>
              <p className={`text-[11px] font-bold font-mono truncate ${k.accent || ''}`}>{k.value}</p>
            </div>
          ))}
        </div>

        {/* Collection progress */}
        <div className="space-y-1 mb-3">
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>Collection Rate</span>
            <span className="font-mono">{advanceCollectionRate.toFixed(1)}%</span>
          </div>
          <Progress value={advanceCollectionRate} className="h-2" />
        </div>

        {/* Expandable list */}
        <button
          onClick={() => setAdvanceExpanded(!advanceExpanded)}
          className="w-full flex items-center justify-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors py-1"
        >
          {advanceExpanded ? 'Hide' : 'Show'} advance fee details
          {advanceExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>

        {advanceExpanded && (
          advanceReceivables.length === 0 ? (
            <div className="text-center py-4 text-muted-foreground">
              <Receipt className="h-5 w-5 mx-auto mb-1 opacity-30" />
              <p className="text-xs">No advance fee receivables</p>
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-card divide-y divide-border max-h-60 overflow-y-auto mt-2">
              {advanceReceivables.map((adv: any) => {
                const fee = Number(adv.access_fee || 0);
                const collected = Number(adv.access_fee_collected || 0);
                const outstanding = fee - collected;
                const pct = fee > 0 ? Math.round((collected / fee) * 100) : 0;
                const feeStatus = adv.access_fee_status || 'unpaid';

                return (
                  <div key={adv.id} className="px-3 py-2.5 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium truncate">{adv.profiles?.full_name || 'Unknown'}</span>
                      <Badge variant="outline" className={
                        feeStatus === 'settled' ? 'border-emerald-500/30 text-emerald-600 text-[9px]' :
                        feeStatus === 'partial' ? 'border-amber-500/30 text-amber-600 text-[9px]' :
                        'border-destructive/30 text-destructive text-[9px]'
                      }>
                        {feeStatus}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-muted rounded-full h-1">
                        <div
                          className={`h-1 rounded-full transition-all ${
                            pct >= 80 ? 'bg-emerald-500' : pct >= 40 ? 'bg-amber-500' : 'bg-destructive'
                          }`}
                          style={{ width: `${Math.min(pct, 100)}%` }}
                        />
                      </div>
                      <span className="text-[10px] font-mono text-muted-foreground w-8 text-right">{pct}%</span>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                      <span className="font-mono">Fee: {formatUGX(fee)}</span>
                      <span className="font-mono text-emerald-600">Paid: {formatUGX(collected)}</span>
                      <span className="font-mono text-amber-600">Owed: {formatUGX(outstanding)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )
        )}
      </div>
    </div>
  );
}
