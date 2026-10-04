import { useState } from 'react';
import { TrendingUp, Shield, Clock, Wallet, ChevronRight, Zap, Users, Home, CheckCircle2 } from 'lucide-react';
import { useCurrency } from '@/hooks/useCurrency';
import { useOpportunitySummary } from '@/hooks/useOpportunitySummary';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FundRentDialog } from './FundRentDialog';
import { InvestmentWithdrawButton } from './InvestmentWithdrawButton';

export function OpportunitySummaryCard() {
  const { summary, loading } = useOpportunitySummary();
  const { formatAmount, formatAmountCompact } = useCurrency();
  const [showFundDialog, setShowFundDialog] = useState(false);

  if (loading) {
    return <div className="h-48 rounded-2xl bg-muted/50 animate-pulse" />;
  }

  if (!summary) {
    return (
      <div className="text-center py-8 text-sm text-muted-foreground rounded-2xl border-2 border-dashed border-border/60 font-medium">
        No active opportunities at this time
      </div>
    );
  }

  const metrics = [
    { label: 'Active Requests', value: summary.total_requests, icon: Home },
    { label: 'Verified Landlords', value: summary.total_landlords, icon: Users },
    { label: 'Field Agents', value: summary.total_agents, icon: CheckCircle2 },
  ];

  return (
    <>
      <div
        className="rounded-2xl border border-border/80 bg-card overflow-hidden shadow-sm"
      >
        {/* Header bar */}
        <div className="px-5 pt-5 pb-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-primary/10">
              <TrendingUp className="h-4.5 w-4.5 text-primary" />
            </div>
            <div>
              <h3 className="font-black text-foreground text-sm tracking-tight">Rent Requests</h3>
              <p className="text-[10px] text-muted-foreground font-medium leading-tight">Rent demand from our agent network in the field</p>
            </div>
          </div>
          <Badge variant="outline" className="text-[9px] px-2 py-0.5 border-success/40 text-success bg-success/5 font-bold uppercase tracking-wider">
            <span className="w-1.5 h-1.5 rounded-full bg-success mr-1 animate-pulse" />
            Active
          </Badge>
        </div>

        {/* Main figure */}
        <div className="px-5 pb-4">
          <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider mb-1">Total Rent Demand</p>
          <p className="text-lg sm:text-3xl font-black text-foreground tracking-tight leading-none truncate">
            <span className="sm:hidden">{formatAmountCompact(summary.total_rent_requested)}</span>
            <span className="hidden sm:inline">{formatAmount(summary.total_rent_requested)}</span>
          </p>
          <p className="mt-2 text-[11px] font-semibold italic bg-gradient-to-r from-[hsl(270,80%,60%)] to-[hsl(300,70%,55%)] bg-clip-text text-transparent tracking-wide">
            ✨ Welile is turning rent into an asset
          </p>
        </div>

        {/* Key metrics row */}
        <div className="grid grid-cols-3 gap-px bg-border/50">
          {metrics.map(({ label, value, icon: Icon }) => (
            <div key={label} className="bg-card flex flex-col items-center py-3 px-2">
              <Icon className="h-3.5 w-3.5 text-muted-foreground mb-1" />
              <p className="text-lg font-black text-foreground leading-none">{value}</p>
              <p className="text-[9px] text-muted-foreground font-semibold mt-0.5 text-center">{label}</p>
            </div>
          ))}
        </div>

        {/* Returns & terms */}
        <div className="px-5 py-4 space-y-2.5 bg-muted/20">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <TrendingUp className="h-3 w-3 text-success" />
              <span className="font-medium">Monthly Return</span>
            </div>
            <span className="text-sm font-black text-success">Up to 15%</span>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Zap className="h-3 w-3" />
              <span className="font-medium">Deployment Speed</span>
            </div>
            <span className="text-xs font-bold text-foreground">24–72 hours</span>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Wallet className="h-3 w-3" />
              <span className="font-medium">Payouts</span>
            </div>
            <span className="text-xs font-bold text-foreground">Monthly to wallet</span>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Shield className="h-3 w-3" />
              <span className="font-medium">Risk Control</span>
            </div>
            <span className="text-xs font-bold text-foreground">Verified & insured</span>
          </div>
        </div>

        {/* CTA */}
        <div className="px-5 pt-3 pb-4 space-y-3">
          <Button
            onClick={() => setShowFundDialog(true)}
            className="w-full gap-2 rounded-xl font-bold h-12 text-sm"
          >
            SUPPORT TENANT
            <ChevronRight className="h-4 w-4" />
          </Button>

          <InvestmentWithdrawButton />

          {/* Micro-copy trust signals */}
          <div className="flex items-center justify-center gap-3 text-[10px] text-muted-foreground pt-1">
            <span className="flex items-center gap-1">
              <Clock className="h-2.5 w-2.5" />
              Avg. cycle: 30 days
            </span>
            <span className="text-border">•</span>
            <span className="sm:hidden">Min: {formatAmountCompact(50000)}</span>
            <span className="hidden sm:inline">Min: {formatAmount(50000)}</span>
          </div>

          <p className="text-[9px] text-muted-foreground/60 text-center leading-relaxed">
            Returns are projected based on historical performance. Capital is deployed into verified rent facilitation agreements managed by Welile with reserve protection.
          </p>
        </div>

        {/* Notes */}
        {summary.notes && (
          <div className="px-5 pb-4">
            <p className="text-[10px] text-muted-foreground italic">📝 {summary.notes}</p>
          </div>
        )}
      </div>

      <FundRentDialog
        open={showFundDialog}
        onOpenChange={setShowFundDialog}
        summary={summary}
      />
    </>
  );
}
