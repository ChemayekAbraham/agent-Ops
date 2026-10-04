import { ReactNode, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Wallet, ChevronRight, ChevronDown, Shield, Home, TrendingUp, Rocket, PiggyBank, Coins, Clock, Users, Eye, EyeOff } from 'lucide-react';
import { hapticTap } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { useCurrency } from '@/hooks/useCurrency';
import { useAuth } from '@/hooks/useAuth';
import { useAvailableBalance } from '@/hooks/useAvailableBalance';
import { WalletHoldNotice } from '@/components/wallet/WalletHoldNotice';

export type WalletRole = 'agent' | 'tenant' | 'supporter' | 'landlord';

interface UnifiedWalletHeroCardProps {
  balance: number;
  role: WalletRole;
  secondaryLabel?: string;
  secondaryValue?: string;
  houses?: number;
  housesLabel?: string;
  returnPerMonth?: string;
  deployed?: string;
  /** Agent-specific: float (locked) and commission (earned) */
  floatBalance?: number;
  /**
   * Merchant-agent only. Float already committed to payouts the agent has
   * claimed but not settled. When present the Float cell shows the SAME
   * authoritative available float the Merchant payout screen enforces
   * (float balance − reservations), so the two screens can never disagree.
   */
  floatReserved?: number;
  /** Overrides the small caption under the Float amount. */
  floatCaption?: string;
  commissionBalance?: number;
  withdrawableBalance?: number;
  /** Supporter-specific: operational float available to fund rent plans / houses. */
  operationalFloatBalance?: number;
  /** Agent-specific: withdrawable funds NOT classified as commission (CFO admin credits etc.) */
  otherBalance?: number;
  /** Callback when user taps balance area or "View Wallet" */
  onOpenWallet?: () => void;
  /** Callback when user taps the footer "View Wallet" button — should deep-link to wallet statement. Falls back to onOpenWallet. */
  onViewStatement?: () => void;
  /** Supporter metric card taps */
  onHousesTap?: () => void;
  onReturnTap?: () => void;
  onDeployedTap?: () => void;
  /** Optional quick action buttons rendered below the balance */
  quickActions?: ReactNode;
  /** Presentation only: start with the card collapsed to a single row. */
  defaultCollapsed?: boolean;
  /** When false the card is always expanded and the collapse toggle is hidden. */
  collapsible?: boolean;
  /** Hide the Houses/Return/Deployed supporter metric row. */
  hideSupporterMetrics?: boolean;
  /** Hide the secondary label/value row (e.g. Deposits Float). */
  hideSecondaryRow?: boolean;
  /** Hide the footer trust badge and View Wallet button. */
  hideFooter?: boolean;
  /** Disable tap/click on the balance area and footer; card becomes purely informational. */
  disableTap?: boolean;
}

/** Reference easing from the liquid-morph motion language. */
const MORPH_EASE = [0.22, 1, 0.36, 1] as const;

const collapseKey = (role: WalletRole) => `welile-wallet-hero-collapsed:${role}`;

function prefersReducedMotion() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const ROLE_LABELS: Record<WalletRole, string> = {
  agent: 'Agent Wallet',
  tenant: 'Rent Wallet',
  supporter: 'PARTNER WALLET',
  landlord: 'Owner Wallet',
};

const ROLE_TRUST: Record<WalletRole, string> = {
  agent: 'Welile Agent',
  tenant: 'Welile Tenant',
  supporter: 'Capital Protected',
  landlord: 'Welile Property Owner',
};

export function UnifiedWalletHeroCard({
  balance,
  role,
  secondaryLabel,
  secondaryValue,
  houses,
  housesLabel,
  returnPerMonth,
  deployed,
  floatBalance,
  floatReserved,
  floatCaption,
  commissionBalance,
  withdrawableBalance,
  operationalFloatBalance,
  otherBalance,
  onOpenWallet,
  onViewStatement,
  onHousesTap,
  onReturnTap,
  onDeployedTap,
  quickActions,
  defaultCollapsed = true,
  collapsible = true,
  hideSupporterMetrics = false,
  hideSecondaryRow = false,
  hideFooter = false,
  disableTap = false,
}: UnifiedWalletHeroCardProps) {
  const { formatAmount } = useCurrency();
  const { user } = useAuth();
  // Strict ledger-backed available balance (subtracts pending withdrawal_requests).
  // Used for the headline so the wallet never shows money already promised to an
  // in-flight withdrawal. Cached `balance` prop is shown as a smaller "Total" line.
  const { available: ledgerAvailable, walletCached, loading: availableLoading } =
    useAvailableBalance(user?.id);
  const showAgentSplit = role === 'agent' && (floatBalance !== undefined || commissionBalance !== undefined);
  // Only override the headline for non-agent split layouts (agent split has its
  // own dedicated Withdrawable cell that already uses withdrawableBalance prop).
  const useStrictHeadline = !showAgentSplit && !availableLoading;
  const headlineBalance = useStrictHeadline ? ledgerAvailable : balance;
  const pendingHold = useStrictHeadline
    ? Math.max(0, Math.min(walletCached || 0, balance) - ledgerAvailable)
    : 0;

  const handleOpenWallet = () => {
    hapticTap();
    onOpenWallet?.();
  };

  const handleViewStatement = () => {
    hapticTap();
    (onViewStatement ?? onOpenWallet)?.();
  };

  // Always start collapsed when a dashboard loads, regardless of previous session state.
  const [collapsed, setCollapsed] = useState<boolean>(collapsible ? defaultCollapsed : false);
  const [reduceMotion, setReduceMotion] = useState(false);
  // Amount visibility — same logic as the funder wallet card: hidden by default,
  // EyeOff shown while hidden, Eye shown while revealed, masked as 'UGX ••••••'.
  const [showAmount, setShowAmount] = useState(false);
  const maskAmt = (v: number) => (showAmount ? formatAmount(v) : 'UGX ••••••');
  const maskStr = (s: string) => (showAmount ? s : 'UGX ••••••');

  useEffect(() => { setReduceMotion(prefersReducedMotion()); }, []);

  // Auto-collapse only when the user reaches the bottom of the page.
  useEffect(() => {
    if (!collapsible || collapsed || typeof window === 'undefined') return;
    const getY = () => window.scrollY || document.documentElement.scrollTop || 0;
    const atBottom = () => {
      const doc = document.documentElement;
      const scrollHeight = Math.max(doc.scrollHeight, document.body.scrollHeight);
      return getY() + window.innerHeight >= scrollHeight - 24;
    };
    const onScroll = () => {
      if (atBottom()) {
        setCollapsed(true);
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('touchmove', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('touchmove', onScroll);
    };
  }, [collapsed, collapsible]);

  const toggleCollapsed = () => {
    if (!collapsible) return;
    hapticTap();
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(collapseKey(role), next ? 'closed' : 'open');
      } catch { /* storage unavailable — session-only preference */ }
      return next;
    });
  };

  const collapsedHeadline = showAgentSplit ? (withdrawableBalance ?? 0) : headlineBalance;
  const morph = reduceMotion ? { duration: 0 } : undefined;

  return (
    <motion.div
      className="w-full text-left portfolio-hero-card rounded-3xl relative overflow-hidden"
      animate={{ padding: collapsed ? 14 : 24, borderRadius: collapsed ? 28 : 24 }}
      transition={morph ?? { duration: collapsed ? 0.25 : 0.6, ease: MORPH_EASE }}
    >
      {/* Decorative elements for depth and text clarity */}
      <div className="absolute -top-20 -right-20 w-56 h-56 rounded-full bg-primary-foreground/[0.06] pointer-events-none" />
      <div className="absolute -bottom-16 -left-16 w-44 h-44 rounded-full bg-primary-foreground/[0.04] pointer-events-none" />
      <div className="absolute top-1/2 right-0 w-64 h-[1px] bg-gradient-to-l from-transparent via-primary-foreground/10 to-transparent pointer-events-none" />

      {/* Liquid-morph sweep: rises from the bottom as the card opens */}
      <motion.div
        aria-hidden
        className="absolute left-1/2 w-[200%] h-[200%] rounded-full bg-primary-foreground/[0.05] pointer-events-none"
        style={{ x: '-50%' }}
        animate={{ bottom: collapsed ? '-210%' : '-40%' }}
        transition={morph ?? { duration: 0.7, ease: MORPH_EASE, delay: collapsed ? 0 : 0.05 }}
      />

      <AnimatePresence initial={false}>
        {collapsible && collapsed && (
          <motion.button
            key="collapsed-bar"
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={false}
            aria-label={`Expand ${ROLE_LABELS[role]}`}
            className="relative z-10 w-full flex items-center gap-3 px-1.5 py-1 text-left"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={morph ?? { duration: 0.25, ease: MORPH_EASE }}
          >
            <span className="p-1.5 rounded-lg bg-primary-foreground/15 backdrop-blur-sm shrink-0">
              <Wallet className="h-3.5 w-3.5 text-white/90" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1">
                <span className="text-[10px] font-semibold text-white/70 uppercase tracking-[0.12em] truncate">
                  {ROLE_LABELS[role]}
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); hapticTap(); setShowAmount((s) => !s); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); setShowAmount((s) => !s); } }}
                  aria-label={showAmount ? 'Hide amount' : 'Show amount'}
                  aria-pressed={showAmount}
                  className="flex items-center justify-center p-0.5 rounded-full bg-primary-foreground/10 hover:bg-primary-foreground/20 active:scale-95 transition-all text-white/70 hover:text-white shrink-0 cursor-pointer"
                >
                  {showAmount ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                </span>
              </span>
              <span className="block text-lg font-black leading-tight text-white truncate">
                {maskAmt(collapsedHeadline)}
              </span>
            </span>
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary-foreground/15 shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[9px] font-bold text-emerald-300 uppercase tracking-wider">Active</span>
            </span>
            <ChevronDown className="h-4 w-4 text-white/60 shrink-0" />
          </motion.button>
        )}
      </AnimatePresence>

      <motion.div
        className="relative z-10 space-y-4 overflow-hidden"
        initial={false}
        animate={{ height: collapsed ? 0 : 'auto', opacity: collapsed ? 0 : 1 }}
        transition={morph ?? {
          height: { duration: collapsed ? 0.25 : 0.6, ease: MORPH_EASE },
          opacity: { duration: collapsed ? 0.15 : 0.45, ease: MORPH_EASE, delay: collapsed ? 0 : 0.1 },
        }}
        aria-hidden={collapsed}
      >
        {/* Header row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-primary-foreground/15 backdrop-blur-sm">
              <Wallet className="h-3.5 w-3.5 text-white/90" />
            </div>
            <span className="text-[11px] font-semibold text-white/80 uppercase tracking-[0.12em]">
              {ROLE_LABELS[role]}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { hapticTap(); setShowAmount((s) => !s); }}
              aria-label={showAmount ? 'Hide amount' : 'Show amount'}
              aria-pressed={showAmount}
              className="p-1 rounded-full bg-primary-foreground/10 hover:bg-primary-foreground/20 active:scale-95 transition-all text-white/70 hover:text-white"
            >
              {showAmount ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            </button>
            <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary-foreground/15 backdrop-blur-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[9px] font-bold text-emerald-300 uppercase tracking-wider">Active</span>
            </div>
            {collapsible && (
              <button
                type="button"
                onClick={toggleCollapsed}
                aria-expanded={!collapsed}
                aria-label={`Collapse ${ROLE_LABELS[role]}`}
                className="p-1 rounded-full bg-primary-foreground/10 hover:bg-primary-foreground/20 active:scale-95 transition-all"
              >
                <ChevronDown className="h-4 w-4 rotate-180 text-white/70" />
              </button>
            )}
          </div>
        </div>

        {/* Agent Float & Commission split */}
        {showAgentSplit ? (
          <div
            role={disableTap ? undefined : 'button'}
            tabIndex={disableTap ? -1 : 0}
            onClick={disableTap ? undefined : handleOpenWallet}
            onKeyDown={disableTap ? undefined : (e) => { if (e.key === 'Enter' || e.key === ' ') handleOpenWallet(); }}
            className={cn(
              'w-full text-left',
              !disableTap && 'active:scale-[0.98] transition-transform cursor-pointer'
            )}
          >
            <div className={`grid grid-cols-1 ${floatBalance !== undefined ? 'sm:grid-cols-2' : ''} gap-3`}>
              {/* Float section — omitted entirely when floatBalance is not
                  passed (merchant agents: their float lives exclusively in
                  MerchantFloatAvailableCard, which explains it correctly and
                  isn't sitting next to Deposit/Withdraw/Transfer buttons). */}
              {floatBalance !== undefined && (
                <div className="bg-primary-foreground/15 rounded-xl p-3 min-w-0">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <PiggyBank className="h-3 w-3 text-white/50" />
                    <p className="text-[9px] uppercase tracking-[0.15em] font-semibold text-white/50">Wallet Float</p>
                  </div>
                  <p className="text-lg font-black tracking-tight leading-none text-white whitespace-nowrap">
                    {maskAmt(Math.max(0, (floatBalance ?? 0) - Math.max(0, floatReserved ?? 0)))}
                  </p>
                  <p className="text-[9px] text-white/40 mt-1 font-medium">
                    {floatCaption ?? 'Tenant collections · Pay Rent'}
                  </p>
                  {!!floatReserved && floatReserved > 0 && showAmount && (
                    <p className="text-[9px] text-amber-200/80 mt-0.5 font-medium">
                      {formatAmount(floatReserved)} held by payouts you claimed
                    </p>
                  )}
                </div>
              )}

              {/* Withdrawable section — STRICT ledger-backed value only.
                  Must NEVER display commissionBalance here: commission is
                  earnings history, not necessarily currently withdrawable. */}
              <div className="bg-primary-foreground/15 rounded-xl p-3 min-w-0">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Coins className="h-3 w-3 text-emerald-400/70" />
                  <p className="text-[9px] uppercase tracking-[0.15em] font-semibold text-emerald-300/70">Withdrawable</p>
                </div>
                <p className="text-lg font-black tracking-tight leading-none text-white whitespace-nowrap">
                  {maskAmt(withdrawableBalance ?? 0)}
                </p>
                <p className="text-[9px] text-emerald-300/50 mt-1 font-medium">
                  Available to withdraw
                </p>
              </div>
            </div>

            {/* Total balance row */}
            <div className="flex items-center justify-between mt-3 px-1">
              <span className="text-[10px] uppercase tracking-[0.12em] font-semibold text-white/40">Total Balance</span>
              <span className="text-sm font-black text-white">{maskAmt(balance)}</span>
            </div>
            {!disableTap && (
              <p className="mt-2 px-1 text-[10px] text-white font-medium">
                Tap to see how your money moves in and out
              </p>
            )}
          </div>
        ) : (
          /* Supporter partner wallet: ROI + Operational Float side-by-side */
          <div
            role={disableTap ? undefined : 'button'}
            tabIndex={disableTap ? -1 : 0}
            onClick={disableTap ? undefined : handleOpenWallet}
            onKeyDown={disableTap ? undefined : (e) => { if (e.key === 'Enter' || e.key === ' ') handleOpenWallet(); }}
            className={cn(
              'w-full text-left',
              !disableTap && 'active:scale-[0.98] transition-transform cursor-pointer'
            )}
          >
            {role === 'supporter' && operationalFloatBalance !== undefined ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="bg-primary-foreground/[0.10] rounded-2xl p-4 border border-primary-foreground/[0.06]">
                  <p className="text-[10px] uppercase tracking-[0.15em] font-bold text-white mb-2 flex items-center gap-1.5">
                    <Wallet className="h-3 w-3" />
                    ROI BALANCE
                  </p>
                  <p className="text-[clamp(1.75rem,6.5vw,2.75rem)] font-black tracking-tight leading-none text-white drop-shadow-sm">
                    {maskAmt(headlineBalance)}
                  </p>
                  {pendingHold > 0 && showAmount && (
                    <div className="mt-2.5 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-300/20">
                      <Clock className="h-3 w-3 text-amber-300" />
                      <span className="text-[10px] font-semibold text-amber-200">
                        {formatAmount(pendingHold)} pending withdrawal
                      </span>
                    </div>
                  )}
                  {pendingHold > 0 && showAmount && (
                    <p className="text-[10px] text-white mt-1.5">
                      Wallet total: <span className="font-semibold text-white">{formatAmount(balance)}</span>
                    </p>
                  )}
                </div>

                <div className="bg-primary-foreground/[0.10] rounded-2xl p-4 border border-primary-foreground/[0.06]">
                  <p className="text-[10px] uppercase tracking-[0.15em] font-bold text-white mb-2 flex items-center gap-1.5">
                    <Wallet className="h-3 w-3" />
                    Balance
                  </p>
                  <p className="text-[clamp(1.75rem,6.5vw,2.75rem)] font-black tracking-tight leading-none text-white drop-shadow-sm">
                    {maskAmt(operationalFloatBalance)}
                  </p>
                  <p className="mt-2.5 text-[10px] text-white/80 font-medium">
                    Balance available to fund rent plans and houses. Not withdrawable.
                  </p>
                </div>
              </div>
            ) : (
              <div className="bg-primary-foreground/[0.10] rounded-2xl p-4 border border-primary-foreground/[0.06]">
                <p className="text-[10px] uppercase tracking-[0.15em] font-bold text-white mb-2 flex items-center gap-1.5">
                  <Wallet className="h-3 w-3" />
                  ROI
                </p>
                <p className="text-[clamp(1.75rem,6.5vw,2.75rem)] font-black tracking-tight leading-none text-white drop-shadow-sm">
                  {maskAmt(headlineBalance)}
                </p>
                {pendingHold > 0 && showAmount && (
                  <div className="mt-2.5 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-300/20">
                    <Clock className="h-3 w-3 text-amber-300" />
                    <span className="text-[10px] font-semibold text-amber-200">
                      {formatAmount(pendingHold)} pending withdrawal
                    </span>
                  </div>
                )}
                {pendingHold > 0 && showAmount && (
                  <p className="text-[10px] text-white mt-1.5">
                    Wallet total: <span className="font-semibold text-white">{formatAmount(balance)}</span>
                  </p>
                )}
                {!disableTap && (
                  <p className="mt-2.5 text-[10px] text-white font-medium">
                    Tap to see how your money moves in and out
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Explains a suppressed available balance (pending withdrawal holds). */}
        <WalletHoldNotice variant="hero" />

        {/* Supporter metric cards — individually tappable */}
        {role === 'supporter' && !hideSupporterMetrics && (
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => { hapticTap(); onHousesTap?.(); }}
              className="bg-primary-foreground/15 rounded-xl p-2.5 text-center active:scale-[0.95] transition-transform"
            >
              {housesLabel
                ? <Users className="h-3.5 w-3.5 text-white/60 mx-auto mb-1" />
                : <Home className="h-3.5 w-3.5 text-white/60 mx-auto mb-1" />}
              <p className="text-[9px] uppercase tracking-wider text-white/50 font-medium">{housesLabel ?? 'Houses'}</p>
              <p className="text-sm font-black text-white mt-0.5 font-mono tabular-nums">{houses ?? 0}</p>
            </button>
            <button
              onClick={() => { hapticTap(); onReturnTap?.(); }}
              className="bg-primary-foreground/15 rounded-xl p-2.5 text-center active:scale-[0.95] transition-transform"
            >
              <TrendingUp className="h-3.5 w-3.5 text-white/60 mx-auto mb-1" />
              <p className="text-[9px] uppercase tracking-wider text-white/50 font-medium">Return/Mo</p>
              <p className="text-[11px] font-extrabold text-white mt-0.5 font-mono tabular-nums truncate">{returnPerMonth ?? '—'}</p>
            </button>
            <button
              onClick={() => { hapticTap(); onDeployedTap?.(); }}
              className="bg-primary-foreground/15 rounded-xl p-2.5 text-center active:scale-[0.95] transition-transform"
            >
              <Rocket className="h-3.5 w-3.5 text-white/60 mx-auto mb-1" />
              <p className="text-[9px] uppercase tracking-wider text-white/50 font-medium">Deployed</p>
              <p className="text-[11px] font-extrabold text-white mt-0.5 font-mono tabular-nums truncate">{deployed ?? '—'}</p>
            </button>
          </div>
        )}

        {secondaryLabel && secondaryValue && !showAgentSplit && !hideSecondaryRow && (
          <div className="flex items-center justify-between pt-1 border-t border-primary-foreground/[0.08]">
            <span className="text-[11px] text-white/50 font-medium">{secondaryLabel}</span>
            <span className="text-[11px] text-white/70 font-bold">{maskStr(secondaryValue)}</span>
          </div>
        )}

        {/* Quick Actions slot */}
        {quickActions}


        {/* Footer — View Wallet link */}
        {!hideFooter && (
          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-1.5">
              <Shield className="h-3 w-3 text-white" />
              <span className="text-[9px] text-white font-medium">{ROLE_TRUST[role]}</span>
            </div>
            <button
              onClick={handleViewStatement}
              className="relative flex items-center gap-2 px-4 py-2.5 rounded-full bg-primary-foreground/15 hover:bg-primary-foreground/25 active:scale-95 text-white font-semibold text-sm shadow-lg ring-2 ring-primary-foreground/40 animate-bell-glow transition-all overflow-hidden group"
            >
              <span className="absolute inset-0 -translate-x-full group-hover:translate-x-full bg-gradient-to-r from-transparent via-primary-foreground/30 to-transparent transition-transform duration-1000 ease-out" />
              <span className="relative">View Wallet</span>
              <ChevronRight className="relative h-4 w-4 animate-pulse" />
            </button>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}