import { useState, useCallback } from 'react';
import { useCFOOverviewData } from '@/hooks/useCFOOverviewData';
import { useCFO7DayCashFlow } from '@/hooks/useCFO7DayCashFlow';

import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Loader2, ArrowDownRight, ArrowUpRight, Scale, Wallet,
  ChevronRight, Info, CalendarDays, Download,
  PiggyBank, BarChart3, Package, ChevronDown,
  Landmark, Vault,
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

import { CFOActionsLog } from '@/components/cfo/CFOActionsLog';
import { ReceiptNumberLookupPanel } from '@/components/financial-ops/ReceiptNumberLookupPanel';
import { AgentAdvancesStatsCard } from '@/components/cfo/AgentAdvancesStatsCard';
import { ReceivablesCardDrilldown } from '@/components/cfo/ReceivablesCardDrilldown';
import { ServiceCentreReceivablesPanel } from '@/components/cfo/ServiceCentreReceivablesPanel';
import { PayablesCardDrilldown } from '@/components/cfo/PayablesCardDrilldown';



interface CFOOverviewDashboardProps {
  onTabChange?: (tab: string) => void;
}

const fmt = (n: number) =>
  `${n < 0 ? '-' : ''}UGX ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.abs(n))}`;

const fmtShort = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toFixed(0);
};

export function CFOOverviewDashboard({ onTabChange }: CFOOverviewDashboardProps) {
  const [exportingCommissions, setExportingCommissions] = useState(false);
  const [activeBreakdown, setActiveBreakdown] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    // Lookup tools and the audit log start folded away so the numbers stay
    // above the fold; every other band opens by default.
    tools: false,
  });
  // Sections default to expanded unless explicitly collapsed above; the chevron toggles.
  const isOpen = (key: string) => openSections[key] !== false;
  const toggleSection = (key: string) =>
    setOpenSections((prev) => ({ ...prev, [key]: prev[key] === false }));
  const { user } = useAuth();
  const {
    platformCash, liabilities, revenue, receivables, moneyFlow,
    todayCashFlow, isLoading
  } = useCFOOverviewData();
  const { data: sevenDayCashFlow } = useCFO7DayCashFlow();


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

  const totalCash = platformCash?.totalCash ?? 0;
  const treasuryPosition = (platformCash?.positions ?? []).find((p: any) => p.category === 'treasury_platform_cash');
  const bankPosition = (platformCash?.positions ?? []).find((p: any) => p.category === 'bank_cash');
  const totalLiabilities = liabilities?.totalLiabilities ?? 0;
  const walletTotal = liabilities?.tenantFunds ?? 0;
  const moneyWeCanUse = Math.max(0, totalCash - walletTotal);
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



  return (
    <div className="space-y-6 max-w-7xl mx-auto">

      {/* ══════════════ GREETING HEADER ══════════════ */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
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
      </div>

      {/* ══════════════════════════════════════════════════════════════
          Main financial surface. Grouped into collapsible bands so the
          page reads top-down: what we hold → what is owed to/by us →
          how it moved → the advances book → lookup tools.
         ══════════════════════════════════════════════════════════════ */}
      <div className="space-y-6">

        {/* ─────────── 1 · CASH POSITION ─────────── */}
        <Band
          title="Cash Position"
          subtitle="What we hold right now, and where it sits"
          open={isOpen('position')}
          onToggle={() => toggleSection('position')}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <HeroCard
              icon={<PiggyBank className="h-5 w-5 text-emerald-50" />}
              iconBg="bg-emerald-600"
              title="Money We Have"
              value={fmt(totalCash)}
              items={[
                { dot: 'bg-emerald-500', label: 'Platform / Treasury Balance', value: fmt(platformCash?.a1 ?? 0) },
                { dot: 'bg-emerald-500', label: 'Cash in Transit (A5)', value: fmt(platformCash?.a5 ?? 0) },
              ]}
              footer="Total available across all accounts"
              footerTone="bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400"
              onClick={() => setActiveBreakdown('cash')}
            />
            <HeroCard
              icon={<Package className="h-5 w-5 text-orange-50" />}
              iconBg="bg-orange-500"
              title="Money We Owe"
              value={fmt(walletTotal)}
              items={[
                { dot: 'bg-orange-500', label: 'Withdrawable User Wallets', value: fmt(walletTotal) },
                { dot: 'bg-orange-500', label: 'All Recorded Liabilities', value: fmt(totalLiabilities) },
              ]}
              footer="Commitments not yet paid out"
              footerTone="bg-orange-50/70 dark:bg-orange-950/30 text-orange-700 dark:text-orange-400"
              onClick={() => setActiveBreakdown('wallets')}
            />
            <HeroCard
              icon={<BarChart3 className="h-5 w-5 text-blue-50" />}
              iconBg="bg-blue-600"
              title="Money We Can Use"
              value={fmt(moneyWeCanUse)}
              items={[
                { dot: 'bg-blue-500', label: 'Available for Operations', value: fmt(moneyWeCanUse) },
              ]}
              footer="After obligations and restrictions"
              footerTone="bg-blue-50/70 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400"
              onClick={() => setActiveBreakdown('earnings')}
            />
          </div>

          {/* Where that same cash sits — a split of "Money We Have", so it
              belongs directly beneath it rather than further down the page. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <HeroCard
              icon={<Vault className="h-5 w-5 text-indigo-50" />}
              iconBg="bg-indigo-600"
              title="Money in Treasury / Platform"
              value={fmt(treasuryPosition?.value ?? 0)}
              items={[
                { dot: 'bg-indigo-500', label: 'Cash held outside the bank', value: fmt(treasuryPosition?.value ?? 0) },
                { dot: 'bg-indigo-500', label: 'Ledger entries', value: String(treasuryPosition?.count ?? 0) },
              ]}
              footer="Position view — part of Money We Have, not added to it"
              footerTone="bg-indigo-50/70 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-400 italic"
            />
            <HeroCard
              icon={<Landmark className="h-5 w-5 text-sky-50" />}
              iconBg="bg-sky-500"
              title="Money in Bank"
              value={fmt(bankPosition?.value ?? 0)}
              items={[
                { dot: 'bg-sky-500', label: 'Net banked cash', value: fmt(bankPosition?.value ?? 0) },
                { dot: 'bg-sky-500', label: 'Ledger entries', value: String(bankPosition?.count ?? 0) },
              ]}
              footer="Position view — part of Money We Have, not added to it"
              footerTone="bg-sky-50/70 dark:bg-sky-950/30 text-sky-700 dark:text-sky-400 italic"
            />
          </div>
        </Band>

        {/* ─────────── 2 · RECEIVABLES & PAYABLES ─────────── */}
        <Band
          title="Receivables & Payables"
          subtitle="Authoritative open balances across the full book"
          open={isOpen('receivablesPayables')}
          onToggle={() => toggleSection('receivablesPayables')}
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
            <ReceivablesCardDrilldown />
            <PayablesCardDrilldown />
          </div>

          <ServiceCentreReceivablesPanel />
        </Band>

        {/* ─────────── 3 · CASH MOVEMENT ─────────── */}
        <Band
          title="Cash Movement"
          subtitle="Money in and out — today, and across the last 7 days"
          open={isOpen('movement')}
          onToggle={() => toggleSection('movement')}
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
            {/* Today — moved up beside the 7-day chart so both flow views sit
                together instead of being separated by the rest of the page. */}
            <Card className="rounded-2xl shadow-sm h-full flex flex-col">
              <CardContent className="p-4 sm:p-5 flex-1 flex flex-col">
                <div className="flex items-center justify-between gap-2 mb-4 min-h-[24px]">
                  <p className="flex items-center gap-2.5 text-sm font-semibold tracking-tight">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                      <Scale className="h-4 w-4 text-primary" />
                    </span>
                    Today&apos;s Money Flow
                  </p>
                  <span className="text-[11px] text-muted-foreground">{todayLabel}</span>
                </div>
                <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
                  <FlowRow
                    label="Came In"
                    value={fmtShort(todayCashFlow?.cashInToday ?? 0)}
                    color="text-emerald-600"
                    iconBg="bg-emerald-50 dark:bg-emerald-950/40"
                    icon={<ArrowDownRight className="h-5 w-5" />}
                    onClick={() => setActiveBreakdown('cashIn')}
                  />
                  <FlowRow
                    label="Went Out"
                    value={fmtShort(todayCashFlow?.cashOutToday ?? 0)}
                    color="text-destructive"
                    iconBg="bg-destructive/10"
                    icon={<ArrowUpRight className="h-5 w-5" />}
                    onClick={() => setActiveBreakdown('cashOut')}
                  />
                  <FlowRow
                    label="Net Change"
                    value={`${netToday >= 0 ? '+' : ''}${fmtShort(netToday)}`}
                    color={netToday >= 0 ? 'text-primary' : 'text-destructive'}
                    iconBg="bg-primary/10"
                    icon={<Scale className="h-5 w-5" />}
                    onClick={() => setActiveBreakdown('netCash')}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Last 7 days */}
            <Card className="rounded-2xl shadow-sm h-full flex flex-col">
              <CardContent className="p-4 sm:p-5 flex-1 flex flex-col">
                <div className="flex items-center justify-between gap-2 mb-4 min-h-[24px]">
                  <p className="flex items-center gap-2.5 text-sm font-semibold tracking-tight">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 dark:bg-blue-950/40">
                      <BarChart3 className="h-4 w-4 text-blue-600" />
                    </span>
                    <span className="min-w-0">Cash Inflows &amp; Outflows — Last 7 Days</span>
                  </p>
                  <span className="text-[11px] text-muted-foreground shrink-0">UGX</span>
                </div>
                {cashFlowDays.length > 0 && (sevenDayCashFlow?.totalInflow || sevenDayCashFlow?.totalOutflow) ? (
                  <>
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={cashFlowDays} margin={{ top: 4, right: 8, left: 0, bottom: 0 }} barCategoryGap="18%" barGap={2}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                          <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                          <YAxis tickFormatter={(v: number) => fmtShort(v)} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" width={52} />
                          <Tooltip formatter={(v: number) => fmt(v)} contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          <Bar name="Cash In" dataKey="inflow" fill="#10b981" radius={[4, 4, 0, 0]} barSize={24} />
                          <Bar name="Cash Out" dataKey="outflow" fill="#f97316" radius={[4, 4, 0, 0]} barSize={24} />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2">
                      <span className="text-[11px] font-medium text-muted-foreground">Net Cash Flow (7 days)</span>
                      <span
                        className={`text-sm font-semibold tabular-nums ${
                          netSevenDayCashFlow >= 0 ? 'text-emerald-600' : 'text-destructive'
                        }`}
                      >
                        {netSevenDayCashFlow >= 0 ? '+' : '-'}UGX {fmtShort(Math.abs(netSevenDayCashFlow))}
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center gap-2 min-h-[16rem] text-center">
                    <BarChart3 className="h-5 w-5 text-muted-foreground/50" />
                    <p className="text-xs text-muted-foreground">No cash movement recorded in the last 7 days.</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </Band>

        {/* ─────────── 4 · ADVANCES PORTFOLIO ─────────── */}
        <Band
          title="Advances Portfolio"
          subtitle="Agent advances across the full book"
          open={isOpen('advances')}
          onToggle={() => toggleSection('advances')}
        >
          <AgentAdvancesStatsCard />
        </Band>

        {/* ─────────── 5 · TOOLS & AUDIT TRAIL ─────────── */}
        {/* Lookup tools rather than at-a-glance numbers, so this band starts
            collapsed and no longer pushes the flow views below the fold. */}
        <Band
          title="Tools & Audit Trail"
          subtitle="Receipt lookup and the log of CFO actions"
          open={isOpen('tools')}
          onToggle={() => toggleSection('tools')}
        >
          <ReceiptNumberLookupPanel className="rounded-2xl shadow-sm" />
          <CFOActionsLog />
        </Band>
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
          { label: 'Total Cash (Money We Have)', value: totalCash, icon: <ArrowDownRight className="h-4 w-4 text-emerald-500" /> },
          { label: 'User Wallets (Money We Owe)', value: -walletTotal, icon: <ArrowUpRight className="h-4 w-4 text-destructive" /> },
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
        items={[
          { label: 'Money In', value: todayCashFlow?.cashInToday ?? 0, icon: <ArrowDownRight className="h-4 w-4 text-emerald-500" /> },
          { label: 'Money Out', value: -(todayCashFlow?.cashOutToday ?? 0), icon: <ArrowUpRight className="h-4 w-4 text-destructive" /> },
        ]}
      />
      {/* ── FLOATING PAY FAB (mobile only) ── */}
      {onTabChange && (
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
 * reading order (position → movement → receivables/payables → advances →
 * tools) and let the CFO fold away what they are not looking at.
 */
function Band({ title, subtitle, open, onToggle, children }: {
  title: string;
  subtitle?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-3 border-b border-border pb-2">
        <div className="min-w-0">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">{title}</h2>
          {subtitle && <p className="text-[11px] text-muted-foreground/80 mt-0.5">{subtitle}</p>}
        </div>
        <SectionToggle open={open} onToggle={onToggle} label={title} />
      </div>
      {open && <div className="space-y-4">{children}</div>}
    </section>
  );
}


/**
 * Compact financial summary card.
 *
 * The card shows the icon chip, label, the primary amount and one line of
 * essential context. Tapping the card opens a modal with the same breakdown
 * rows and a reconciling total. No figure is derived here: every value is
 * passed in already computed.
 */
function HeroCard({ icon, iconBg, title, value, items, footer, footerTone, onClick }: {
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  value: string;
  items: { dot: string; label: string; value: string }[];
  footer: string;
  footerTone: string;
  onClick?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Colour carries meaning through the icon tile, as in the reference design;
  // the amount stays foreground so the cards read as one set. A negative figure
  // is the one case that still needs to shout, so it keeps the destructive tone.
  const negative = value.trim().startsWith('-');

  return (
    <>
      <div className="w-full rounded-2xl border border-border/70 bg-card shadow-sm transition-shadow hover:shadow-md">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full text-left p-5 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-start justify-between gap-3">
            <div className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ${iconBg}`}>{icon}</div>
            <span
              className="flex h-6 w-6 items-center justify-center rounded-full bg-muted/60 shrink-0"
              aria-hidden
            >
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            </span>
          </div>

          <p className="mt-4 text-[11px] font-medium text-muted-foreground truncate">{title}</p>
          <p
            className={`mt-1.5 text-[26px] leading-none sm:text-3xl sm:leading-none font-bold tabular-nums tracking-tight ${negative ? 'text-destructive' : 'text-foreground'}`}
          >
            {value}
          </p>
          <p className="mt-2.5 text-[11px] text-muted-foreground line-clamp-2">{footer}</p>
        </button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5 text-base">
              <span className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${iconBg}`}>{icon}</span>
              {title}
            </DialogTitle>
            <DialogDescription className="text-xs">{footer}</DialogDescription>
          </DialogHeader>

          <div className="rounded-xl border border-border bg-muted/30 px-4 py-3">
            <p className="text-[11px] font-medium text-muted-foreground">{title}</p>
            <p className={`mt-1 text-2xl font-bold tabular-nums tracking-tight ${negative ? 'text-destructive' : 'text-foreground'}`}>
              {value}
            </p>
          </div>

          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Where it comes from</p>
            {items.map((it) => (
              <div key={it.label} className="flex items-center justify-between gap-3 py-2 border-b border-border/60 text-xs">
                <span className="flex items-center gap-2 min-w-0 text-muted-foreground">
                  <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${it.dot}`} />
                  <span className="truncate">{it.label}</span>
                </span>
                <span className="tabular-nums font-medium shrink-0 text-right text-foreground">{it.value}</span>
              </div>
            ))}
            <div className="mt-2 flex items-center justify-between gap-3 rounded-lg bg-muted/50 px-3 py-2.5">
              <span className="text-xs font-semibold">Total {title}</span>
              <span className={`text-sm font-bold tabular-nums ${negative ? 'text-destructive' : 'text-foreground'}`}>{value}</span>
            </div>
          </div>

          <div className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-[11px] font-medium ${footerTone}`}>
            <span className="truncate">{footer}</span>
            <Info className="h-3 w-3 shrink-0 opacity-70" />
          </div>

          {onClick && (
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-between"
              onClick={() => { setOpen(false); onClick(); }}
            >
              <span>View full breakdown</span>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          )}
        </DialogContent>
      </Dialog>
    </>
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
