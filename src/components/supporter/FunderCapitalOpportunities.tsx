import { useState, useCallback, useMemo, memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/integrations/supabase/client';
import { extractFromErrorObject } from '@/lib/extractEdgeFunctionError';
import apartmentRentIllustration from '@/assets/apartment-rent-rafiki.svg.asset.json';
import apartmentRentAmicoIllustration from '@/assets/apartment-rent-amico.svg.asset.json';
import investingBroIllustration from '@/assets/investing-bro.svg.asset.json';
import {
  TrendingUp, Shield, Rocket, Home, Wallet, ChevronLeft, ChevronRight,
  Coins, Lock, Clock, HandCoins, Handshake,
  BadgeCheck, Plus, Calculator, MapPin, CheckCircle2, User,
  ChevronDown, ChevronUp, Info, Download,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useCurrency } from '@/hooks/useCurrency';
import { useWallet } from '@/hooks/useWallet';
import { useCapitalOpportunities } from '@/hooks/useCapitalOpportunities';
import { TOTAL_SHARES, PRICE_PER_SHARE, POOL_PERCENT, VALUATIONS, UGX_PER_USD } from '@/components/angel-pool/constants';
import { hapticTap } from '@/lib/haptics';
import { toast } from 'sonner';
import { FundRentDialog } from './FundRentDialog';
import { InvestmentWithdrawButton } from './InvestmentWithdrawButton';
import { useAuth } from '@/hooks/useAuth';
import { useFunderApprovalStatus } from '@/hooks/useFunderApprovalStatus';
import { SelfPortfolioFundingCard } from '@/components/partner/SelfPortfolioFundingCard';
import { HowItWorksSteps, type HowItWorksStep } from './HowItWorksSteps';
import { EmptyHouseOpportunitiesSheet } from '@/components/agent/EmptyHouseOpportunitiesSheet';
import { FunderBookedHousesPanel } from '@/components/supporter/FunderBookedHousesPanel';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

import { useProfile } from '@/hooks/useProfile';

type OptionKey = 'managed' | 'direct' | 'angel';
type ViewState = 'menu' | OptionKey;
type FeedOrder = 'rent' | 'houses';


// Configurable service/access fee on empty-house funding (rate on one-month funding).
const EMPTY_HOUSE_SERVICE_FEE_RATE = 0;

// Steps shown in the collapsible "How it works" explainer on Support Tenants Directly.
const MANAGED_FUNDING_STEPS: HowItWorksStep[] = [
  {
    title: 'Sign your tenant-support contract',
    description: 'You sign a managed tenant-support contract with Welile.',
    icon: Handshake,
  },
  {
    title: 'We deploy your capital',
    description: 'Your funds are placed into verified tenant rent requests on your behalf.',
    icon: Rocket,
  },
  {
    title: 'Our agents collect repayments',
    description: 'Welile field agents collect from tenants and reconcile every payment.',
    icon: HandCoins,
  },
  {
    title: 'Monthly returns to your wallet',
    description: 'Returns are paid into your wallet every month, with full tracking.',
    icon: Wallet,
  },
];


// Steps shown in the collapsible "How it works" explainer on the Angel Pool view.
const ANGEL_POOL_STEPS: HowItWorksStep[] = [
  {
    title: 'Buy Welile shares',
    description: `Each share costs UGX 20,000 and is bought straight from your wallet balance.`,
    icon: Coins,
  },
  {
    title: 'You own equity in the pool',
    description: `Your shares grant you a stake in the ${POOL_PERCENT}% Welile Angel Pool.`,
    icon: BadgeCheck,
  },
  {
    title: 'Capital builds the platform',
    description: 'Angel capital funds Welile growth — agents, technology and tenant coverage.',
    icon: Rocket,
  },
  {
    title: 'Value grows with Welile',
    description: 'Your shareholding is revalued as the company grows, tracked in your dashboard.',
    icon: TrendingUp,
  },
];

// ─── Reusable amount input ───
function AmountInput({
  amount, onAmountChange, onSliderChange, walletBalance, formatAmountCompact, exceedsBalance,
  currencyCode, convertFromUGX,
}: {
  amount: number; onAmountChange: (val: string) => void; onSliderChange: (val: number) => void;
  walletBalance: number; formatAmountCompact: (n: number) => string; exceedsBalance: boolean;
  currencyCode: string; convertFromUGX: (n: number) => number;
}) {
  const displayAmount = amount > 0 ? Math.round(convertFromUGX(amount)) : 0;
  return (
    <div className="space-y-2">
      <div className="rounded-xl bg-muted/40 px-3 py-2 flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground font-medium flex items-center gap-1.5">
          <Wallet className="h-3.5 w-3.5" /> Wallet Balance
        </span>
        <span className="text-sm font-black text-foreground">{formatAmountCompact(walletBalance)}</span>
      </div>
      <label className="text-xs text-muted-foreground font-semibold block">Amount ({currencyCode})</label>
      <Input
        type="text" inputMode="numeric"
        value={displayAmount > 0 ? displayAmount.toLocaleString() : ''}
        onChange={(e) => onAmountChange(e.target.value)}
        placeholder={`Min ${formatAmountCompact(PRICE_PER_SHARE)}`}
        className="text-lg font-bold h-12"
      />
      <Slider value={[amount]} onValueChange={([v]) => onSliderChange(v)} min={0}
        max={walletBalance > 0 ? walletBalance : 50_000_000} step={PRICE_PER_SHARE} className="mt-1" />
      {exceedsBalance && <p className="text-[11px] text-destructive font-medium">Amount exceeds your wallet balance</p>}
    </div>
  );
}

function AngelPreview({ amount, formatAmountCompact }: { amount: number; formatAmountCompact: (n: number) => string }) {
  if (amount <= 0) return null;
  const shares = Math.floor(amount / PRICE_PER_SHARE);
  const poolPct = (shares / TOTAL_SHARES) * 100;
  const companyPct = (POOL_PERCENT / TOTAL_SHARES) * shares;
  return (
    <div className="rounded-xl border border-border/60 bg-muted/30 p-3 space-y-2.5">
      <div className="grid grid-cols-3 gap-2">
        {[
          { val: shares.toLocaleString(), label: 'Shares' },
          { val: `${poolPct.toFixed(2)}%`, label: 'Pool %' },
          { val: `${companyPct.toFixed(4)}%`, label: 'Company %' },
        ].map(m => (
          <div key={m.label} className="rounded-lg bg-primary/5 p-2 text-center">
            <p className="text-sm font-black text-primary">{m.val}</p>
            <p className="text-[9px] text-muted-foreground font-medium">{m.label}</p>
          </div>
        ))}
      </div>
      <div className="space-y-1">
        <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-widest">Future Value Estimates</p>
        {VALUATIONS.map(v => {
          const futureVal = (companyPct / 100) * v.value * UGX_PER_USD;
          return (
            <div key={v.label} className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">At {v.label}</span>
              <span className="font-black text-success">{formatAmountCompact(futureVal)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Option row (menu button) ───
function OptionRow({
  icon: Icon, title, description, tooltip, onClick,
}: {
  icon: typeof Home; title: string; description: string; tooltip?: string; onClick: () => void;
}) {
  const button = (
    <motion.button
      type="button"
      onClick={() => { hapticTap(); onClick(); }}
      whileHover={{ y: -3, scale: 1.01 }}
      whileTap={{ scale: 0.97 }}
      whileFocus={{ y: -2, scale: 1.005 }}
      transition={{ type: 'spring', stiffness: 420, damping: 24 }}
      className="group relative w-full flex items-center gap-3.5 rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/20 hover:shadow-xl hover:shadow-primary/30 px-4 py-3.5 text-left ring-1 ring-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background overflow-hidden"
    >
      <span className="pointer-events-none absolute inset-0 group-hover:animate-[shimmer_1.2s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/15 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" aria-hidden="true" />
      <div className="relative p-3 rounded-xl bg-white/25 text-white shrink-0 backdrop-blur-sm ring-1 ring-white/30 shadow-inner shadow-white/10 group-hover:bg-white/35 group-focus-visible:bg-white/35 group-hover:scale-105 group-focus-visible:scale-105 transition-all duration-200">
        <Icon className="h-6 w-6" strokeWidth={2.5} />
      </div>
      <div className="relative flex-1 min-w-0">
        <p className="text-sm font-bold text-white leading-tight">{title}</p>
        <p className="text-[11px] text-white/80 font-medium mt-0.5 leading-snug">{description}</p>
      </div>
      <ChevronRight className="relative h-5 w-5 text-white/80 shrink-0 group-hover:translate-x-1 group-focus-visible:translate-x-1 transition-transform duration-200" />
    </motion.button>
  );

  if (!tooltip) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={8} className="max-w-[16rem] text-xs leading-relaxed">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

// ─── Option card (square grid card) ───
function OptionCard({
  icon: Icon, title, description, tooltip, onClick, image, light, featured,
}: {
  icon: typeof Home; title: string; description: string; tooltip?: string; onClick: () => void;
  image?: string; light?: boolean; featured?: boolean;
}) {
  const button = (
    <motion.button
      type="button"
      onClick={() => { hapticTap(); onClick(); }}
      whileHover={{ y: -4, scale: 1.02 }}
      whileTap={{ scale: 0.97 }}
      whileFocus={{ y: -2, scale: 1.01 }}
      transition={{ type: 'spring', stiffness: 420, damping: 24 }}
      style={light ? { backgroundColor: '#d1eaed' } : undefined}
      className={
        light
          ? "group relative w-full aspect-square sm:aspect-auto sm:h-full sm:min-h-[15rem] rounded-2xl text-foreground shadow-lg shadow-foreground/10 hover:shadow-xl p-4 text-center ring-1 ring-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background overflow-hidden"
          : "group relative w-full aspect-square sm:aspect-auto sm:h-full sm:min-h-[15rem] rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/20 hover:shadow-xl hover:shadow-primary/30 p-4 text-center ring-1 ring-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background overflow-hidden"
      }
    >
      <span className={`pointer-events-none absolute inset-0 group-hover:animate-[shimmer_1.2s_ease-in-out_infinite] bg-gradient-to-r from-transparent ${light ? 'via-white/50' : 'via-white/15'} to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300`} aria-hidden="true" />
      <div className="relative flex flex-col items-center justify-between h-full gap-1 pt-1 pb-0.5">
        {image ? (
          <img
            src={image}
            alt=""
            aria-hidden="true"
            loading="lazy"
            className={`relative w-full object-contain shrink-0 group-hover:scale-105 group-focus-visible:scale-105 transition-transform duration-200 sm:flex-none sm:h-24 sm:max-h-24 md:h-28 md:max-h-28 ${featured ? 'max-w-[58%] flex-[0.58] mt-1 mb-1 sm:max-w-[70%]' : 'max-w-[92%] flex-1 min-h-0 sm:max-w-[80%]'}`}
          />
        ) : (
          <div className={`relative p-5 rounded-2xl shrink-0 backdrop-blur-sm ring-1 shadow-inner group-hover:scale-110 group-focus-visible:scale-110 transition-all duration-200 ${light ? 'bg-white/60 text-primary ring-foreground/10' : 'bg-white/25 text-white ring-white/30 shadow-white/10 group-hover:bg-white/35 group-focus-visible:bg-white/35'}`}>
            <Icon className="h-9 w-9" strokeWidth={2.5} />
          </div>
        )}
        <div className={`relative flex flex-col items-center justify-end gap-1 min-h-0 sm:flex-none sm:justify-start sm:mt-2 ${image ? 'mt-auto sm:mt-2' : ''} ${featured ? 'pb-1 flex-[0.42] sm:flex-none' : ''}`}>
          <p className={`font-bold leading-tight ${featured ? 'text-base sm:text-lg' : 'text-lg'} ${light ? 'text-slate-900' : 'text-white'}`}>{title}</p>
          <p className={`font-medium leading-snug sm:line-clamp-none ${featured ? 'line-clamp-3 text-xs sm:text-[13px]' : 'line-clamp-3 text-[13px]'} ${light ? 'text-slate-700' : 'text-white/80'}`}>{description}</p>
        </div>
        <ChevronRight className={`relative h-5 w-5 shrink-0 sm:mt-3 group-hover:translate-x-1 group-focus-visible:translate-x-1 transition-transform duration-200 ${light ? 'text-slate-600' : 'text-white/80'}`} />
      </div>
    </motion.button>
  );

  if (!tooltip) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={8} className="max-w-[16rem] text-xs leading-relaxed">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}


function DetailShell({ title, subtitle, onBack, children, compactMobile = false }: {
  title: string; subtitle: string; onBack?: () => void; children: React.ReactNode; compactMobile?: boolean;
}) {
  return (
    <div className={`border border-border/80 bg-card overflow-hidden shadow-sm ${compactMobile ? 'rounded-xl sm:rounded-2xl' : 'rounded-2xl'}`}>
      <div className={`${compactMobile ? 'px-3.5 py-3 sm:px-5 sm:pt-4 sm:pb-3' : 'px-5 pt-4 pb-3'} flex items-center gap-2.5 border-b border-border/50`}>
        {onBack && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => { hapticTap(); onBack(); }}
            className="-ml-1.5 gap-1 px-2 text-muted-foreground hover:text-foreground hover:bg-muted/60"
            aria-label="Back to Capital Opportunities"
          >
            <ChevronLeft className="h-4 w-4" />
            <span className="text-xs font-semibold">Back</span>
          </Button>
        )}
        <div className="min-w-0">
          <h3 className="font-black text-foreground text-sm tracking-tight leading-tight truncate">{title}</h3>
          <p className="text-[10px] text-muted-foreground font-medium leading-tight truncate">{subtitle}</p>
        </div>
      </div>
      <div className={`${compactMobile ? 'px-3 py-3 sm:px-5 sm:py-4 sm:space-y-4' : 'px-5 py-4 space-y-4'} space-y-3`}>{children}</div>
    </div>
  );
}

type BreakdownBy = 'district' | 'landlord';
type BreakdownSort = 'rent' | 'houses';
type BreakdownRow = { label: string; house_count: number; total_rent_needed: number; monthly_return: number };

const segBtnClass = (active: boolean) =>
  `px-2.5 h-7 text-[11px] font-bold transition-colors ${
    active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/60'
  }`;

/**
 * Ranked district/landlord breakdown. Owns its own view state so the segmented
 * toggles only re-render this panel — previously they lived on the parent and
 * every tap re-rendered the entire Capital Opportunities widget (dialogs, house
 * picker, calculator), which read on-device as a full-screen reload.
 */
const BiggestOpportunitiesPanel = memo(function BiggestOpportunitiesPanel({
  districts,
  landlords,
  formatAmountCompact,
  onExportPdf,
}: {
  districts: BreakdownRow[];
  landlords: BreakdownRow[];
  formatAmountCompact: (n: number) => string;
  onExportPdf: (rows: BreakdownRow[], by: BreakdownBy, sort: BreakdownSort) => void;
}) {
  const [breakdownBy, setBreakdownBy] = useState<BreakdownBy>('district');
  const [breakdownSort, setBreakdownSort] = useState<BreakdownSort>('rent');
  const [breakdownTopN, setBreakdownTopN] = useState<6 | 12 | 0>(6); // 0 = all
  const [expanded, setExpanded] = useState(false);

  const top = useMemo(() => {
    const rows = breakdownBy === 'district' ? districts : landlords;
    const sorted = [...rows].sort((a, b) =>
      breakdownSort === 'rent'
        ? b.total_rent_needed - a.total_rent_needed
        : b.house_count - a.house_count,
    );
    return breakdownTopN === 0 ? sorted : sorted.slice(0, breakdownTopN);
  }, [districts, landlords, breakdownBy, breakdownSort, breakdownTopN]);

  if (top.length === 0) return null;

  const maxRent = Math.max(1, ...top.map(r => r.total_rent_needed));
  const maxHouses = Math.max(1, ...top.map(r => r.house_count));

  return (
    <div className="rounded-xl bg-card border border-border/60 p-3.5 space-y-3">
      <button
        type="button"
        onClick={() => { hapticTap(); setExpanded(v => !v); }}
        className="w-full flex items-center justify-between gap-2 text-left"
        aria-expanded={expanded}
      >
        <p className="text-[11px] text-muted-foreground font-bold uppercase tracking-wider">
          Biggest opportunities
        </p>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>


      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="space-y-3 pt-1">
              <div className="flex items-center justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 rounded-lg px-2.5 text-[11px] font-bold"
                  onClick={() => { hapticTap(); onExportPdf(top, breakdownBy, breakdownSort); }}
                >
                  <Download className="h-3.5 w-3.5" /> PDF
                </Button>
              </div>

              <div className="flex items-center gap-x-3 gap-y-2 flex-wrap">
                <div className="flex rounded-lg border border-border/60 overflow-hidden">
                  {(['district', 'landlord'] as const).map(k => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => { hapticTap(); setBreakdownBy(k); }}
                      className={`${segBtnClass(breakdownBy === k)} capitalize`}
                    >
                      {k}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground font-medium">Rank by</span>
                  <div className="flex rounded-lg border border-border/60 overflow-hidden">
                    {([
                      { k: 'rent' as const, label: 'Rent needed' },
                      { k: 'houses' as const, label: 'Houses' },
                    ]).map(o => (
                      <button
                        key={o.k}
                        type="button"
                        onClick={() => { hapticTap(); setBreakdownSort(o.k); }}
                        className={segBtnClass(breakdownSort === o.k)}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground font-medium">Show</span>
                  <div className="flex rounded-lg border border-border/60 overflow-hidden">
                    {([
                      { k: 6 as const, label: 'Top 6' },
                      { k: 12 as const, label: 'Top 12' },
                      { k: 0 as const, label: 'All' },
                    ]).map(o => (
                      <button
                        key={o.label}
                        type="button"
                        onClick={() => { hapticTap(); setBreakdownTopN(o.k); }}
                        className={segBtnClass(breakdownTopN === o.k)}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="divide-y divide-border/50">
                {top.map((r, i) => (
                  <div key={r.label} className="py-2.5 first:pt-0 last:pb-0 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[12px] font-bold text-foreground flex items-center gap-1.5 min-w-0">
                        <span className="text-[10px] font-black text-muted-foreground w-4 shrink-0 tabular-nums">
                          {i + 1}
                        </span>
                        {breakdownBy === 'district'
                          ? <MapPin className="h-3.5 w-3.5 text-primary shrink-0" />
                          : <User className="h-3.5 w-3.5 text-primary shrink-0" />}
                        <span className="truncate">{r.label}</span>
                      </p>
                      <span className="text-[11px] font-semibold text-muted-foreground shrink-0 tabular-nums">
                        {r.house_count.toLocaleString()} houses
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{
                          width: `${Math.max(4, Math.round(((breakdownSort === 'rent'
                            ? r.total_rent_needed / maxRent
                            : r.house_count / maxHouses) * 100)))}%`,
                        }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-[11px] font-medium">
                      <span className="text-muted-foreground">{formatAmountCompact(r.total_rent_needed)} rent needed</span>
                      <span className="text-success font-bold">{formatAmountCompact(r.monthly_return)} / month</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
});

// ═══ MAIN ═══

export function FunderCapitalOpportunities({
  initialView = 'menu',
  initialFeedOrder = 'houses',
  embedded = false,
}: {
  initialView?: ViewState;
  initialFeedOrder?: FeedOrder;
  embedded?: boolean;
} = {}) {
  const { formatAmountCompact, currency, convertFromUGX, convertToUGX } = useCurrency();
  const { wallet } = useWallet();
  const walletBalance = wallet?.balance ?? 0;
  const { opportunitySummary, emptyHouseSummary, loading } = useCapitalOpportunities();
  const { user } = useAuth();
  const { profile } = useProfile();
  const { isApproved, status: approvalStatus } = useFunderApprovalStatus(user?.id);

  const [view, setView] = useState<ViewState>(initialView);
  const [housePickerOpen, setHousePickerOpen] = useState(false);
  const [showFundDialog, setShowFundDialog] = useState(false);
  const [angelAmount, setAngelAmount] = useState(0);
  const [investLoading, setInvestLoading] = useState(false);
  // Empty-house funding calculator + breakdown UI state (display only)
  const [calcHouses, setCalcHouses] = useState(5);
  const [calcAmountInput, setCalcAmountInput] = useState('');
  const [calcOpen, setCalcOpen] = useState(false);
  const [showHowItWorks, setShowHowItWorks] = useState(false);
  const [feedOrder, setFeedOrder] = useState<FeedOrder>(initialFeedOrder);

  const [feeRatePct, setFeeRatePct] = useState(EMPTY_HOUSE_SERVICE_FEE_RATE * 100);

  // Export the currently ranked district/landlord breakdown as a PDF (display only)
  const exportRankingPdf = useCallback(async (
    rows: Array<{ label: string; house_count: number; total_rent_needed: number; monthly_return: number }>,
    breakdownBy: BreakdownBy,
    breakdownSort: BreakdownSort,
  ) => {
    try {
      const [{ default: JsPDF }, { default: autoTable }] = await Promise.all([
        import('jspdf'),
        import('jspdf-autotable'),
      ]);
      const doc = new JsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
      const title = breakdownBy === 'district'
        ? 'Empty house opportunities by district'
        : 'Empty house opportunities by landlord';
      doc.setFontSize(14);
      doc.text(title, 40, 44);
      doc.setFontSize(9);
      doc.text(
        `Ranked by ${breakdownSort === 'rent' ? 'rent needed' : 'house count'} · ${new Date().toLocaleString('en-GB')}`,
        40, 60,
      );
      autoTable(doc, {
        startY: 76,
        head: [['#', breakdownBy === 'district' ? 'District' : 'Landlord', 'Houses', 'Rent needed (UGX)', 'Return / month (UGX)']],
        body: rows.map((r, i) => [
          String(i + 1),
          r.label,
          r.house_count.toLocaleString(),
          Math.round(r.total_rent_needed).toLocaleString(),
          Math.round(r.monthly_return).toLocaleString(),
        ]),
        foot: [[
          '',
          'Total',
          rows.reduce((a, r) => a + r.house_count, 0).toLocaleString(),
          Math.round(rows.reduce((a, r) => a + r.total_rent_needed, 0)).toLocaleString(),
          Math.round(rows.reduce((a, r) => a + r.monthly_return, 0)).toLocaleString(),
        ]],
        styles: { fontSize: 8, cellPadding: 4 },
        headStyles: { fillColor: [30, 30, 30] },
        footStyles: { fillColor: [240, 240, 240], textColor: 20, fontStyle: 'bold' },
      });
      doc.save(`empty-house-opportunities-by-${breakdownBy}.pdf`);
      toast.success('PDF downloaded');
    } catch {
      toast.error('Could not generate the PDF. Please try again.');
    }
  }, []);


  // Shared calculator derivation — used by the calculator UI and to pre-fill the picker
  const computeScenario = useCallback((amountInput: string, houseCount: number) => {
    const s = emptyHouseSummary;
    const avg = Math.max(1, s?.avg_monthly_rent ?? 0);
    const maxHouses = Math.max(1, Math.min(s?.house_count ?? 1, 100));
    const typed = parseInt(amountInput.replace(/[^0-9]/g, ''), 10);
    const usingAmount = !isNaN(typed) && typed > 0;
    const houses = usingAmount
      ? Math.max(1, Math.min(Math.round(typed / avg), s?.house_count ?? 1))
      : Math.min(houseCount, maxHouses);
    const funding = usingAmount ? typed : houses * avg;
    const monthly = Math.round(funding * 0.15);
    const serviceFee = Math.round(funding * (feeRatePct / 100));
    const netMonthly = monthly - serviceFee;
    return { avg, maxHouses, typed, usingAmount, houses, funding, monthly, serviceFee, netMonthly };
  }, [emptyHouseSummary, feeRatePct]);

  const calc = useMemo(() => computeScenario(calcAmountInput, calcHouses), [computeScenario, calcAmountInput, calcHouses]);


  const handleAngelAmountChange = (val: string) => {
    const num = parseInt(val.replace(/[^0-9]/g, ''), 10);
    if (isNaN(num)) { setAngelAmount(0); return; }
    const ugx = Math.round(convertToUGX(num));
    const max = walletBalance > 0 ? walletBalance : 500_000_000;
    setAngelAmount(Math.min(ugx, max));
  };

  const handleAngelInvest = useCallback(async () => {
    if (angelAmount < PRICE_PER_SHARE) return;
    if (walletBalance > 0 && angelAmount > walletBalance) return;
    hapticTap();
    setInvestLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('angel-pool-invest', {
        body: { amount: angelAmount },
      });
      if (error) {
        const msg = await extractFromErrorObject(error, 'Investment failed. Please try again.');
        toast.error(msg);
        return;
      }
      if (data?.error) { toast.error(data.error); return; }
      toast.success(`${data.shares} shares secured. Ref: ${data.reference_id}`, {
        description: `Pool ownership: ${data.pool_ownership_percent.toFixed(4)}%`,
      });
      setAngelAmount(0);
      window.dispatchEvent(new CustomEvent('supporter-contribution-changed'));
      window.dispatchEvent(new CustomEvent('wallet-balance-changed'));
    } catch (err: any) {
      toast.error(err?.message || 'Investment failed');
    } finally {
      setInvestLoading(false);
    }
  }, [angelAmount, walletBalance]);

  if (loading) {
    return <div className="h-48 rounded-2xl bg-muted/50 animate-pulse" />;
  }

  // ─── MENU ───
  if (view === 'menu') {
    const activeDemand = opportunitySummary?.total_rent_requested ?? 0;
    return (
      <div className="rounded-2xl border border-border/80 bg-card overflow-hidden shadow-sm">
        <div className="px-5 pt-5 pb-4 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-black text-foreground text-base tracking-tight leading-tight">
                Capital Opportunities
              </h3>
              <p className="text-[11px] text-muted-foreground font-medium mt-0.5">
                Choose how you want to deploy capital.
              </p>
            </div>
            {activeDemand > 0 && (
              <div className="text-right shrink-0">
                <p className="text-[9px] text-muted-foreground font-semibold uppercase tracking-widest">Active demand</p>
                <p className="text-sm font-black text-foreground">{formatAmountCompact(activeDemand)}</p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-[clamp(8px,2vw,20px)]">
            {[
              {
                key: 'managed' as const,
                Icon: Handshake,
                title: 'Support tenants via Welile',
                description: 'We deploy the capital and manage the returns.',
                recommended: false,
              },
              {
                key: 'direct' as const,
                Icon: HandCoins,
                title: 'Fund',
                description: 'Pay landlords yourself. We handle the introduction and the paperwork.',
                recommended: true,
              },
              {
                key: 'angel' as const,
                Icon: Rocket,
                title: 'Angel pool',
                description: 'Buy a Welile share and back the long-term vision.',
                recommended: false,
              },
            ].map((route) => (
              <button
                key={route.key}
                type="button"
                onClick={() => { hapticTap(); setView(route.key); }}
                className={`group flex w-full flex-col text-left transition-all hover:-translate-y-1 active:-translate-y-px rounded-[clamp(16px,4.5vw,22px)] bg-card p-[clamp(15px,4.2vw,22px)] ${
                  route.recommended
                    ? 'border-[2.5px] border-primary/50 hover:border-primary'
                    : 'border-[1.5px] border-primary hover:border-primary'
                }`}
              >
                <div className="mb-[clamp(12px,3.4vw,20px)] flex items-start justify-between gap-2.5">
                  <span className="grid h-[clamp(38px,10.5vw,52px)] w-[clamp(38px,10.5vw,52px)] place-items-center rounded-[clamp(11px,3vw,15px)] bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                    <route.Icon className="h-[clamp(21px,5.8vw,30px)] w-[clamp(21px,5.8vw,30px)]" />
                  </span>
                  {route.recommended && (
                    <span className="inline-flex items-center gap-[clamp(2px,0.8vw,5px)] rounded-full border border-primary/30 bg-primary/10 px-[clamp(6px,2vw,11px)] py-[clamp(4px,1.3vw,7px)] text-[clamp(7.5px,2.1vw,10.5px)] font-bold uppercase tracking-wider text-primary">
                      Recommended
                    </span>
                  )}
                </div>
                <h3 className="m-0 mb-[clamp(5px,1.6vw,8px)] text-[clamp(18px,5vw,24px)] font-extrabold leading-tight tracking-[-0.02em] text-foreground">
                  {route.title}
                </h3>
                <p className="m-0 mb-[clamp(14px,3.8vw,24px)] max-w-[32ch] text-[clamp(12.5px,3.5vw,14.5px)] font-medium leading-relaxed text-muted-foreground">
                  {route.description}
                </p>
                <span className="mt-auto grid h-[clamp(30px,8vw,38px)] w-[clamp(30px,8vw,38px)] place-items-center rounded-full bg-primary/10 text-primary transition-all group-hover:translate-x-0.5 group-hover:bg-primary group-hover:text-primary-foreground">
                  <ChevronRight className="h-[clamp(13px,3.6vw,16px)] w-[clamp(13px,3.6vw,16px)]" />
                </span>
              </button>
            ))}
          </div>


          <div className="flex items-center justify-center gap-3 pt-1 text-[10px] text-muted-foreground font-medium">
            <span className="flex items-center gap-1"><BadgeCheck className="h-3 w-3 text-success" /> Verified</span>
            <span className="text-border">•</span>
            <span className="flex items-center gap-1"><Shield className="h-3 w-3" /> Structured</span>
            <span className="text-border">•</span>
            <span className="flex items-center gap-1"><Lock className="h-3 w-3" /> Secure</span>
          </div>
        </div>
      </div>
    );
  }

  // ─── MANAGED (Welile contract) ───
  if (view === 'managed') {
    const summary = opportunitySummary;
    return (
      <>
        <DetailShell
          title="Support Tenants via Welile"
          subtitle="Managed tenant-support contract"
          onBack={embedded ? undefined : () => setView('menu')}
        >
          <HowItWorksSteps steps={MANAGED_FUNDING_STEPS} />

          <div>
            <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-widest">Total Rent Demand</p>
            <p className="text-3xl font-black text-foreground tracking-tight mt-0.5">
              {formatAmountCompact(summary?.total_rent_requested ?? 0)}
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {[
              { value: (summary?.total_requests ?? 0).toLocaleString(), label: 'Requests' },
              { value: (summary?.total_landlords ?? 0).toLocaleString(), label: 'Landlords' },
              { value: (summary?.total_agents ?? 0).toLocaleString(), label: 'Agents' },
            ].map(s => (
              <div key={s.label} className="rounded-xl border border-border/60 bg-muted/20 p-2.5 text-center">
                <p className="text-base font-black text-foreground">{s.value}</p>
                <p className="text-[9px] text-muted-foreground font-medium">{s.label}</p>
              </div>
            ))}
          </div>

          <div className="space-y-2">
            {[
              { icon: TrendingUp, label: 'Monthly Return', value: 'Up to 15%', valueClass: 'text-success font-black' },
              { icon: Clock, label: 'Deployment', value: '24–72 hours', valueClass: 'font-bold' },
              { icon: Coins, label: 'Payouts', value: 'Monthly to wallet', valueClass: 'font-bold' },
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

          <Button
            onClick={() => { hapticTap(); if (isApproved) setShowFundDialog(true); }}
            disabled={!isApproved}
            className="w-full h-12 rounded-2xl text-sm font-bold shadow-md gap-2 uppercase tracking-wide"
          >
            {isApproved
              ? (<>Support Tenant <ChevronRight className="h-4 w-4" /></>)
              : (<><Lock className="h-4 w-4" /> {approvalStatus === 'rejected' ? 'Verification Required' : 'Awaiting Verification'}</>)}
          </Button>
          <InvestmentWithdrawButton />

          <p className="text-[10px] text-muted-foreground/70 text-center leading-relaxed">
            Returns are projected from historical performance. Capital is deployed into verified rent
            facilitation agreements managed by Welile with reserve protection.
          </p>
        </DetailShell>

        {opportunitySummary && (
          <FundRentDialog
            open={showFundDialog}
            onOpenChange={setShowFundDialog}
            summary={opportunitySummary}
          />
        )}
      </>
    );
  }

  // ─── DIRECT (pay landlord directly) ───
  if (view === 'direct') {
    return ( <TooltipProvider delayDuration={150}>
      <DetailShell
        title="Support Tenants Directly"
        subtitle="Fund approved tenant rent plans from your balance"
        onBack={embedded ? undefined : () => setView('menu')}
        compactMobile
      >

        {/* One merged list: empty houses and houses with ready tenants */}
        <div className="space-y-2.5 sm:pt-2 sm:space-y-3">
          <div className="w-full rounded-md bg-success px-2 py-2 text-center text-[11px] sm:text-xs font-bold leading-tight text-white min-h-11 flex items-center justify-center">
            Houses to fund
          </div>

          {user?.id
            ? <SelfPortfolioFundingCard partnerId={user.id} feedOrder={feedOrder} onFeedOrderChange={setFeedOrder} />
            : <p className="text-[11px] text-muted-foreground">Sign in to view houses to fund.</p>}
        </div>

        {/* Empty-house extras: how it works, return calculator, saved picks */}
        <div className="pt-2 space-y-3">
          <div className="flex min-w-0 items-center gap-2">
            <div className="h-5 w-1 shrink-0 rounded-full bg-primary" />
            <div className="min-w-0">
              <h4 className="text-sm font-black text-foreground tracking-tight">Choose an empty house</h4>
              <p className="truncate text-[10px] text-muted-foreground">Tap a rent marker or house photo</p>
            </div>
          </div>

          {/* Single "How it works" explainer — opens a dedicated dialog */}
          <Dialog open={showHowItWorks} onOpenChange={setShowHowItWorks}>
            <div className="flex flex-wrap items-center gap-2">
              <DialogTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 rounded-full text-[11px] font-bold"
                  onClick={() => hapticTap()}
                >
                  <Info className="h-3.5 w-3.5" aria-hidden />
                  How it works
                </Button>
              </DialogTrigger>
            </div>

            <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">
              <DialogHeader>
                <DialogTitle>How it works</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div className="rounded-xl border border-primary/25 bg-primary/5 p-3 sm:p-3.5 space-y-2.5">
                  <p className="text-[12px] sm:text-[13px] font-black text-foreground leading-snug">
                    Start a rental business with your savings — even small ones.
                  </p>
                  <ol className="space-y-1.5">
                    {[
                      'Fund an empty house — cover its monthly rent amount. Every house below is ready to fund today.',
                      'Welile places a verified tenant for you — our agents find the tenant, they move in and start paying rent.',
                      'You earn 15% every month of the rent amount you contributed — paid into your Welile wallet as the tenant pays.',
                    ].map((text, i) => (
                      <li key={i} className="flex items-start gap-2 text-[11px] sm:text-xs text-foreground/90 font-medium leading-snug">
                        <span className={`shrink-0 mt-0.5 h-4 w-4 rounded-full text-[10px] font-black flex items-center justify-center ${i === 2 ? 'bg-success text-success-foreground' : 'bg-primary text-primary-foreground'}`}>
                          {i + 1}
                        </span>
                        <span>{text}</span>
                      </li>
                    ))}
                  </ol>
                </div>

                <div className="rounded-xl border border-success/25 bg-success/5 p-3 sm:p-3.5 space-y-2.5">
                  <p className="text-[12px] sm:text-[13px] font-black text-foreground leading-snug">
                    See what you could earn each month.
                  </p>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div className="rounded-lg bg-background/60 p-2.5 space-y-1">
                      <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wide">Example house rent</p>
                      <p className="text-base font-black text-foreground">UGX 600,000</p>
                    </div>
                    <div className="rounded-lg bg-background/60 p-2.5 space-y-1">
                      <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wide">Your monthly Returns</p>
                      <p className="text-base font-black text-success">UGX 90,000</p>
                    </div>
                  </div>
                  <p className="text-[10px] sm:text-[11px] text-muted-foreground font-medium leading-snug">
                    Monthly earnings = rent amount × 15%. Over a 12-month Rent Plan, UGX 90,000 × 12 = UGX 1,080,000.
                  </p>
                </div>

                <div className="rounded-xl border border-border/60 bg-muted/30 p-3 sm:p-3.5 space-y-2">
                  <p className="text-[12px] sm:text-[13px] font-black text-foreground leading-snug">
                    A few things to know before you fund.
                  </p>
                  <ul className="space-y-1.5 text-[11px] sm:text-xs text-foreground/90 font-medium leading-snug">
                    <li className="flex items-start gap-2">
                      <span className="mt-1 h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                      <span>Each empty-house fund is a 12-month Rent Plan.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="mt-1 h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                      <span>Returns are paid monthly into your wallet as the tenant pays rent.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="mt-1 h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                      <span>Minimum funding is UGX 50,000. If your balance is short, the house stays saved while you top up.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="mt-1 h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                      <span>Welile handles tenant placement, rent collection and reconciliation.</span>
                    </li>
                  </ul>
                </div>
              </div>
            </DialogContent>
          </Dialog>

          {/* House cards appear first so funders can browse immediately */}
          {user?.id
            ? <SelfPortfolioFundingCard partnerId={user.id} feedOrder="houses" onFeedOrderChange={setFeedOrder} />
            : <p className="text-[11px] text-muted-foreground">Sign in to view empty houses.</p>}


          {/* Calculator: pick how many houses (or an amount) and see the return */}
          {(() => {
            const avgAvailable = (emptyHouseSummary?.avg_monthly_rent ?? 0) > 0;
            return (
              <div className="rounded-xl bg-card border border-border/60 p-3.5 space-y-3">
                <button
                  type="button"
                  onClick={() => { hapticTap(); setCalcOpen(v => !v); }}
                  className="w-full flex items-center justify-between gap-2 text-left"
                  aria-expanded={calcOpen}
                  aria-controls="empty-house-earn-calc"
                >
                  <div className="flex items-center gap-2">
                    <Calculator className="h-4 w-4 text-primary" />
                    <p className="text-[12px] text-foreground font-bold">
                      What will I earn?
                    </p>
                  </div>
                  {calcOpen ? (
                    <ChevronUp className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  )}
                </button>

                {calcOpen && !avgAvailable && (
                  <p id="empty-house-earn-calc" className="text-[11px] text-muted-foreground font-medium">
                    We can't estimate returns yet — average rent data for empty houses isn't available.
                    Browse the houses below to see exact figures per house.
                  </p>
                )}

                {calcOpen && avgAvailable && (
                  <div id="empty-house-earn-calc" className="space-y-3">
                    <div className="rounded-lg bg-muted/40 border border-border/50 p-3 space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="text-[12px] font-semibold text-foreground">Houses</p>
                        <span className="text-base font-black text-foreground tabular-nums">
                          {calc.houses.toLocaleString()}
                        </span>
                      </div>
                      <Slider
                        value={[Math.min(calcHouses, calc.maxHouses)]}
                        min={1}
                        max={calc.maxHouses}
                        step={1}
                        onValueChange={(v) => { setCalcAmountInput(''); setCalcHouses(v[0]); }}
                      />
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-muted-foreground font-medium shrink-0">
                          or amount (UGX)
                        </span>
                        <Input
                          inputMode="numeric"
                          placeholder={String(calc.avg)}
                          value={calcAmountInput}
                          onChange={(e) => setCalcAmountInput(e.target.value.replace(/[^0-9]/g, ''))}
                          className="h-9 text-xs"
                          autoFocus={calcOpen}
                        />
                      </div>

                      <div className="grid grid-cols-3 gap-2 pt-0.5">
                        <div>
                          <p className="text-[10px] text-muted-foreground font-medium">Funding total</p>
                          <p className="text-[13px] font-black text-foreground tabular-nums">
                            {formatAmountCompact(calc.funding)}
                          </p>
                        </div>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="cursor-help">
                              <p className="text-[10px] text-muted-foreground font-medium flex items-center gap-1">
                                Fees <Info className="h-3 w-3 text-muted-foreground/70" />
                              </p>
                              <p className={`text-[13px] font-black tabular-nums ${calc.serviceFee > 0 ? 'text-warning' : 'text-muted-foreground'}`}>
                                {formatAmountCompact(calc.serviceFee)}
                              </p>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-[16rem] text-xs leading-relaxed">
                            Service/access fee = Funding total × service fee rate.
                            Current rate is {feeRatePct.toFixed(1)}%,
                            so the fee is {formatAmountCompact(calc.serviceFee)}.
                          </TooltipContent>
                        </Tooltip>
                        <div className="text-right">
                          <p className="text-[10px] text-muted-foreground font-medium">Net monthly</p>
                          <p className="text-[13px] font-black text-success tabular-nums">
                            {formatAmountCompact(calc.netMonthly)}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-lg border border-border/60 bg-muted/30 p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                          Service/access fee rate
                        </p>
                        <span className="text-[13px] font-black text-foreground tabular-nums">{feeRatePct.toFixed(1)}%</span>
                      </div>
                      <Slider
                        value={[feeRatePct]}
                        min={0}
                        max={15}
                        step={0.5}
                        onValueChange={(v) => setFeeRatePct(v[0])}
                      />
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {[0, 2, 5, 10].map(p => (
                          <button
                            key={p}
                            type="button"
                            onClick={() => { hapticTap(); setFeeRatePct(p); }}
                            className={`px-2.5 py-1 rounded-md border border-border/60 text-[11px] font-bold transition-colors ${feeRatePct === p ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/60'}`}
                          >
                            {p}%
                          </button>
                        ))}
                        <span className="text-[10px] text-muted-foreground font-medium ml-auto">
                          Adjust to test how fees change this estimate
                        </span>
                      </div>
                    </div>

                    <p className="text-[10px] text-muted-foreground font-medium leading-relaxed">
                      Estimate uses the average rent of {formatAmountCompact(calc.avg)} per empty house. Exact figures are shown per house in the picker.
                      {feeRatePct <= 0 && ' No service/access fee is currently applied.'}
                    </p>

                    <Button
                      variant="outline"
                      className="h-10 w-full gap-2 rounded-xl text-xs font-bold"
                      onClick={() => { hapticTap(); setHousePickerOpen(true); }}
                    >
                      <Home className="h-4 w-4" />
                      {calc.usingAmount
                        ? `See houses up to ${formatAmountCompact(calc.typed)}`
                        : `Pick ${calc.houses.toLocaleString()} ${calc.houses === 1 ? 'house' : 'houses'}`}
                    </Button>
                  </div>
                )}
              </div>
            );
          })()}


          <FunderBookedHousesPanel />


          <Button
            variant="outline"
            className="h-11 w-full gap-2 text-xs font-bold rounded-xl"
            onClick={() => { hapticTap(); setHousePickerOpen(true); }}
          >
            <Home className="h-4 w-4" /> Browse all houses
          </Button>

        </div>
        )}

        <EmptyHouseOpportunitiesSheet
          open={housePickerOpen}
          onOpenChange={setHousePickerOpen}
          mode="partner"
          selfName={profile?.full_name ?? null}
          selfPhone={(profile as { phone?: string } | null)?.phone ?? null}
          selfEmail={(profile as { email?: string } | null)?.email ?? null}
          initialMaxRent={calc.usingAmount ? calc.typed : null}
          projection={{ houses: calc.houses, funding: calc.funding, monthly: calc.monthly }}
        />
      </DetailShell>
    </TooltipProvider> );
  }

  // ─── ANGEL POOL ───
  return (
    <DetailShell
      title="Angel Pool"
      subtitle={`Buy a Welile share — up to ${POOL_PERCENT}% equity pool`}
      onBack={embedded ? undefined : () => setView('menu')}
    >
      <HowItWorksSteps steps={ANGEL_POOL_STEPS} label="Own shares in Welile's future" />

      <AmountInput
        amount={angelAmount}
        onAmountChange={handleAngelAmountChange}
        onSliderChange={setAngelAmount}
        walletBalance={walletBalance}
        formatAmountCompact={formatAmountCompact}
        exceedsBalance={walletBalance > 0 && angelAmount > walletBalance}
        currencyCode={currency.code}
        convertFromUGX={convertFromUGX}
      />

      <AngelPreview amount={angelAmount} formatAmountCompact={formatAmountCompact} />

      <Button
        type="button"
        onClick={handleAngelInvest}
        disabled={investLoading || angelAmount < PRICE_PER_SHARE || (walletBalance > 0 && angelAmount > walletBalance)}
        className="w-full h-12 rounded-2xl text-sm font-bold shadow-md gap-2 uppercase tracking-wide"
      >
        <Rocket className="h-4 w-4" /> {investLoading ? 'Processing…' : 'Fund Angel Pool'}
      </Button>

      <div className="flex items-center justify-center gap-3 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1"><Shield className="h-3 w-3" /> Capital Protected</span>
        <span className="text-border">•</span>
        <span>Min: {formatAmountCompact(PRICE_PER_SHARE)}</span>
      </div>
    </DetailShell>
  );
}