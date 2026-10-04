import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  CreditCard, Calculator, Menu, BadgeCheck, Wallet, ChevronRight,
  Shield, ArrowUpRight, TrendingUp, Home
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useProfile } from '@/hooks/useProfile';
import { UserAvatar } from '@/components/UserAvatar';
import { useWallet } from '@/hooks/useWallet';
import { useCurrency } from '@/hooks/useCurrency';
import { hapticTap } from '@/lib/haptics';
import DashboardHeader from '@/components/DashboardHeader';

import AiIdButton from '@/components/ai-id/AiIdButton';
import { NotificationBell } from '@/components/supporter/NotificationBell';
import { MerchantCodePills } from '@/components/supporter/MerchantCodePills';
import { VerificationChecklist } from '@/components/shared/VerificationChecklist';
import { InviteAndEarnCard } from '@/components/shared/InviteAndEarnCard';
import { CapitalOpportunityEntry } from '@/components/angel-pool/CapitalOpportunityEntry';
import { useAuth } from '@/hooks/useAuth';
import { FullScreenWalletSheet } from '@/components/wallet/FullScreenWalletSheet';

export default function AngelPool() {
  const navigate = useNavigate();
  const { profile } = useProfile();
  const { wallet } = useWallet();
  const { formatAmount, formatAmountCompact } = useCurrency();
  const { user, role: currentRole, roles: availableRoles, switchRole, signOut } = useAuth();
  const [showWallet, setShowWallet] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const poolRef = useRef<HTMLDivElement>(null);
  const calcRef = useRef<HTMLDivElement>(null);

  const scrollToPool = () => poolRef.current?.scrollIntoView({ behavior: 'smooth' });
  const scrollToCalc = () => calcRef.current?.scrollIntoView({ behavior: 'smooth' });

  const walletBalance = wallet?.balance ?? 0;

  // Mock data for the portfolio hero
  const myInvestment = 5_000_000;
  const myShares = Math.floor(myInvestment / 20_000);
  const monthlyReturn = myInvestment * 0.15;

  const menuItems = [
    { icon: CreditCard, label: 'Add Funding\n\n', onClick: scrollToCalc },
  ];

  return (
    <div className="h-dvh bg-background flex flex-col overflow-hidden">
      {/* ═══ HEADER — Same as funder ═══ */}
      <DashboardHeader
        currentRole={currentRole || 'supporter'}
        availableRoles={availableRoles.length ? availableRoles : ['supporter']}
        onRoleChange={switchRole}
        onSignOut={signOut}
        menuItems={menuItems}
        headerActions={user ? <NotificationBell userId={user.id} /> : undefined}
      />

      <div className="flex-1 min-h-0 overflow-y-auto pb-28 md:pb-4 overscroll-contain">
        <main className="px-3 xs:px-4 py-4 xs:py-5 space-y-5 max-w-lg mx-auto pb-8">

          {/* ═══ INLINE GREETING BAR — Same as funder ═══ */}
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <button onClick={() => navigate('/settings')} className="shrink-0 min-h-[44px] min-w-[44px]">
                <UserAvatar avatarUrl={profile?.avatar_url} fullName={profile?.full_name} size="md" />
              </button>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] text-muted-foreground font-medium">Welcome back</p>
                <h1 className="font-bold text-lg leading-tight flex items-center gap-1.5">
                  <span className="break-words">{profile?.full_name?.split(' ')[0] || 'Investor'}</span>
                  {profile?.verified ? (
                    <BadgeCheck className="h-4 w-4 text-primary fill-primary/20 shrink-0" />
                  ) : (
                    <BadgeCheck className="h-4 w-4 text-muted-foreground/30 shrink-0" />
                  )}
                </h1>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="text-[10px] border-2 border-success/50 text-success hover:bg-success/10 gap-1 rounded-xl h-8 px-2 font-bold min-h-[36px]"
                onClick={() => navigate('/angel-pool-agreement')}
              >
                <BadgeCheck className="h-3 w-3" />
                Terms Accepted
              </Button>
            </div>
            {/* AI ID on its own row */}
            <AiIdButton variant="compact" />
          </div>

          {/* ═══ VERIFICATION CHECKLIST — Same as funder ═══ */}
          {user && <VerificationChecklist userId={user.id} highlightRole="supporter" compact />}

          {/* ═══ MERCHANT CODE PILLS — Same as funder ═══ */}
          <MerchantCodePills />

          {/* ═══ PORTFOLIO HERO CARD — Same style as funder ═══ */}
          <div className="portfolio-hero-card rounded-3xl p-5 relative overflow-hidden">
            {/* Decorative elements */}
            <div className="absolute -top-16 -right-16 w-48 h-48 rounded-full bg-primary-foreground/[0.06] pointer-events-none" />
            <div className="absolute -bottom-12 -left-12 w-36 h-36 rounded-full bg-primary-foreground/[0.04] pointer-events-none" />
            <div className="absolute top-1/2 right-0 w-64 h-[1px] bg-gradient-to-l from-transparent via-primary-foreground/10 to-transparent pointer-events-none" />

            <div className="relative z-10 space-y-5">
              {/* Top Label */}
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

              {/* Main Balance */}
              <button
                onClick={() => { hapticTap(); setShowWallet(true); }}
                className="w-full text-left group"
              >
                <p className="text-[10px] uppercase tracking-[0.15em] font-semibold text-primary-foreground/60 mb-1.5 flex items-center gap-1.5">
                  <Wallet className="h-3 w-3" />
                  Available Balance
                </p>
                <div className="flex items-baseline gap-2">
                  <p className="text-[clamp(1.5rem,6vw,2.25rem)] font-black tracking-tight leading-none text-primary-foreground truncate">
                    <span className="sm:hidden">{formatAmountCompact(walletBalance)}</span>
                    <span className="hidden sm:inline">{formatAmount(walletBalance)}</span>
                  </p>
                </div>
                {monthlyReturn > 0 && (
                  <div className="flex items-center gap-1.5 mt-2">
                    <div className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-emerald-500/20">
                      <ArrowUpRight className="h-3 w-3 text-emerald-300" />
                      <span className="text-[11px] font-bold text-emerald-300">
                        +{formatAmountCompact(monthlyReturn)}/mo
                      </span>
                    </div>
                  </div>
                )}
              </button>

              {/* Divider */}
              <div className="h-[1px] bg-primary-foreground/10" />

              {/* Stats Grid — 3 columns */}
              <div className="grid grid-cols-3 gap-2">
                <div className="portfolio-stat-cell-v2 rounded-xl px-2 py-3 text-center">
                  <div className="flex items-center justify-center mb-1.5">
                    <Home className="h-3.5 w-3.5 text-primary-foreground/60" />
                  </div>
                  <p className="text-xl font-black leading-none text-primary-foreground">{myShares}</p>
                  <p className="text-[8px] uppercase tracking-[0.14em] font-bold text-primary-foreground/50 mt-1.5">Shares</p>
                </div>

                <div className="portfolio-stat-cell-v2 rounded-xl px-1.5 py-3 text-center overflow-hidden">
                  <div className="flex items-center justify-center mb-1.5">
                    <TrendingUp className="h-3.5 w-3.5 text-emerald-400/80" />
                  </div>
                  <p className="text-sm font-black leading-none text-primary-foreground truncate">
                    {formatAmountCompact(monthlyReturn)}
                  </p>
                  <p className="text-[8px] uppercase tracking-[0.14em] font-bold text-primary-foreground/50 mt-1.5">Return/mo</p>
                </div>

                <div className="portfolio-stat-cell-v2 rounded-xl px-1.5 py-3 text-center overflow-hidden">
                  <div className="flex items-center justify-center mb-1.5">
                    <Wallet className="h-3.5 w-3.5 text-amber-400/80" />
                  </div>
                  <p className="text-sm font-black leading-none text-primary-foreground truncate">
                    {formatAmountCompact(myInvestment)}
                  </p>
                  <p className="text-[8px] uppercase tracking-[0.14em] font-bold text-primary-foreground/50 mt-1.5 flex items-center justify-center gap-0.5">
                    Deployed
                    <ChevronRight className="h-2.5 w-2.5" />
                  </p>
                </div>
              </div>

              {/* Trust Strip */}
              <div className="flex items-center justify-between px-1 pt-1">
                <div className="flex items-center gap-1.5">
                  <Shield className="h-3 w-3 text-primary-foreground/40" />
                  <span className="text-[9px] text-primary-foreground/40 font-medium">Capital Protected</span>
                </div>
                <span className="text-[9px] text-primary-foreground/40 font-medium">
                  Portfolio: {formatAmountCompact(myInvestment + walletBalance)}
                </span>
              </div>
            </div>
          </div>

          {/* ═══ MY PORTFOLIOS — Same card style as funder ═══ */}
          <button
            onClick={() => { hapticTap(); scrollToPool(); }}
            className="w-full rounded-2xl bg-card border-2 border-primary/20 p-4 flex items-center gap-4 active:scale-[0.98] transition-all touch-manipulation shadow-sm hover:border-primary/40 min-h-[72px]"
          >
            <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <Wallet className="h-6 w-6 text-primary" />
            </div>
            <div className="flex-1 text-left min-w-0">
              <p className="font-bold text-base text-foreground">My Portfolios</p>
              <p className="text-xs text-muted-foreground mt-0.5">View & manage your active investments</p>
            </div>
            <ChevronRight className="h-5 w-5 text-muted-foreground/50 shrink-0" />
          </button>

          {/* ═══ QUICK ACTIONS — Same pill style as funder ═══ */}
          <div className="flex gap-2">
            <button
              onClick={() => { hapticTap(); scrollToCalc(); }}
              className="flex-1 flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-primary text-primary-foreground font-bold text-sm shadow-lg shadow-primary/20 active:scale-[0.96] transition-transform touch-manipulation min-h-[48px]"
            >
              <CreditCard className="h-4.5 w-4.5" />
              Add Funds
            </button>

            <button
              onClick={() => { hapticTap(); scrollToCalc(); }}
              className="flex items-center justify-center gap-2 px-5 py-3.5 rounded-2xl bg-card border-2 border-border/60 text-foreground font-bold text-sm shadow-sm active:scale-[0.96] transition-transform touch-manipulation min-h-[48px]"
            >
              <Calculator className="h-4.5 w-4.5 text-primary" />
              ROI
            </button>

            <button
              onClick={() => { hapticTap(); setMenuOpen(!menuOpen); }}
              className="flex items-center justify-center px-4 py-3.5 rounded-2xl bg-card border-2 border-border/60 text-muted-foreground shadow-sm active:scale-[0.96] transition-transform touch-manipulation min-h-[48px]"
            >
              <Menu className="h-5 w-5" />
            </button>
          </div>

          {/* ═══ SECTION: CAPITAL OPPORTUNITIES — Same as funder ═══ */}
          <div id="opportunities" className="relative scroll-mt-4 space-y-4">
            <div className="flex items-center gap-2 px-1">
              <div className="w-1 h-5 rounded-full bg-primary" />
              <h2 className="text-sm font-black text-foreground tracking-tight">Capital Opportunities</h2>
            </div>

            <CapitalOpportunityEntry />
          </div>


        </main>
      </div>

      {/* ═══ INVITE & EARN — Same as funder ═══ */}
      <InviteAndEarnCard variant="supporter" compact />

      {showWallet && <FullScreenWalletSheet open={showWallet} onOpenChange={setShowWallet} />}
      
      {/* ═══ BOTTOM NAV — Same as funder ═══ */}
      
    </div>
  );
}
