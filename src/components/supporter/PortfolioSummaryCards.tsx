import { useState } from 'react';
import { InvestmentBreakdownSheet } from '@/components/supporter/InvestmentBreakdownSheet';
import { FullScreenWalletSheet } from '@/components/wallet/FullScreenWalletSheet';
import { hapticTap } from '@/lib/haptics';
import { useCurrency } from '@/hooks/useCurrency';
import { Wallet, ChevronRight, TrendingUp, ArrowUpRight, Home, Shield } from 'lucide-react';

interface PortfolioSummaryCardsProps {
  housesFunded: number;
  rentSecured: number;
  walletBalance?: number;
  portfolioHealth: 'stable' | 'at_risk' | 'growing';
  totalReturn?: number;
}

export function PortfolioSummaryCards({ housesFunded, rentSecured, walletBalance = 0, totalReturn = 0 }: PortfolioSummaryCardsProps) {
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [showWallet, setShowWallet] = useState(false);
  const { formatAmount, formatAmountCompact } = useCurrency();

  const investmentBasedHouses = rentSecured > 0 ? Math.max(1, Math.floor(rentSecured / 300000)) : 0;
  const displayHouses = Math.max(housesFunded, investmentBasedHouses);
  const totalPortfolio = walletBalance + rentSecured;

  return (
    <>
      <div className="portfolio-hero-card rounded-3xl p-5 relative overflow-hidden">
        {/* Decorative elements */}
        <div className="absolute -top-16 -right-16 w-48 h-48 rounded-full bg-primary-foreground/[0.06] pointer-events-none" />
        <div className="absolute -bottom-12 -left-12 w-36 h-36 rounded-full bg-primary-foreground/[0.04] pointer-events-none" />
        <div className="absolute top-1/2 right-0 w-64 h-[1px] bg-gradient-to-l from-transparent via-primary-foreground/10 to-transparent pointer-events-none" />

        <div className="relative z-10 space-y-5">
          {/* Top Label Bar */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-primary-foreground/15 backdrop-blur-sm">
                <Shield className="h-3.5 w-3.5 text-primary-foreground/90" />
              </div>
              <span className="text-[11px] font-semibold text-primary-foreground/70 uppercase tracking-[0.12em]">
                Portfolio Overview
              </span>
            </div>
            <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary-foreground/10 backdrop-blur-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[9px] font-bold text-emerald-300 uppercase tracking-wider">Active</span>
            </div>
          </div>

          {/* Main Balance — Tappable */}
          <button
            onClick={() => { hapticTap(); setShowWallet(true); }}
            className="w-full text-left group"
          >
            <p className="text-[10px] uppercase tracking-[0.15em] font-semibold text-primary-foreground/60 mb-1.5 flex items-center gap-1.5">
              <Wallet className="h-3 w-3" />
              Total Balance
            </p>
            <div className="flex items-baseline gap-2 min-w-0 w-full">
              <p className="text-[clamp(1.1rem,4.5vw,2.25rem)] font-black tracking-tight leading-none text-primary-foreground truncate w-full">
                {formatAmount(walletBalance)}
              </p>
            </div>
            <div className="flex items-center gap-2 mt-2">
              <span className="text-xs font-bold text-primary-foreground">
                Withdrawable: {formatAmountCompact(walletBalance)}
              </span>
            </div>
            {totalReturn > 0 && (
              <div className="flex items-center gap-1.5 mt-1">
                <div className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-emerald-500/20">
                  <ArrowUpRight className="h-3 w-3 text-emerald-300" />
                  <span className="text-[11px] font-bold text-emerald-300">
                    +{formatAmountCompact(totalReturn)}/mo
                  </span>
                </div>
              </div>
            )}
          </button>

          {/* Divider */}
          <div className="h-[1px] bg-primary-foreground/10" />

          {/* Stats Grid — 3 columns */}
          <div className="grid grid-cols-3 gap-2">
            {/* Houses */}
            <div className="portfolio-stat-cell-v2 rounded-xl px-2 py-3 text-center">
              <div className="flex items-center justify-center mb-1.5">
                <Home className="h-3.5 w-3.5 text-primary-foreground/60" />
              </div>
              <p className="text-xl font-black leading-none text-primary-foreground">{displayHouses}</p>
              <p className="text-[8px] uppercase tracking-[0.14em] font-bold text-primary-foreground/50 mt-1.5">Houses</p>
            </div>

            {/* Monthly Return */}
            <div className="portfolio-stat-cell-v2 rounded-xl px-1.5 py-3 text-center overflow-hidden">
              <div className="flex items-center justify-center mb-1.5">
                <TrendingUp className="h-3.5 w-3.5 text-emerald-400/80" />
              </div>
              <p className="text-sm font-black leading-none text-primary-foreground truncate" title={formatAmount(totalReturn)}>
                {formatAmountCompact(totalReturn)}
              </p>
              <p className="text-[8px] uppercase tracking-[0.14em] font-bold text-primary-foreground/50 mt-1.5">Return/mo</p>
            </div>

            {/* Supported — Opens breakdown */}
            <button
              onClick={() => { hapticTap(); setShowBreakdown(true); }}
              className="portfolio-stat-cell-v2 rounded-xl px-1.5 py-3 text-center overflow-hidden hover:bg-primary-foreground/20 active:scale-95 transition-all cursor-pointer"
            >
              <div className="flex items-center justify-center mb-1.5">
                <Wallet className="h-3.5 w-3.5 text-amber-400/80" />
              </div>
              <p className="text-sm font-black leading-none text-primary-foreground truncate" title={formatAmount(rentSecured)}>
                {formatAmountCompact(rentSecured)}
              </p>
              <p className="text-[8px] uppercase tracking-[0.14em] font-bold text-primary-foreground/50 mt-1.5 flex items-center justify-center gap-0.5">
                Deployed
                <ChevronRight className="h-2.5 w-2.5" />
              </p>
            </button>
          </div>

          {/* Trust Strip */}
          <div className="flex items-center justify-between px-1 pt-1">
            <div className="flex items-center gap-1.5">
              <Shield className="h-3 w-3 text-primary-foreground/40" />
              <span className="text-[9px] text-primary-foreground/40 font-medium">Capital Protected</span>
            </div>
            <span className="text-[9px] text-primary-foreground/40 font-medium">
              Portfolio: {formatAmountCompact(totalPortfolio)}
            </span>
          </div>
        </div>
      </div>

      {showBreakdown && <InvestmentBreakdownSheet open={showBreakdown} onOpenChange={setShowBreakdown} />}
      {showWallet && <FullScreenWalletSheet open={showWallet} onOpenChange={setShowWallet} />}
    </>
  );
}
