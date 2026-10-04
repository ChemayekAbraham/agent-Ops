import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { TrendingUp, Banknote, Percent, Wallet, Loader2 } from 'lucide-react';
import {
  formatUGX,
  projectOutstanding,
  AGENT_COMMISSION_RATE,
} from '@/lib/businessAdvanceCalculations';

/**
 * Per-advance "How we make money" breakdown card.
 * Shows:
 *  - Principal we'll deploy
 *  - Expected gross interest at 30/60/90d (1% daily compounding)
 *  - Agent commission cost (4% per repayment)
 *  - Estimated net profit at 30 / 60 / 90 d horizons
 */
export function BusinessAdvanceEconomicsCard({
  principal,
  outstanding,
}: {
  principal: number;
  outstanding: number;
}) {
  const projection = (days: number) => {
    const closing = projectOutstanding(outstanding, days);
    const grossInterest = closing - outstanding;
    const totalRepay = principal + grossInterest;
    const agentCommission = Math.round(totalRepay * AGENT_COMMISSION_RATE);
    const netProfit = grossInterest - agentCommission;
    const apy = principal > 0 ? (grossInterest / principal) * 100 : 0;
    return { closing, grossInterest, agentCommission, netProfit, apy };
  };

  const d30 = projection(30);
  const d60 = projection(60);
  const d90 = projection(90);

  return (
    <div className="rounded-2xl border-2 border-primary/30 bg-gradient-to-br from-primary/5 via-card to-accent/5 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <TrendingUp className="h-4 w-4 text-primary" />
        <h4 className="text-sm font-bold">How we make money on this advance</h4>
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs">
        {[
          { label: 'After 30d', d: d30 },
          { label: 'After 60d', d: d60 },
          { label: 'After 90d', d: d90 },
        ].map(({ label, d }) => (
          <div key={label} className="rounded-xl bg-background p-3 space-y-1.5">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold">
              {label}
            </p>
            <p className="text-base font-black text-emerald-600">{formatUGX(d.netProfit)}</p>
            <p className="text-[10px] text-muted-foreground">net profit</p>
            <div className="pt-1 border-t border-border/50 space-y-0.5">
              <div className="flex justify-between text-[10px]">
                <span className="text-muted-foreground">Gross interest</span>
                <span className="font-bold">{formatUGX(d.grossInterest)}</span>
              </div>
              <div className="flex justify-between text-[10px]">
                <span className="text-muted-foreground">Agent fee (4%)</span>
                <span className="font-bold text-red-500">−{formatUGX(d.agentCommission)}</span>
              </div>
              <div className="flex justify-between text-[10px] pt-0.5">
                <span className="text-muted-foreground">Effective yield</span>
                <span className="font-bold text-primary">{d.apy.toFixed(0)}%</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <p className="text-[10px] text-muted-foreground">
        💡 1% daily compounding on outstanding balance. Tenant repays openly. Agent earns 4% of every
        repayment as platform commission (booked to general_admin_expense). Default risk reserve is
        netted out at portfolio level.
      </p>
    </div>
  );
}

/**
 * Aggregate book economics for all CFO-stage business advances.
 * Shown above the disbursement queue so the CFO sees the whole book at a glance.
 */
export function BusinessAdvancePortfolioPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ['business-advance-portfolio-economics'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('business_advances')
        .select('status, principal, outstanding_balance, total_interest_accrued, total_repaid');
      if (error) throw error;
      return data || [];
    },
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const rows = data || [];
  const pendingDisbursement = rows.filter((r: any) => r.status === 'coo_approved');
  const active = rows.filter((r: any) => r.status === 'active');

  const sum = (xs: any[], k: string) => xs.reduce((s, r) => s + Number(r[k] || 0), 0);

  const queuedPrincipal = sum(pendingDisbursement, 'principal');
  const activePrincipal = sum(active, 'principal');
  const activeOutstanding = sum(active, 'outstanding_balance');
  const accruedInterestToDate = sum(active, 'total_interest_accrued');
  const repaidToDate = sum(active, 'total_repaid');

  // Forward expected book profit (30d) on the whole active book at 1%/day
  const projected30d = active.reduce((s: number, r: any) => {
    const out = Number(r.outstanding_balance || 0);
    return s + (projectOutstanding(out, 30) - out);
  }, 0);
  const projectedNet30d = projected30d * (1 - AGENT_COMMISSION_RATE);

  const portfolioYield =
    activePrincipal > 0 ? (accruedInterestToDate / activePrincipal) * 100 : 0;

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border-2 border-primary/30 bg-gradient-to-br from-primary/10 via-card to-accent/10 p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Banknote className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-bold">Business Advance — Book Economics</h3>
          </div>
          <span className="text-[10px] uppercase font-bold text-muted-foreground">
            Live position
          </span>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <Card className="bg-background/60">
            <CardContent className="p-3">
              <p className="text-[10px] uppercase font-bold text-muted-foreground">
                Awaiting disbursement
              </p>
              <p className="text-lg font-black text-amber-600 mt-1">{formatUGX(queuedPrincipal)}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {pendingDisbursement.length} advance{pendingDisbursement.length === 1 ? '' : 's'}
              </p>
            </CardContent>
          </Card>

          <Card className="bg-background/60">
            <CardContent className="p-3">
              <p className="text-[10px] uppercase font-bold text-muted-foreground">Active book</p>
              <p className="text-lg font-black text-primary mt-1">{formatUGX(activeOutstanding)}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                of {formatUGX(activePrincipal)} deployed
              </p>
            </CardContent>
          </Card>

          <Card className="bg-background/60">
            <CardContent className="p-3">
              <p className="text-[10px] uppercase font-bold text-muted-foreground flex items-center gap-1">
                <Percent className="h-3 w-3" /> Yield to date
              </p>
              <p className="text-lg font-black text-emerald-600 mt-1">
                {portfolioYield.toFixed(1)}%
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {formatUGX(accruedInterestToDate)} accrued
              </p>
            </CardContent>
          </Card>

          <Card className="bg-background/60">
            <CardContent className="p-3">
              <p className="text-[10px] uppercase font-bold text-muted-foreground flex items-center gap-1">
                <Wallet className="h-3 w-3" /> Repaid
              </p>
              <p className="text-lg font-black text-foreground mt-1">{formatUGX(repaidToDate)}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">collected so far</p>
            </CardContent>
          </Card>
        </div>

        <div className="mt-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-3 flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase font-bold text-emerald-700 dark:text-emerald-400">
              Projected net profit · next 30 days
            </p>
            <p className="text-xl font-black text-emerald-700 dark:text-emerald-400 mt-0.5">
              {formatUGX(Math.round(projectedNet30d))}
            </p>
          </div>
          <div className="text-right text-[10px] text-muted-foreground max-w-[180px]">
            On active book at 1%/day compounding, after the 4% agent commission booked as platform
            expense.
          </div>
        </div>
      </div>
    </div>
  );
}
