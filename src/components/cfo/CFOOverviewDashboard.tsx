import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CashPositionInsights } from '@/components/cfo/CashPositionInsights';
import { useCFOOverviewData } from '@/hooks/useCFOOverviewData';
import { useCFO7DayCashFlow } from '@/hooks/useCFO7DayCashFlow';
import { useActualMoneyHeld } from '@/hooks/useActualMoneyHeld';
import { useMerchantAgentMoneyOwed } from '@/hooks/useMerchantAgentMoneyOwed';
import { MoneyWeCanUseBreakdown } from '@/components/cfo/MoneyWeCanUseBreakdown';
import { MerchantAgentOwedSheet } from '@/components/cfo/MerchantAgentOwedSheet';

import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Loader2, ArrowDownRight, ArrowUpRight, Scale, Wallet,
  ChevronRight, CalendarDays, Download,
  PiggyBank, BarChart3, Package, ChevronDown,
  Landmark, Vault, CheckCircle2, AlertTriangle, RefreshCw,
} from 'lucide-react';
import {
  ResponsiveContainer, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  Line, ComposedChart,
} from 'recharts';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { KPIBreakdownSheet } from '@/components/cfo/KPIBreakdownSheet';
import { CashSourcesSheet } from '@/components/cfo/CashSourcesSheet';
import { PhoneMoneyStatementSheet, type PhoneMoneyLine } from '@/components/financial-ops/PhoneMoneyStatementSheet';
import mtnLogoAsset from '@/assets/mtn-logo.png.asset.json';
import airtelLogoAsset from '@/assets/airtel-logo.png.asset.json';


import { ReceivablesCardDrilldown } from '@/components/cfo/ReceivablesCardDrilldown';
import { PayablesCardDrilldown } from '@/components/cfo/PayablesCardDrilldown';
import { CFOReceivablesPayablesHome } from '@/components/cfo/CFOReceivablesPayablesHome';
import { WithdrawableCreditsLivePanel } from '@/components/cfo/WithdrawableCreditsLivePanel';
import { MoneyPaidOutCard } from '@/components/cfo/MoneyPaidOutCard';
import { MoneyReceivedCard } from '@/components/cfo/MoneyReceivedCard';
import { HeroCard, PercentageCurve } from '@/components/cfo/HeroCard';



interface CFOOverviewDashboardProps {
  onTabChange?: (tab: string) => void;
  cashPositionOnly?: boolean;
  /** The Cash Position band now lives on its own sidebar page; Home opts out. */
  showCashPosition?: boolean;
}

const fmt = (n: number) =>
  `${n < 0 ? '-' : ''}UGX ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.abs(n))}`;

const fmtShort = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toFixed(0);
};

const fmtShare = (value: number, total: number) => {
  if (total <= 0) return '0% of Money We Have';
  const percentage = (value / total) * 100;
  const formatted = Number.isInteger(percentage) ? percentage.toFixed(0) : percentage.toFixed(1);
  return `${formatted}% of Money We Have`;
};

export function CFOOverviewDashboard({
  onTabChange, cashPositionOnly = false, showCashPosition = true,
}: CFOOverviewDashboardProps) {
  const [exportingCommissions, setExportingCommissions] = useState(false);
  const [activeBreakdown, setActiveBreakdown] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  // Sections default to expanded unless explicitly collapsed above; the chevron toggles.
  const isOpen = (key: string) => openSections[key] !== false;
  const toggleSection = (key: string) =>
    setOpenSections((prev) => ({ ...prev, [key]: prev[key] === false }));
  const { user } = useAuth();
  const {
    platformCash, position, positionError, liabilities, revenue, receivables, moneyFlow,
    todayCashFlow, isLoading
  } = useCFOOverviewData();
  const { data: sevenDayCashFlow } = useCFO7DayCashFlow();
  const { data: actualMoney, isLoading: actualLoading, dataUpdatedAt: actualUpdatedAt } = useActualMoneyHeld();
  const { data: merchantOwed, isLoading: merchantOwedLoading, dataUpdatedAt: owedUpdatedAt } = useMerchantAgentMoneyOwed();
  const [merchantOwedOpen, setMerchantOwedOpen] = useState(false);
  const [actualMoneyLine, setActualMoneyLine] = useState<PhoneMoneyLine | null>(null);
  const [moneyWeHaveOpen, setMoneyWeHaveOpen] = useState(false);
  const queryClient = useQueryClient();
  const [refreshingCashPosition, setRefreshingCashPosition] = useState(false);

  const refreshCashPosition = useCallback(async () => {
    setRefreshingCashPosition(true);
    try {
      await queryClient.invalidateQueries({
        predicate: ({ queryKey }) => {
          const key = String(queryKey[0] ?? '');
          return key.startsWith('cfo-') || key.includes('actual-money') || key.includes('merchant');
        },
      });
      toast.success('Cash position refreshed');
    } finally {
      setRefreshingCashPosition(false);
    }
  }, [queryClient]);


  const handleExportCommissions = useCallback(async () => {
    setExportingCommissions(true);
    try {
      // Fetch all commission records with agent names
      const { data, error } = await supabase
        .from('commission_accrual_ledger')
        .select('id, agent_id, source_type, source_id, amount, status, earned_at, approved_at, paid_at, description, percentage, event_type, commission_role, repayment_amount, rent_request_id')
        .order('earned_at', { ascending: false });

      if (error) throw error;
      if (!data || data.length === 0) {
        toast.info('No commission records found');
        setExportingCommissions(false);
        return;
      }

      // Get unique agent IDs and fetch names
      const agentIds = [...new Set(data.map(r => r.agent_id).filter(Boolean))] as string[];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', agentIds);

      const profileMap = new Map((profiles || []).map(p => [p.id, p]));

      // Build CSV
      const headers = ['Agent Name', 'Phone', 'Amount (UGX)', 'Status', 'Commission Role', 'Event Type', 'Source Type', 'Percentage (%)', 'Repayment Amount', 'Description', 'Earned At', 'Approved At', 'Paid At'];
      const rows = data.map(r => {
        const profile = profileMap.get(r.agent_id || '');
        return [
          profile?.full_name || 'Unknown',
          profile?.phone || '',
          r.amount,
          r.status,
          r.commission_role || '',
          r.event_type || '',
          r.source_type || '',
          r.percentage || '',
          r.repayment_amount || '',
          (r.description || '').replace(/,/g, ';'),
          r.earned_at ? new Date(r.earned_at).toLocaleDateString() : '',
          r.approved_at ? new Date(r.approved_at).toLocaleDateString() : '',
          r.paid_at ? new Date(r.paid_at).toLocaleDateString() : '',
        ].join(',');
      });

      const csv = [headers.join(','), ...rows].join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `agent_commission_report_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${data.length} commission records`);
    } catch (e: any) {
      toast.error(e.message || 'Export failed');
    } finally {
      setExportingCommissions(false);
    }
  }, []);


  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // Cash comes from the Balance Sheet's own statement, so these cards and the
  // Balance Sheet cannot disagree. Bank (A1) and cash held outside the bank
  // (A2 float + A5 in transit) partition the headline exactly.
  const totalCash = position?.totalCash ?? 0;
  const bankCash = position?.bank ?? 0;
  const outsideBankCash = position?.outsideBank ?? 0;
  const positionUnavailable = !!positionError;
  const totalLiabilities = liabilities?.totalLiabilities ?? 0;
  const walletTotal = liabilities?.tenantFunds ?? 0;
  const actualMoneyTotal = actualMoney?.total ?? 0;
  // Money that has already left our provider lines and now sits with merchant
  // agents or on the Bayo Mercy account, taken from the Financial Ops email
  // extractor. The MTN / Airtel balances above already dropped when it moved,
  // so this is shown as owed, never subtracted from "Money We Have" twice.
  const merchantHeld = merchantOwed?.merchantAgentTotal ?? 0;
  const bayoMercyHeld = merchantOwed?.bayoMercyTotal ?? 0;
  // Money We Owe is deliberately only the money sitting with other people:
  // merchant agents and the Bayo Mercy account. Wallets and recorded
  // liabilities keep their own cards elsewhere on this page.
  // The Bayo Mercy balance is the email extractor's running credits-less-debits
  // figure and can dip below zero (more extracted outflow than inflow). A debt
  // cannot be negative, so the headline floors it at 0; the raw figure stays
  // visible in the Money We Owe detail sheet.
  const bayoMercyOwed = Math.max(0, bayoMercyHeld);
  const moneyWeOweTotal = merchantHeld + bayoMercyOwed;
  // Money We Can Use = Money We Have − Money We Owe (money sitting with
  // merchant agents and the Bayo Mercy account), kept within 0..Money We Have
  // so it can never exceed the cash we actually hold.
  const moneyWeCanUse = Math.min(actualMoneyTotal, Math.max(0, actualMoneyTotal - moneyWeOweTotal));
  const netToday = todayCashFlow?.netToday ?? 0;

  


  const liabilityItems = [
    { label: 'Total Wallet Balances', value: liabilities?.tenantFunds ?? 0, icon: <Wallet className="h-4 w-4" /> },
  ];

  /* ── presentation-only derivations (no new data sources) ── */
  const firstName = (() => {
    const raw = (user?.user_metadata as any)?.full_name || user?.email || '';
    const first = String(raw).split(/[\s@.]+/)[0] || '';
    return first ? first.charAt(0).toUpperCase() + first.slice(1) : 'there';
  })();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const todayLabel = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });


  const cashFlowDays = sevenDayCashFlow?.days ?? [];
  const netSevenDayCashFlow = sevenDayCashFlow?.netFlow ?? 0;
  const monthRangeLabel = (() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return `${start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  })();



  return (
    <div className="space-y-6 max-w-7xl mx-auto">

      {/* ══════════════ GREETING HEADER ══════════════ */}
      {!cashPositionOnly && <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
            {greeting}, {firstName} <span aria-hidden>👋</span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Here's what's happening with Welile today.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 h-10 px-4 rounded-lg border border-border bg-card text-xs font-medium shadow-sm">
            <CalendarDays className="h-4 w-4 text-muted-foreground" />
            {todayLabel}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-10 rounded-lg gap-2 text-xs shadow-sm"
            onClick={handleExportCommissions}
            disabled={exportingCommissions}
          >
            {exportingCommissions ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Export
          </Button>
        </div>
      </div>}

      {cashPositionOnly && (
        <div className="flex flex-col gap-4 border-b border-border/70 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-primary">Finance command centre</p>
            <h1 className="font-serif text-3xl font-semibold tracking-normal sm:text-4xl">Cash Position</h1>
            <p className="mt-1 text-sm text-muted-foreground">{greeting}, CFO. Live liquidity, obligations and cash movement.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex h-10 items-center gap-2 rounded-md border border-border bg-card px-3 text-xs font-medium shadow-sm">
              <CalendarDays className="h-4 w-4 text-primary" />
              {monthRangeLabel}
            </div>
            <Button variant="outline" size="sm" className="h-10 rounded-md" onClick={refreshCashPosition} disabled={refreshingCashPosition}>
              <RefreshCw className={refreshingCashPosition ? 'animate-spin' : ''} />
              Refresh
            </Button>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          Main financial surface. Grouped into collapsible bands so the
          page reads top-down: what we hold → what is owed to/by us →
          how it moved → the advances book → lookup tools.
         ══════════════════════════════════════════════════════════════ */}
      <div className="space-y-6">

        {/* ─────────── 1 · CASH POSITION ─────────── */}
        {showCashPosition && <Band
          title="Cash Position"
          subtitle="What we hold right now, and where it sits"
          open={isOpen('position')}
          onToggle={() => toggleSection('position')}
          hideHeader={cashPositionOnly}
        >
          {/* Four across and two down on wide screens; two across on tablets
              and one on phones, because below ~1280px the UGX amounts stop
              fitting on one line inside a quarter of the page. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">

            <Card className="rounded-xl border border-border/70 bg-card shadow-sm transition-shadow hover:shadow-md overflow-hidden h-full min-w-0">
              <CardContent className="p-4 h-full flex flex-col">
                <button
                  type="button"
                  onClick={() => setMoneyWeHaveOpen(true)}
                  className="w-full min-w-0 text-left rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring flex-1 flex flex-col"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="h-9 w-9 rounded-full flex items-center justify-center shrink-0 bg-success text-success-foreground shadow-sm">
                      <PiggyBank className="h-4 w-4" />
                    </div>
                    <span
                      className="flex h-5 w-5 items-center justify-center rounded-full bg-muted/60 shrink-0"
                      aria-hidden
                    >
                      <ChevronRight className="h-3 w-3 text-muted-foreground" />
                    </span>
                  </div>
                  <p className="mt-3 text-[11px] font-semibold text-muted-foreground truncate">Money We Have</p>
                  <p className="mt-1.5 whitespace-nowrap text-[17px] leading-tight sm:text-xl xl:text-[16px] 2xl:text-xl font-bold tabular-nums tracking-normal text-foreground">
                    {actualLoading ? '—' : fmt(actualMoney?.total ?? 0)}
                  </p>
                  <div className="mt-auto pt-2 flex min-h-9 items-end justify-between gap-2">
                    <p className="flex min-w-0 items-center gap-1 text-[11px] font-medium text-success">
                      <ArrowUpRight className="h-3 w-3 shrink-0" />
                      <span>{actualLoading ? '—' : fmtShare(actualMoneyTotal, actualMoneyTotal)}</span>
                    </p>
                    {!actualLoading && <PercentageCurve value={actualMoneyTotal} total={actualMoneyTotal} />}
                  </div>
                </button>

                <Dialog open={moneyWeHaveOpen} onOpenChange={setMoneyWeHaveOpen}>
                  <DialogContent className="max-w-md">
                    <DialogHeader>
                      <DialogTitle className="flex items-center gap-2.5 text-base">
                        <span className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0 bg-emerald-600">
                          <PiggyBank className="h-4 w-4 text-emerald-50" />
                        </span>
                        Money We Have
                      </DialogTitle>
                      <DialogDescription className="text-xs">
                        Real float on provider lines + verified cash + banked deposits
                      </DialogDescription>
                    </DialogHeader>

                    <div className="rounded-xl border border-border bg-muted/30 px-4 py-3">
                      <p className="text-[11px] font-medium text-muted-foreground">Money We Have</p>
                      <p className="mt-1 text-xl sm:text-2xl font-bold tabular-nums tracking-tight text-foreground">
                        {actualLoading ? '—' : fmt(actualMoney?.total ?? 0)}
                      </p>
                      <p className="mt-1 text-[11px] font-medium text-muted-foreground">
                        {actualLoading ? '—' : fmtShare(actualMoneyTotal, actualMoneyTotal)}
                      </p>
                    </div>

                    <div className="space-y-1">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Where it comes from</p>
                      {[
                        { label: 'MTN Money', amount: actualMoney?.mtn ?? 0, logo: mtnLogoAsset.url, line: 'mtn_momo' as const },
                        { label: 'Airtel Money', amount: actualMoney?.airtel ?? 0, logo: airtelLogoAsset.url, line: 'airtel_money' as const },
                        { label: 'Cash at Bank', amount: actualMoney?.bankedCash ?? 0, icon: <Landmark className="h-4 w-4 text-sky-600" />, line: 'banked_cash' as const },
                      ].map((row) => (
                        <button
                          key={row.line}
                          type="button"
                          onClick={() => { setMoneyWeHaveOpen(false); setActualMoneyLine(row.line); }}
                          className="w-full flex items-center justify-between gap-3 py-2 border-b border-border/60 text-xs text-left rounded-md px-1 hover:bg-muted/50 transition-colors"
                        >
                          <span className="flex items-center gap-2 min-w-0 text-muted-foreground">
                            <span className="h-6 w-6 rounded-md shrink-0 border border-border bg-background flex items-center justify-center overflow-hidden">
                              {row.logo ? (
                                <img src={row.logo} alt={row.label} className="w-full h-full object-contain" loading="lazy" />
                              ) : (
                                row.icon
                              )}
                            </span>
                            <span className="truncate">{row.label}</span>
                          </span>
                          <span className="flex items-center gap-1.5 shrink-0">
                            <span className="tabular-nums font-medium text-right text-foreground">
                              {actualLoading ? '—' : fmt(row.amount)}
                            </span>
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                          </span>
                        </button>
                      ))}
                      <div className="mt-2 flex items-center justify-between gap-3 rounded-lg bg-muted/50 px-3 py-2.5">
                        <span className="text-xs font-semibold">Total Money We Have</span>
                        <span className="text-sm font-bold tabular-nums text-foreground">
                          {actualLoading ? '—' : fmt(actualMoney?.total ?? 0)}
                        </span>
                      </div>
                    </div>

                    {!actualLoading && actualMoney && (
                      <button
                        type="button"
                        onClick={() => { setMoneyWeHaveOpen(false); setActualMoneyLine('banked_cash'); }}
                        className={`w-full text-left text-[11px] rounded-lg px-3 py-2 transition-colors ${
                          actualMoney.bankedInSync
                            ? 'text-sky-700 dark:text-sky-400 bg-sky-50/70 dark:bg-sky-950/30 hover:bg-sky-100/70 dark:hover:bg-sky-950/50'
                            : 'text-amber-700 dark:text-amber-400 bg-amber-50/80 dark:bg-amber-950/30 hover:bg-amber-100/80 dark:hover:bg-amber-950/50'
                        }`}
                      >
                        <span className="flex items-center gap-1.5 font-medium">
                          {actualMoney.bankedInSync ? (
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                          ) : (
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                          )}
                          <span className="truncate">
                            {actualMoney.bankedInSync
                              ? 'Cash at Bank matches Financial Ops'
                              : `Cash at Bank differs from Financial Ops by ${fmt(Math.abs(actualMoney.bankedDifference))}`}
                          </span>
                        </span>
                        <span className="mt-0.5 block text-[10px] opacity-90">
                          {actualMoney.finOpsBankedCount} banked deposit(s) checked
                          {actualMoney.bankedComputedAt
                            ? ` · synced ${new Date(actualMoney.bankedComputedAt).toLocaleTimeString('en-GB', {
                                hour: '2-digit',
                                minute: '2-digit',
                                timeZone: 'Africa/Kampala',
                              })} EAT`
                            : ''}
                          {actualMoney.bankedLastMovementAt
                            ? ` · last banked ${new Date(actualMoney.bankedLastMovementAt).toLocaleDateString('en-GB', {
                                day: '2-digit',
                                month: 'short',
                                year: 'numeric',
                                timeZone: 'Africa/Kampala',
                              })}`
                            : ''}
                        </span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => { setMoneyWeHaveOpen(false); setMerchantOwedOpen(true); }}
                      className="w-full text-left text-[11px] text-orange-700 dark:text-orange-400 bg-orange-50/70 dark:bg-orange-950/30 rounded-lg px-3 py-2 hover:bg-orange-100/70 dark:hover:bg-orange-950/50 transition-colors"
                    >
                      {fmt(merchantHeld + bayoMercyHeld)} sits in the merchant float bucket and the Bayo
                      Mercy account — it shows under Money We Owe. Tap for the detail.
                    </button>
                  </DialogContent>
                </Dialog>
              </CardContent>
            </Card>
            <HeroCard
              icon={<Package className="h-4 w-4" />}
              tone="warning"
              title="Money We Owe"
              value={fmt(moneyWeOweTotal)}
              percentageLabel={actualLoading || merchantOwedLoading ? '—' : fmtShare(moneyWeOweTotal, actualMoneyTotal)}
              percentageDirection="down"
              percentageValue={!actualLoading && !merchantOwedLoading ? moneyWeOweTotal : undefined}
              percentageTotal={actualMoneyTotal}
              items={[
                { dot: 'bg-orange-500', label: 'Merchant Float Bucket (held by merchant agents)', value: fmt(merchantHeld), onSelect: () => setMerchantOwedOpen(true) },
              { dot: 'bg-orange-500', label: 'Bayo Mercy Bank Account', value: fmt(bayoMercyOwed), onSelect: () => setMerchantOwedOpen(true) },
              ]}
              onClick={() => setMerchantOwedOpen(true)}
            />
            <HeroCard
              icon={<BarChart3 className="h-4 w-4" />}
              tone="info"
              title="Money We Can Use"
              value={fmt(moneyWeCanUse)}
              percentageLabel={actualLoading || merchantOwedLoading ? '—' : fmtShare(moneyWeCanUse, actualMoneyTotal)}
              percentageDirection="up"
              percentageValue={!actualLoading && !merchantOwedLoading ? moneyWeCanUse : undefined}
              percentageTotal={actualMoneyTotal}
              items={[
                { dot: 'bg-blue-500', label: 'Money We Have', value: fmt(actualMoneyTotal), onSelect: () => setActualMoneyLine('mtn_momo') },
                { dot: 'bg-orange-500', label: 'Less Money We Owe', value: fmt(moneyWeOweTotal), onSelect: () => setMerchantOwedOpen(true) },
                { dot: 'bg-blue-500', label: 'Available for Operations', value: fmt(moneyWeCanUse), onSelect: () => setActiveBreakdown('earnings') },
              ]}
              onClick={() => setActiveBreakdown('earnings')}
            />

          {/* Where that same cash sits, plus what has moved out and in — all
              eight cards share one shell and one grid, so the band reads as a
              single 4 × 2 board rather than two rows of different widths. */}

            {/* Treasury / platform cash shows the REAL money the platform holds
                outside the bank — live MTN and Airtel line balances plus verified
                cash collected but not yet banked — so it partitions the actual
                "Money We Have" headline with the bank card. The A2 / A5 ledger
                positions stay visible as reconciliation lines only: they net
                every historical float and in-transit leg and so read far above
                the cash actually held. */}
            <HeroCard
              icon={<Vault className="h-4 w-4" />}
              tone="primary"
              title="Money in Treasury / Platform"
              value={actualLoading ? '—' : fmt(actualMoney?.outsideBankHeld ?? 0)}
              percentageLabel={actualLoading ? '—' : fmtShare(actualMoney?.outsideBankHeld ?? 0, actualMoneyTotal)}
              percentageDirection="up"
              percentageValue={!actualLoading ? actualMoney?.outsideBankHeld ?? 0 : undefined}
              percentageTotal={actualMoneyTotal}
              items={[
                { dot: 'bg-indigo-500', label: 'MTN Mobile Money line', value: fmt(actualMoney?.mtn ?? 0), onSelect: () => setActualMoneyLine('mtn_momo') },
                { dot: 'bg-indigo-500', label: 'Airtel Money line', value: fmt(actualMoney?.airtel ?? 0), onSelect: () => setActualMoneyLine('airtel_money') },
                { dot: 'bg-indigo-500', label: 'Cash in Custody — Not Yet Confirmed Banked', value: fmt(actualMoney?.custodyNotConfirmedBanked ?? 0), onSelect: () => setActualMoneyLine('cash') },
                { dot: 'bg-slate-400', label: 'Float held by agents (their wallets)', value: fmt(actualMoney?.agentFloatHeld ?? 0), onSelect: () => setActiveBreakdown('cash') },
                { dot: 'bg-slate-400', label: 'Float with Agents (A2, accounting)', value: positionUnavailable ? '—' : fmt(position?.float ?? 0), onSelect: () => setActiveBreakdown('cash') },
                { dot: 'bg-slate-400', label: 'Cash in Custody — Not Yet Confirmed Banked (A5, accounting)', value: positionUnavailable ? '—' : fmt(position?.inTransit ?? 0), onSelect: () => setActiveBreakdown('cash') },
              ]}
              onClick={() => setActiveBreakdown('cash')}
            />
            {/* Money in Bank shows the real banked cash — the same verified
                "Cash at Bank" line that Money We Have counts — rather than the
                A1 accounting balance, which nets every cash movement in the book
                and can read negative even when the bank holds money. The A1
                ledger position stays visible as a reconciliation line. */}
            <HeroCard
              icon={<Landmark className="h-4 w-4" />}
              tone="info"
              title="Money in Bank"
              value={actualLoading ? '—' : fmt(actualMoney?.bankedCash ?? 0)}
              percentageLabel={actualLoading ? '—' : fmtShare(actualMoney?.bankedCash ?? 0, actualMoneyTotal)}
              percentageDirection="up"
              percentageValue={!actualLoading ? actualMoney?.bankedCash ?? 0 : undefined}
              percentageTotal={actualMoneyTotal}
              items={[
                { dot: 'bg-sky-500', label: 'Verified cash banked', value: fmt(actualMoney?.bankedCash ?? 0), onSelect: () => setActualMoneyLine('banked_cash') },
                { dot: 'bg-sky-500', label: 'Bank alerts (reference only)', value: fmt(actualMoney?.bankReconciliation ?? 0), onSelect: () => setActualMoneyLine('banked_cash') },
                { dot: 'bg-slate-400', label: 'Cash and Bank Balances (A1, accounting)', value: positionUnavailable ? '—' : fmt(bankCash), onSelect: () => setActiveBreakdown('cash') },
              ]}
              footer={
                actualMoney && !actualMoney.bankedInSync
                  ? `Financial Ops differs by ${fmt(Math.abs(actualMoney.bankedDifference))} — verify before relying on this figure`
                  : undefined
              }
              footerTone="bg-sky-50/70 dark:bg-sky-950/30 text-sky-700 dark:text-sky-400 italic"
              onClick={() => setActualMoneyLine('banked_cash')}
            />

            <WithdrawableCreditsLivePanel moneyWeHaveTotal={actualMoneyTotal} />
            <MoneyPaidOutCard moneyWeHaveTotal={actualMoneyTotal} />
            <MoneyReceivedCard moneyWeHaveTotal={actualMoneyTotal} />
          </div>

          {/* Transaction-level reconciliation behind Money We Can Use. */}
          <MoneyWeCanUseBreakdown />

        </Band>}

        {/* Cash Movement replaced by the trend / receivables / payables /
            transactions / insights layout (Cash Position page only). */}
        {cashPositionOnly && (
          <CashPositionInsights
            totalReceivables={receivables?.totalReceivables ?? 0}
            receivablesCategories={receivables?.receivablesCategories ?? []}
            moneyWeHave={actualMoneyTotal}
            moneyWeCanUse={moneyWeCanUse}
            moneyWeOwe={moneyWeOweTotal}
            bankReconciled={actualMoney?.bankedInSync}
            onNavigate={onTabChange}
          />
        )}


        {!cashPositionOnly && <>
        {/* ─────────── 2 · RECEIVABLES & PAYABLES ─────────── */}
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Receivables &amp; Payables</h2>
          <p className="text-sm text-muted-foreground">Track what's due, what's been received and what's been paid.</p>
        </div>
        <CFOReceivablesPayablesHome />

        {/* Tools & Audit Trail (receipt lookup, email transactions, transaction
            search, CFO actions log) removed from Home at the CFO's request. */}
        </>}
      </div>

      {/* ── BREAKDOWNS ── */}
      <CashSourcesSheet
        open={activeBreakdown === 'cash'}
        onOpenChange={(o) => !o && setActiveBreakdown(null)}
        totalCash={totalCash}
        a1={platformCash?.a1 ?? 0}
        a5={platformCash?.a5 ?? 0}
        increases={platformCash?.increases ?? []}
        decreases={platformCash?.decreases ?? []}
        positions={platformCash?.positions ?? []}
      />
      <KPIBreakdownSheet
        open={activeBreakdown === 'wallets'}
        onOpenChange={(o) => !o && setActiveBreakdown(null)}
        title="What We Owe — Breakdown"
        total={totalLiabilities}
        items={liabilityItems}
      />
      <KPIBreakdownSheet
        open={activeBreakdown === 'earnings'}
        onOpenChange={(o) => !o && setActiveBreakdown(null)}
        title="Money We Can Use — Breakdown"
        total={moneyWeCanUse}
        items={[
          { label: 'Money We Have (all cash lines)', value: actualMoneyTotal, icon: <ArrowDownRight className="h-4 w-4 text-emerald-500" /> },
          { label: 'Less: merchant float bucket (held by merchant agents)', value: -merchantHeld, icon: <ArrowUpRight className="h-4 w-4 text-destructive" /> },
          { label: 'Less: sent to Bayo Mercy bank account', value: -bayoMercyHeld, icon: <ArrowUpRight className="h-4 w-4 text-destructive" /> },
        ]}
      />
      <KPIBreakdownSheet
        open={activeBreakdown === 'cashIn'}
        onOpenChange={(o) => !o && setActiveBreakdown(null)}
        title="Money In Today"
        total={todayCashFlow?.cashInToday ?? 0}
        items={Object.entries(todayCashFlow?.inflowCategories ?? {}).map(([cat, val]) => ({
          label: cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          value: val,
        }))}
      />
      <KPIBreakdownSheet
        open={activeBreakdown === 'cashOut'}
        onOpenChange={(o) => !o && setActiveBreakdown(null)}
        title="Money Out Today"
        total={todayCashFlow?.cashOutToday ?? 0}
        items={Object.entries(todayCashFlow?.outflowCategories ?? {}).map(([cat, val]) => ({
          label: cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          value: val,
        }))}
      />
      <KPIBreakdownSheet
        open={activeBreakdown === 'netCash'}
        onOpenChange={(o) => !o && setActiveBreakdown(null)}
        title="Net Change Today"
        total={todayCashFlow?.netToday ?? 0}
        totalLabel="Net Change"
        centered
        items={[]}
      />
      <PhoneMoneyStatementSheet
        line={actualMoneyLine}
        onOpenChange={(open) => !open && setActualMoneyLine(null)}
        onSelectLine={(next) => setActualMoneyLine(next)}
      />
      <MerchantAgentOwedSheet open={merchantOwedOpen} onOpenChange={setMerchantOwedOpen} />
      {/* ── FLOATING PAY FAB (mobile only) ── */}
      {!cashPositionOnly && onTabChange && (
        <button
          onClick={() => onTabChange('wallet-payout')}
          className="fixed bottom-6 right-6 z-50 lg:hidden h-14 w-14 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center active:scale-95 transition-transform"
          aria-label="Send Money"
        >
          <Wallet className="h-6 w-6" />
        </button>
      )}
    </div>
  );
}

/* ── Sub-components ── */

function SectionToggle({ open, onToggle, label }: { open: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
      className="text-muted-foreground hover:text-foreground shrink-0"
    >
      <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
  );
}


/**
 * A titled, collapsible band of the overview. Bands give the page a top-down
 * reading order (position → receivables/payables → movement → tools) and let
 * the CFO fold away what they are not looking at.
 */
function Band({ title, subtitle, open, onToggle, children, hideHeader = false }: {
  title: string;
  subtitle?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  hideHeader?: boolean;
}) {
  return (
    <section className="space-y-3">
      {!hideHeader && <div className="flex items-start justify-between gap-3 border-b border-border pb-2">
        <div className="min-w-0">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">{title}</h2>
          {subtitle && <p className="text-[11px] text-muted-foreground/80 mt-0.5">{subtitle}</p>}
        </div>
        <SectionToggle open={open} onToggle={onToggle} label={title} />
      </div>}
      {open && <div className="space-y-4">{children}</div>}
    </section>
  );
}








function FlowRow({ label, value, color, icon, iconBg, onClick }: {
  label: string; value: string; color: string; icon: React.ReactNode; iconBg?: string; onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-4 text-left hover:bg-muted/30 transition-colors"
    >
      <div className={`h-10 w-10 rounded-full flex items-center justify-center shrink-0 ${iconBg || 'bg-muted'} ${color}`}>{icon}</div>
      <p className="flex-1 min-w-0 text-[11px] text-muted-foreground font-medium">{label}</p>
      <p className={`text-base font-bold tabular-nums shrink-0 ${color}`}>{value}</p>
      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
    </button>
  );
}
