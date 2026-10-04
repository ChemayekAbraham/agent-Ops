import { useState, useCallback } from 'react';
import {
  TrendingUp, Shield, Zap, Users, BadgeCheck, Rocket,
  Home, Wallet, ChevronLeft, ArrowUpRight, Coins,
  BarChart3, Lock, Clock, PieChart, ChevronRight,
  Building, CircleDollarSign, UserCheck, MapPin, Plus, ArrowDownToLine, Check
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useCurrency } from '@/hooks/useCurrency';
import { useWallet } from '@/hooks/useWallet';
import { TOTAL_SHARES, PRICE_PER_SHARE, POOL_PERCENT, VALUATIONS, UGX_PER_USD } from './constants';
import { hapticTap } from '@/lib/haptics';
import { toast } from 'sonner';
import { InvestmentSelectionSheet, type PoolType } from './InvestmentSelectionSheet';
import { useAngelPoolAgreement } from '@/hooks/useAngelPoolAgreement';
import { AngelPoolAgreementDialog } from './agreement/AngelPoolAgreementDialog';

type ViewState = 'default' | 'investing' | 'committed';

const MOCK_ACTIVE_DEMAND = 935_599_000;
const MOCK_STATS = { activeRequests: 1901, verifiedLandlords: 1322, fieldAgents: 1006 };

// ─── Shared Amount Input ───
function AmountInput({
  amount, onAmountChange, onSliderChange, walletBalance, formatAmountCompact, exceedsBalance,
}: {
  amount: number; onAmountChange: (val: string) => void; onSliderChange: (val: number) => void;
  walletBalance: number; formatAmountCompact: (n: number) => string; exceedsBalance: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="rounded-xl bg-muted/40 px-3 py-2 flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground font-medium flex items-center gap-1.5">
          <Wallet className="h-3.5 w-3.5" /> Wallet Balance
        </span>
        <span className="text-sm font-black text-foreground">{formatAmountCompact(walletBalance)}</span>
      </div>
      <label className="text-xs text-muted-foreground font-semibold block">Amount (UGX)</label>
      <Input
        type="text" inputMode="numeric"
        value={amount > 0 ? amount.toLocaleString() : ''}
        onChange={(e) => onAmountChange(e.target.value)}
        placeholder={`Min ${PRICE_PER_SHARE.toLocaleString()}`}
        className="text-lg font-bold h-12"
      />
      <Slider value={[amount]} onValueChange={([v]) => onSliderChange(v)} min={0}
        max={walletBalance > 0 ? walletBalance : 50_000_000} step={PRICE_PER_SHARE} className="mt-1" />
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>0</span><span>{formatAmountCompact(walletBalance > 0 ? walletBalance : 50_000_000)}</span>
      </div>
      {exceedsBalance && <p className="text-[11px] text-destructive font-medium">Amount exceeds your wallet balance</p>}
    </div>
  );
}

function TenantPreview({ amount, formatAmountCompact }: { amount: number; formatAmountCompact: (n: number) => string }) {
  if (amount <= 0) return null;
  const monthlyReturn = amount * 0.15;
  const dailyReturn = amount * 0.005;
  return (
    <div className="space-y-2 pt-2">
      <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-widest">Investment Preview</p>
      <div className="rounded-xl border border-border/60 bg-muted/30 p-3 space-y-2.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground flex items-center gap-1.5"><Coins className="h-3 w-3" /> Investment</span>
          <span className="font-black text-foreground">{formatAmountCompact(amount)}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground flex items-center gap-1.5"><TrendingUp className="h-3 w-3" /> Monthly Return (15%)</span>
          <span className="font-black text-success">+{formatAmountCompact(monthlyReturn)}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground flex items-center gap-1.5"><ArrowUpRight className="h-3 w-3" /> Daily Return</span>
          <span className="font-bold text-foreground">+{formatAmountCompact(dailyReturn)}/day</span>
        </div>
        <div className="h-px bg-border/60" />
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Deploy Speed</span><span className="font-bold">24–72hrs</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Payout</span><span className="font-bold">Monthly</span>
        </div>
      </div>
    </div>
  );
}

function AngelPreview({ amount, formatAmountCompact }: { amount: number; formatAmountCompact: (n: number) => string }) {
  if (amount <= 0) return null;
  const shares = Math.floor(amount / PRICE_PER_SHARE);
  const poolPct = (shares / TOTAL_SHARES) * 100;
  const companyPct = (POOL_PERCENT / TOTAL_SHARES) * shares;
  return (
    <div className="space-y-2 pt-2">
      <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-widest">Investment Preview</p>
      <div className="rounded-xl border border-border/60 bg-muted/30 p-3 space-y-2.5">
        <div className="grid grid-cols-3 gap-2 pb-2">
          {[{ val: shares, label: 'Shares' }, { val: `${poolPct.toFixed(2)}%`, label: 'Pool %' }, { val: `${companyPct.toFixed(4)}%`, label: 'Company %' }].map(m => (
            <div key={m.label} className="rounded-lg bg-primary/5 p-2 text-center">
              <p className="text-lg font-black text-primary">{m.val}</p>
              <p className="text-[9px] text-muted-foreground font-medium">{m.label}</p>
            </div>
          ))}
        </div>
        <div className="space-y-1.5">
          <p className="text-[10px] text-muted-foreground font-semibold flex items-center gap-1"><TrendingUp className="h-3 w-3" /> Future Value Estimates</p>
          {VALUATIONS.map((v) => {
            const futureVal = (companyPct / 100) * v.value * UGX_PER_USD;
            return (
              <div key={v.label} className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">At {v.label} valuation</span>
                <span className="font-black text-success">{formatAmountCompact(futureVal)}</span>
              </div>
            );
          })}
        </div>
        <div className="h-px bg-border/60" />
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Equity Pool</span>
          <span className="font-bold text-primary">Up to {POOL_PERCENT}%</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Horizon</span><span className="font-bold">Long-term</span>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// ─── TENANT COMMITTED SUMMARY ───
// Matches the reference screenshot exactly
// ═══════════════════════════════════════════
function TenantCommittedSummary({
  amount, formatAmountCompact, onSupportMore, onWithdraw,
}: {
  amount: number; formatAmountCompact: (n: number) => string;
  onSupportMore: () => void; onWithdraw: () => void;
}) {
  return (
    <div className="rounded-2xl border border-border/80 bg-card overflow-hidden shadow-sm">
      <div className="px-5 pt-5 pb-1">
        <p className="text-xs font-semibold text-muted-foreground mb-1">Capital Opportunities</p>
      </div>
      <div className="px-5 pb-5 space-y-4">
        {/* Header row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-primary/10">
              <TrendingUp className="h-4 w-4 text-primary" />
            </div>
            <div>
              <p className="font-bold text-sm text-foreground">Rent Requests</p>
              <p className="text-[10px] text-muted-foreground">Rent demand from our agent network in the field</p>
            </div>
          </div>
          <div className="h-6 w-6 rounded-full bg-primary flex items-center justify-center">
            <Check className="h-3.5 w-3.5 text-white" />
          </div>
        </div>

        {/* Total Rent Demand */}
        <div>
          <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-widest">Total Rent Demand</p>
          <p className="text-3xl font-black text-foreground tracking-tight mt-0.5">
            UGX {amount.toLocaleString()}
          </p>
          <p className="text-[10px] text-primary font-medium mt-1 flex items-center gap-1">
            <Zap className="h-3 w-3" /> Welile is turning rent into an asset
          </p>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-2">
          {[
            { icon: Building, value: MOCK_STATS.activeRequests.toLocaleString(), label: 'Active Requests' },
            { icon: UserCheck, value: MOCK_STATS.verifiedLandlords.toLocaleString(), label: 'Verified Landlords' },
            { icon: MapPin, value: MOCK_STATS.fieldAgents.toLocaleString(), label: 'Field Agents' },
          ].map(s => (
            <div key={s.label} className="rounded-xl border border-border/60 bg-muted/20 p-3 text-center">
              <s.icon className="h-4 w-4 text-muted-foreground mx-auto mb-1" />
              <p className="text-lg font-black text-foreground">{s.value}</p>
              <p className="text-[9px] text-muted-foreground font-medium">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Key metrics */}
        <div className="space-y-2">
          {[
            { icon: TrendingUp, label: 'Monthly Return', value: 'Up to 15%', valueClass: 'text-success font-black' },
            { icon: Rocket, label: 'Deployment Speed', value: '24–72 hours', valueClass: 'font-bold' },
            { icon: CircleDollarSign, label: 'Payouts', value: 'Monthly to wallet', valueClass: 'font-bold' },
            { icon: Shield, label: 'Risk Control', value: 'Verified & insured', valueClass: 'font-bold' },
          ].map(m => (
            <div key={m.label} className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground flex items-center gap-1.5">
                <m.icon className="h-3.5 w-3.5" /> {m.label}
              </span>
              <span className={m.valueClass}>{m.value}</span>
            </div>
          ))}
        </div>

        {/* CTAs */}
        <Button
          onClick={() => { hapticTap(); onSupportMore(); }}
          className="w-full h-12 rounded-2xl text-sm font-bold shadow-md gap-2 uppercase tracking-wide"
        >
          Support Tenant <ChevronRight className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          onClick={() => { hapticTap(); onWithdraw(); }}
          className="w-full h-11 rounded-2xl text-sm font-medium gap-2"
        >
          <ArrowDownToLine className="h-4 w-4" /> Withdraw Capital
        </Button>

        {/* Footer */}
        <div className="text-center space-y-1.5">
          <p className="text-[10px] text-muted-foreground">
            <Clock className="h-3 w-3 inline mr-1" />Avg. cycle: 30 days · Min: UGX {PRICE_PER_SHARE.toLocaleString()}
          </p>
          <p className="text-[9px] text-muted-foreground/70 leading-relaxed">
            Returns are projected based on historical performance. Capital is deployed into verified rent facilitation agreements managed by Welile with reserve protection.
          </p>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// ─── ANGEL COMMITTED SUMMARY ───
// ═══════════════════════════════════════════
function AngelCommittedSummary({
  amount, formatAmountCompact, onInvestMore, onWithdraw,
}: {
  amount: number; formatAmountCompact: (n: number) => string;
  onInvestMore: () => void; onWithdraw: () => void;
}) {
  const shares = Math.floor(amount / PRICE_PER_SHARE);
  const poolPct = (shares / TOTAL_SHARES) * 100;
  const companyPct = (POOL_PERCENT / TOTAL_SHARES) * shares;

  return (
    <div className="rounded-2xl border border-border/80 bg-card overflow-hidden shadow-sm">
      <div className="px-5 pt-5 pb-1">
        <p className="text-xs font-semibold text-muted-foreground mb-1">Capital Opportunities</p>
      </div>
      <div className="px-5 pb-5 space-y-4">
        {/* Header row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-primary/10">
              <Rocket className="h-4 w-4 text-primary" />
            </div>
            <div>
              <p className="font-bold text-sm text-foreground">Angel Pool</p>
              <p className="text-[10px] text-muted-foreground">Early-stage equity in Welile Technologies</p>
            </div>
          </div>
          <div className="h-6 w-6 rounded-full bg-primary flex items-center justify-center">
            <Check className="h-3.5 w-3.5 text-white" />
          </div>
        </div>

        {/* Total Investment */}
        <div>
          <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-widest">Your Investment</p>
          <p className="text-3xl font-black text-foreground tracking-tight mt-0.5">
            UGX {amount.toLocaleString()}
          </p>
          <p className="text-[10px] text-primary font-medium mt-1 flex items-center gap-1">
            <Zap className="h-3 w-3" /> You own a piece of the future
          </p>
        </div>

        {/* Ownership grid */}
        <div className="grid grid-cols-3 gap-2">
          {[
            { icon: Coins, value: shares.toLocaleString(), label: 'Shares Owned' },
            { icon: PieChart, value: `${poolPct.toFixed(2)}%`, label: 'Pool Ownership' },
            { icon: BarChart3, value: `${companyPct.toFixed(4)}%`, label: 'Company Equity' },
          ].map(s => (
            <div key={s.label} className="rounded-xl border border-border/60 bg-muted/20 p-3 text-center">
              <s.icon className="h-4 w-4 text-primary mx-auto mb-1" />
              <p className="text-lg font-black text-foreground">{s.value}</p>
              <p className="text-[9px] text-muted-foreground font-medium">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Future value estimates */}
        <div className="space-y-2">
          <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-widest flex items-center gap-1">
            <TrendingUp className="h-3 w-3" /> Future Value at Exit
          </p>
          {VALUATIONS.map((v) => {
            const futureVal = (companyPct / 100) * v.value * UGX_PER_USD;
            return (
              <div key={v.label} className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">At {v.label} valuation</span>
                <span className="font-black text-success">{formatAmountCompact(futureVal)}</span>
              </div>
            );
          })}
        </div>

        {/* Key metrics */}
        <div className="space-y-2">
          {[
            { icon: BarChart3, label: 'Equity Pool', value: `Up to ${POOL_PERCENT}%`, valueClass: 'text-primary font-black' },
            { icon: Lock, label: 'Investment Horizon', value: 'Long-term', valueClass: 'font-bold' },
            { icon: Shield, label: 'Structure', value: 'Share-based ownership', valueClass: 'font-bold' },
            { icon: BadgeCheck, label: 'Status', value: 'Verified investor', valueClass: 'font-bold' },
          ].map(m => (
            <div key={m.label} className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground flex items-center gap-1.5">
                <m.icon className="h-3.5 w-3.5" /> {m.label}
              </span>
              <span className={m.valueClass}>{m.value}</span>
            </div>
          ))}
        </div>

        {/* CTAs */}
        <Button
          onClick={() => { hapticTap(); onInvestMore(); }}
          className="w-full h-12 rounded-2xl text-sm font-bold shadow-md gap-2 uppercase tracking-wide"
        >
          Fund Angel Pool <ChevronRight className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          onClick={() => { hapticTap(); onWithdraw(); }}
          className="w-full h-11 rounded-2xl text-sm font-medium gap-2"
        >
          <ArrowDownToLine className="h-4 w-4" /> Withdraw Capital
        </Button>

        {/* Footer */}
        <div className="text-center space-y-1.5">
          <p className="text-[10px] text-muted-foreground">
            <Lock className="h-3 w-3 inline mr-1" />Price per share: UGX {PRICE_PER_SHARE.toLocaleString()} · Total pool: {TOTAL_SHARES.toLocaleString()} shares
          </p>
          <p className="text-[9px] text-muted-foreground/70 leading-relaxed">
            Angel Pool shares represent early-stage equity in Welile Technologies. Returns are realized at exit events. Past projections are illustrative and not guaranteed.
          </p>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// ─── DEFAULT GATEWAY CARD ───
// ═══════════════════════════════════════════
function DefaultEntryCard({
  onOpenSelection, formatAmountCompact,
}: {
  onOpenSelection: () => void; formatAmountCompact: (n: number) => string;
}) {
  return (
    <div className="rounded-2xl border border-border/80 bg-card overflow-hidden shadow-sm">
      <div className="px-5 pt-5 pb-4 space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-primary/10">
            <TrendingUp className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h3 className="font-black text-foreground text-base tracking-tight leading-tight">
              Put Your Capital to Work
            </h3>
            <p className="text-xs text-muted-foreground font-medium mt-0.5">
              Verified opportunities. Structured returns. Choose your path.
            </p>
          </div>
        </div>

        <div className="rounded-xl bg-muted/40 border border-border/40 px-4 py-3 text-center">
          <p className="text-2xl font-black text-foreground tracking-tight">
            {formatAmountCompact(MOCK_ACTIVE_DEMAND)}
          </p>
          <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-widest mt-0.5">
            Active Capital Demand
          </p>
        </div>

        <div className="flex items-center justify-center gap-3 flex-wrap">
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground font-medium">
            <BadgeCheck className="h-3 w-3 text-success" /> Verified
          </span>
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground font-medium">
            <Shield className="h-3 w-3 text-primary" /> Insured
          </span>
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground font-medium">
            <Users className="h-3 w-3" /> Active Network
          </span>
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground font-medium">
            <Lock className="h-3 w-3" /> Structured
          </span>
        </div>

        <Button
          onClick={() => { hapticTap(); onOpenSelection(); }}
          className="w-full h-12 rounded-2xl text-sm font-bold shadow-md gap-2"
        >
          <Rocket className="h-4 w-4" /> Explore Investment Options
          <ChevronRight className="h-4 w-4 ml-auto" />
        </Button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// ─── MAIN COMPONENT ───
// ═══════════════════════════════════════════
export function CapitalOpportunityEntry() {
  const { formatAmountCompact } = useCurrency();
  const { wallet } = useWallet();
  const walletBalance = wallet?.balance ?? 0;

  const [viewState, setViewState] = useState<ViewState>('default');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<PoolType>('tenant');
  const [tenantAmount, setTenantAmount] = useState(0);
  const [angelAmount, setAngelAmount] = useState(0);
  const [committedPool, setCommittedPool] = useState<PoolType>('tenant');
  const [committedAmount, setCommittedAmount] = useState(0);

  const handleAmountChange = (pool: PoolType, val: string) => {
    const num = parseInt(val.replace(/[^0-9]/g, ''), 10);
    const max = walletBalance > 0 ? walletBalance : 500_000_000;
    const value = !isNaN(num) ? Math.min(num, max) : 0;
    pool === 'tenant' ? setTenantAmount(value) : setAngelAmount(value);
  };

  const handleInvest = (pool: PoolType) => {
    const amt = pool === 'tenant' ? tenantAmount : angelAmount;
    if (amt < PRICE_PER_SHARE) return;
    if (walletBalance > 0 && amt > walletBalance) return;

    hapticTap();
    setCommittedPool(pool);
    setCommittedAmount(amt);
    setViewState('committed');
    toast.success(
      pool === 'tenant'
        ? `Tenant support of ${formatAmountCompact(amt)} committed.`
        : `Angel Pool funded with ${formatAmountCompact(amt)} successfully.`
    );
    pool === 'tenant' ? setTenantAmount(0) : setAngelAmount(0);
  };

  const { isAccepted: angelAgreementAccepted, isLoading: angelAgreementLoading, acceptAgreement: acceptAngelAgreement } = useAngelPoolAgreement();
  const [showAgreementDialog, setShowAgreementDialog] = useState(false);
  const [pendingAngelSwitch, setPendingAngelSwitch] = useState<'select' | 'tab' | null>(null);

  const handlePoolSelect = (pool: PoolType) => {
    if (pool === 'angel' && !angelAgreementAccepted) {
      setPendingAngelSwitch('select');
      setShowAgreementDialog(true);
      return;
    }
    setActiveTab(pool);
    setViewState('investing');
  };

  const handleAngelTabSwitch = useCallback(() => {
    if (!angelAgreementAccepted) {
      setPendingAngelSwitch('tab');
      setShowAgreementDialog(true);
      return false;
    }
    return true;
  }, [angelAgreementAccepted]);

  const handleAgreementAccept = async () => {
    const ok = await acceptAngelAgreement();
    if (ok) {
      setShowAgreementDialog(false);
      if (pendingAngelSwitch === 'select') {
        setActiveTab('angel');
        setViewState('investing');
      } else {
        setActiveTab('angel');
      }
      setPendingAngelSwitch(null);
      toast.success('Angel Pool Agreement accepted!');
    } else {
      toast.error('Failed to accept. Please try again.');
    }
  };

  const handleBackToInvesting = (pool: PoolType) => {
    setActiveTab(pool);
    setViewState('investing');
  };

  // ─── COMMITTED STATE ───
  if (viewState === 'committed') {
    if (committedPool === 'tenant') {
      return (
        <TenantCommittedSummary
          amount={committedAmount}
          formatAmountCompact={formatAmountCompact}
          onSupportMore={() => handleBackToInvesting('tenant')}
          onWithdraw={() => {
            hapticTap();
            toast.info('Withdrawal request submitted (mock).');
            setViewState('default');
            setCommittedAmount(0);
          }}
        />
      );
    }
    return (
      <AngelCommittedSummary
        amount={committedAmount}
        formatAmountCompact={formatAmountCompact}
        onInvestMore={() => handleBackToInvesting('angel')}
        onWithdraw={() => {
          hapticTap();
          toast.info('Withdrawal request submitted (mock).');
          setViewState('default');
          setCommittedAmount(0);
        }}
      />
    );
  }

  // ─── DEFAULT STATE ───
  if (viewState === 'default') {
    return (
      <>
        <DefaultEntryCard onOpenSelection={() => setSheetOpen(true)} formatAmountCompact={formatAmountCompact} />
        <InvestmentSelectionSheet open={sheetOpen} onOpenChange={setSheetOpen} onSelect={handlePoolSelect} />
        <AngelPoolAgreementDialog
          open={showAgreementDialog}
          onAccept={handleAgreementAccept}
          onClose={() => { setShowAgreementDialog(false); setPendingAngelSwitch(null); }}
          isLoading={angelAgreementLoading}
        />
      </>
    );
  }

  // ─── INVESTING STATE ───
  return (
    <div className="rounded-2xl border border-border/80 bg-card overflow-hidden shadow-sm">
      <div className="px-5 pt-4 pb-3 flex items-center gap-2.5">
        <button onClick={() => { hapticTap(); setViewState('default'); }}
          className="p-1.5 -ml-1.5 rounded-lg hover:bg-muted/60 transition-colors">
          <ChevronLeft className="h-4 w-4 text-muted-foreground" />
        </button>
        <div className="p-2 rounded-xl bg-primary/10">
          <TrendingUp className="h-4 w-4 text-primary" />
        </div>
        <div>
          <h3 className="font-black text-foreground text-sm tracking-tight">Grow Your Capital</h3>
          <p className="text-[10px] text-muted-foreground font-medium leading-tight">Choose an investment pool below</p>
        </div>
      </div>

      <div className="px-5 pb-4">
        <AngelPoolAgreementDialog
          open={showAgreementDialog}
          onAccept={handleAgreementAccept}
          onClose={() => { setShowAgreementDialog(false); setPendingAngelSwitch(null); }}
          isLoading={angelAgreementLoading}
        />
        <Tabs value={activeTab} onValueChange={(v) => { hapticTap(); if (v === 'angel' && !handleAngelTabSwitch()) return; setActiveTab(v as PoolType); }} className="w-full">
          <TabsList variant="pills" className="w-full grid grid-cols-2 gap-2">
            <TabsTrigger value="tenant" variant="pills"
              className="rounded-full text-xs font-bold gap-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <Home className="h-3.5 w-3.5" /> Tenant Support
            </TabsTrigger>
            <TabsTrigger value="angel" variant="pills"
              className="rounded-full text-xs font-bold gap-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <Rocket className="h-3.5 w-3.5" /> Angel Pool
            </TabsTrigger>
          </TabsList>

          <TabsContent value="tenant" className="mt-3 space-y-3">
            <div className="rounded-xl bg-success/5 border border-success/20 p-3">
              <p className="text-xs font-bold text-foreground">Fund verified rent requests</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">Earn monthly returns from tenant repayments</p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[10px] text-muted-foreground font-medium">
                <span className="flex items-center gap-1"><TrendingUp className="h-3 w-3 text-success" /> Up to 15%/mo</span>
                <span className="flex items-center gap-1"><Zap className="h-3 w-3" /> 24–72hr deploy</span>
                <span className="flex items-center gap-1"><Shield className="h-3 w-3" /> Verified & insured</span>
              </div>
            </div>
            <AmountInput amount={tenantAmount} onAmountChange={(val) => handleAmountChange('tenant', val)}
              onSliderChange={setTenantAmount} walletBalance={walletBalance} formatAmountCompact={formatAmountCompact}
              exceedsBalance={walletBalance > 0 && tenantAmount > walletBalance} />
            <TenantPreview amount={tenantAmount} formatAmountCompact={formatAmountCompact} />
            <Button type="button" variant="success" onClick={() => handleInvest('tenant')}
              disabled={tenantAmount < PRICE_PER_SHARE || (walletBalance > 0 && tenantAmount > walletBalance)}
              className="w-full h-12 rounded-2xl text-sm font-bold shadow-md gap-2">
              <Home className="h-4 w-4" /> Support Tenant
            </Button>
            <div className="flex items-center justify-center gap-4 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1"><Shield className="h-3 w-3" /> Capital Protected</span>
              <span>•</span><span>Min: {formatAmountCompact(PRICE_PER_SHARE)}</span>
            </div>
          </TabsContent>

          <TabsContent value="angel" className="mt-3 space-y-3">
            <div className="rounded-xl bg-primary/5 border border-primary/20 p-3">
              <p className="text-xs font-bold text-foreground">Own shares in Welile's future</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">Early-stage equity — up to {POOL_PERCENT}% pool</p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[10px] text-muted-foreground font-medium">
                <span className="flex items-center gap-1"><BarChart3 className="h-3 w-3 text-primary" /> Up to {POOL_PERCENT}% equity</span>
                <span className="flex items-center gap-1"><Lock className="h-3 w-3" /> Long-term</span>
                <span className="flex items-center gap-1"><Rocket className="h-3 w-3" /> Early-stage</span>
              </div>
            </div>
            <AmountInput amount={angelAmount} onAmountChange={(val) => handleAmountChange('angel', val)}
              onSliderChange={setAngelAmount} walletBalance={walletBalance} formatAmountCompact={formatAmountCompact}
              exceedsBalance={walletBalance > 0 && angelAmount > walletBalance} />
            <AngelPreview amount={angelAmount} formatAmountCompact={formatAmountCompact} />
            <Button type="button" onClick={() => handleInvest('angel')}
              disabled={angelAmount < PRICE_PER_SHARE || (walletBalance > 0 && angelAmount > walletBalance)}
              className="w-full h-12 rounded-2xl text-sm font-bold shadow-md gap-2">
              <Rocket className="h-4 w-4" /> Fund Angel Pool
            </Button>
            <div className="flex items-center justify-center gap-4 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1"><Shield className="h-3 w-3" /> Capital Protected</span>
              <span>•</span><span>Min: {formatAmountCompact(PRICE_PER_SHARE)}</span>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
