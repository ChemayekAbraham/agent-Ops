import { useState, useCallback } from 'react';
import { useCFOOverviewData } from '@/hooks/useCFOOverviewData';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import {
  Loader2, ArrowDownRight, ArrowUpRight, Scale, Wallet,
  ChevronRight, Info, CalendarDays, Download,
  PiggyBank, BarChart3, Package, LineChart as LineChartIcon, ChevronDown,
  Landmark, Vault,
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  Line, ComposedChart,
} from 'recharts';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { KPIBreakdownSheet } from '@/components/cfo/KPIBreakdownSheet';
import { CashSourcesSheet } from '@/components/cfo/CashSourcesSheet';
import { ROIPayableForecast } from '@/components/cfo/ROIPayableForecast';
import { CFOActionsLog } from '@/components/cfo/CFOActionsLog';
import { LedgerMaintenancePanel } from '@/components/cfo/LedgerMaintenancePanel';
import { AgentAdvancesStatsCard, AgentAdvancesTrendChart } from '@/components/cfo/AgentAdvancesStatsCard';

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
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const isOpen = (key: string) => openSections[key] === true;
  const toggleSection = (key: string) =>
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  const { user } = useAuth();
  const {
    platformCash, liabilities, revenue, receivables, moneyFlow,
    todayCashFlow, integrityChecks, pendingApprovals, treasuryControls, refetchControls,
    isLoading
  } = useCFOOverviewData();

  const handleToggleControl = useCallback(async (controlKey: string, newValue: boolean) => {
    const { error } = await supabase
      .from('treasury_controls' as any)
      .update({ enabled: newValue, updated_at: new Date().toISOString() } as any)
      .eq('control_key', controlKey);
    if (error) {
      toast.error(`Failed to update ${controlKey}`);
    } else {
      toast.success(`${controlKey.replace(/_/g, ' ')} ${newValue ? 'enabled' : 'disabled'}`);
      refetchControls();
    }
  }, [refetchControls]);

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
  const totalReceivables = receivables?.totalReceivables ?? 0;
  const totalLiabilities = liabilities?.totalLiabilities ?? 0;
  const walletTotal = liabilities?.tenantFunds ?? 0;
  const moneyWeCanUse = Math.max(0, totalCash - walletTotal);
  const netToday = todayCashFlow?.netToday ?? 0;

  /* ── reporting-layer derivations (no new data sources) ── */
  const revenueTotal = revenue?.totalRevenue ?? 0;
  const expenseTotal = revenue?.totalExpenses ?? 0;
  const netProfit = revenue?.netProfit ?? 0;
  const netMargin = revenueTotal > 0 ? (netProfit / revenueTotal) * 100 : 0;

  const netWorkingCapital = totalCash + totalReceivables - totalLiabilities;

  const burn30d = moneyFlow?.totalOutflows ?? 0;
  const dailyBurn = burn30d / 30;

  const advancesIssued = receivables?.advancesPrincipal ?? 0;
  const advancesOutstandingAll = receivables?.advancesOutstandingAll ?? 0;
  const recoveryRate = advancesIssued > 0
    ? ((receivables?.advancesRecovered ?? 0) / advancesIssued) * 100
    : 100;

  const trend = revenue?.trend ?? [];

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


  const trendChartData = trend.map((t) => ({
    label: t.date.slice(5),
    revenue: t.amount,
  }));

  const advancesChartData = [
    { label: 'Issued', disbursed: advancesIssued, recovered: 0 },
    { label: 'Recovered', disbursed: 0, recovered: receivables?.advancesRecovered ?? 0 },
    { label: 'Outstanding', disbursed: advancesOutstandingAll, recovered: 0 },
  ];

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

      {/* Two-column shell: main financial surface on the left, live feeds on the right */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5 items-start">
      <div className="xl:col-span-2 space-y-5">

      {/* ══════════════ THREE HEADLINE CARDS ══════════════ */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <HeroCard
          icon={<PiggyBank className="h-5 w-5 text-emerald-600" />}
          iconBg="bg-emerald-50 dark:bg-emerald-950/40"
          title="Money We Have"
          value={fmt(totalCash)}
          valueColor="text-emerald-600"
          items={[
            { dot: 'bg-emerald-500', label: 'Platform / Treasury Balance', value: fmt(platformCash?.a1 ?? 0) },
            { dot: 'bg-emerald-500', label: 'Cash in Transit (A5)', value: fmt(platformCash?.a5 ?? 0) },
          ]}
          footer="Total available across all accounts"
          footerTone="bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400"
          onClick={() => setActiveBreakdown('cash')}
        />
        <HeroCard
          icon={<Package className="h-5 w-5 text-orange-600" />}
          iconBg="bg-orange-50 dark:bg-orange-950/40"
          title="Money We Owe"
          value={fmt(walletTotal)}
          valueColor="text-orange-600"
          items={[
            { dot: 'bg-orange-500', label: 'Withdrawable User Wallets', value: fmt(walletTotal) },
            { dot: 'bg-orange-500', label: 'All Recorded Liabilities', value: fmt(totalLiabilities) },
          ]}
          footer="Commitments not yet paid out"
          footerTone="bg-orange-50/70 dark:bg-orange-950/30 text-orange-700 dark:text-orange-400"
          onClick={() => setActiveBreakdown('wallets')}
        />
        <HeroCard
          icon={<BarChart3 className="h-5 w-5 text-blue-600" />}
          iconBg="bg-blue-50 dark:bg-blue-950/40"
          title="Money We Can Use"
          value={fmt(moneyWeCanUse)}
          valueColor={moneyWeCanUse >= 0 ? 'text-blue-600' : 'text-destructive'}
          items={[
            { dot: 'bg-blue-500', label: 'Available for Operations', value: fmt(moneyWeCanUse) },
          ]}
          footer="After obligations and restrictions"
          footerTone="bg-blue-50/70 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400"
          onClick={() => setActiveBreakdown('earnings')}
        />
      </div>

      {/* ══════════════ WHERE THE MONEY SITS ══════════════ */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <HeroCard
          icon={<Vault className="h-5 w-5 text-indigo-600" />}
          iconBg="bg-indigo-50 dark:bg-indigo-950/40"
          title="Money in Treasury / Platform"
          value={fmt(treasuryPosition?.value ?? 0)}
          valueColor="text-indigo-600"
          items={[
            { dot: 'bg-indigo-500', label: 'Cash held outside the bank', value: fmt(treasuryPosition?.value ?? 0) },
            { dot: 'bg-indigo-500', label: 'Ledger entries', value: String(treasuryPosition?.count ?? 0) },
          ]}
          footer="Position view — part of Money We Have, not added to it"
          footerTone="bg-indigo-50/70 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-400 italic"
        />
        <HeroCard
          icon={<Landmark className="h-5 w-5 text-sky-600" />}
          iconBg="bg-sky-50 dark:bg-sky-950/40"
          title="Money in Bank"
          value={fmt(bankPosition?.value ?? 0)}
          valueColor="text-sky-600"
          items={[
            { dot: 'bg-sky-500', label: 'Net banked cash', value: fmt(bankPosition?.value ?? 0) },
            { dot: 'bg-sky-500', label: 'Ledger entries', value: String(bankPosition?.count ?? 0) },
          ]}
          footer="Position view — part of Money We Have, not added to it"
          footerTone="bg-sky-50/70 dark:bg-sky-950/30 text-sky-700 dark:text-sky-400 italic"
        />
      </div>


      {/* ══════════════ COMPACT FINANCIAL SUMMARY ══════════════ */}
      <div className="rounded-xl border border-border bg-card p-4 sm:p-5 shadow-sm">
        <h2 className="text-sm font-semibold tracking-tight mb-4">Financial Summary</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <SummaryItem icon={<Wallet className="h-3.5 w-3.5" />} label="Cash Balance" value={fmt(totalCash)} caption="Bank + in transit" />
          <SummaryItem icon={<ArrowUpRight className="h-3.5 w-3.5" />} label="Daily Burn" value={fmt(dailyBurn)} caption="30-day average" valueColor="text-destructive" />
          <SummaryItem icon={<LineChartIcon className="h-3.5 w-3.5" />} label="Revenue" value={fmt(revenueTotal)} caption="Life to date" valueColor="text-emerald-600" />
          <SummaryItem icon={<Package className="h-3.5 w-3.5" />} label="Total Expenses" value={fmt(expenseTotal)} caption="Life to date" valueColor="text-orange-600" />
          <SummaryItem icon={<Scale className="h-3.5 w-3.5" />} label="Net Working Capital" value={fmt(netWorkingCapital)} caption="Cash + receivables − debt" valueColor={netWorkingCapital >= 0 ? undefined : 'text-destructive'} />
          <SummaryItem icon={<PiggyBank className="h-3.5 w-3.5" />} label="Net Result" value={fmt(netProfit)} caption="Revenue − expenses" valueColor={netProfit >= 0 ? 'text-emerald-600' : 'text-destructive'} />
          <SummaryItem icon={<BarChart3 className="h-3.5 w-3.5" />} label="Net Margin" value={`${netMargin.toFixed(1)}%`} caption="Net ÷ revenue" valueColor={netMargin >= 0 ? undefined : 'text-destructive'} />
          <SummaryItem icon={<Landmark className="h-3.5 w-3.5" />} label="Receivables" value={fmt(totalReceivables)} caption="Tenant + advances" valueColor="text-amber-600" />
        </div>
      </div>

      {/* ══════════════ CHARTS ══════════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="rounded-xl shadow-sm">
          <CardContent className="p-4 sm:p-5">
            <div className="flex items-center justify-between gap-2 mb-4">
              <p className="font-semibold text-sm">Revenue — Last 7 Days</p>
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <LineChartIcon className="h-3.5 w-3.5" /> UGX
              </span>
            </div>
            {trendChartData.length > 0 ? (
              <div className="h-[260px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={trendChartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                    <YAxis tickFormatter={(v: number) => fmtShort(v)} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" width={52} />
                    <Tooltip formatter={(v: number) => fmt(v)} contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar name="Revenue (UGX)" dataKey="revenue" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} barSize={22} />
                    <Line name="Trend" type="monotone" dataKey="revenue" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground py-10 text-center">No revenue recorded in the last 7 days.</p>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-xl shadow-sm">
          <CardContent className="p-4 sm:p-5">
            <div className="flex items-center justify-between gap-2 mb-4">
              <p className="font-semibold text-sm">Advances — Disbursed vs Recovered</p>
              <span className="text-[11px] font-semibold text-emerald-600">{recoveryRate.toFixed(0)}% recovered</span>
            </div>
            <AgentAdvancesTrendChart />
          </CardContent>
        </Card>
      </div>

      {/* ── TODAY'S MOVEMENT ── */}
      <Card className="rounded-xl overflow-hidden shadow-sm">
        <CardContent className="p-0">
          <div className="px-5 py-3 flex items-center justify-between gap-3 border-b border-border bg-muted/30">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Today's Money Flow</p>
            <SectionToggle open={isOpen('todayFlow')} onToggle={() => toggleSection('todayFlow')} label="Today's Money Flow" />
          </div>
          {isOpen('todayFlow') && (
          <div className="grid grid-cols-3 divide-x divide-border">
            <FlowCell
              label="Came In"
              value={fmtShort(todayCashFlow?.cashInToday ?? 0)}
              color="text-emerald-600"
              iconBg="bg-emerald-50 dark:bg-emerald-950/40"
              icon={<ArrowDownRight className="h-5 w-5" />}
              onClick={() => setActiveBreakdown('cashIn')}
            />
            <FlowCell
              label="Went Out"
              value={fmtShort(todayCashFlow?.cashOutToday ?? 0)}
              color="text-destructive"
              iconBg="bg-destructive/10"
              icon={<ArrowUpRight className="h-5 w-5" />}
              onClick={() => setActiveBreakdown('cashOut')}
            />
            <FlowCell
              label="Net Change"
              value={`${netToday >= 0 ? '+' : ''}${fmtShort(netToday)}`}
              color={netToday >= 0 ? 'text-primary' : 'text-destructive'}
              iconBg="bg-primary/10"
              icon={<Scale className="h-5 w-5" />}
              onClick={() => setActiveBreakdown('netCash')}
            />
          </div>
          )}
        </CardContent>
      </Card>
      </div>

      {/* ══════════════ RIGHT COLUMN — FEEDS & CONTROLS ══════════════ */}
      <div className="space-y-5">

      {/* ── ROI PAYABLE FORECAST ── */}
      <CollapsibleBlock title="ROI Payable Forecast" open={isOpen('roiForecast')} onToggle={() => toggleSection('roiForecast')}>
        <ROIPayableForecast />
      </CollapsibleBlock>

      {/* ── CFO ACTIONS LOG ── */}
      <CFOActionsLog />

      {/* ── LEDGER MAINTENANCE WINDOW ── */}
      <CollapsibleBlock title="Ledger Maintenance" open={isOpen('ledgerMaintenance')} onToggle={() => toggleSection('ledgerMaintenance')}>
        <LedgerMaintenancePanel />
      </CollapsibleBlock>

      {/* ── SOURCES OF CASH (replaces channel breakdown) ── */}
      <Card className="rounded-xl shadow-sm">
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Where Our Money Comes From</p>
            <SectionToggle open={isOpen('cashSources')} onToggle={() => toggleSection('cashSources')} label="Where Our Money Comes From" />
          </div>
          {isOpen('cashSources') && (
          <>
          <div className="space-y-1.5">
            {(platformCash?.increases ?? []).slice(0, 6).map((item, i) => (
              <div key={i} className="flex items-center justify-between text-xs gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                  <span className="truncate text-foreground">{item.label}</span>
                  <span className="text-muted-foreground shrink-0">({item.count})</span>
                </div>
                <span className="font-mono font-semibold text-emerald-600 shrink-0">+{fmtShort(item.value)}</span>
              </div>
            ))}
          </div>
          {(platformCash?.increases?.length ?? 0) > 6 && (
            <button onClick={() => setActiveBreakdown('cash')} className="text-xs text-primary mt-2 hover:underline">
              View all sources →
            </button>
          )}
          </>
          )}
        </CardContent>
      </Card>

      {/* ── AUTO-PAYOUTS ── */}
      <Card className="rounded-xl shadow-sm">
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Automatic Payments</p>
            <SectionToggle open={isOpen('autoPayments')} onToggle={() => toggleSection('autoPayments')} label="Automatic Payments" />
          </div>
          {isOpen('autoPayments') && (
          <>
          <p className="text-xs text-muted-foreground mb-4">Toggle which payouts happen automatically. Each is checked against available cash first.</p>
          <div className="space-y-3">
            {[
              { key: 'auto_roi', label: 'Investor Returns', desc: 'Pay investors automatically' },
              { key: 'auto_salaries', label: 'Staff Salaries', desc: 'Monthly payroll' },
              { key: 'auto_commissions', label: 'Agent Commissions', desc: 'Agent earnings payouts' },
              { key: 'auto_advances', label: 'Advance Payments', desc: 'Pre-approved advances' },
            ].map((ctrl) => (
              <div key={ctrl.key} className="flex items-center justify-between gap-3 py-2 px-1">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="h-7 w-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                    <Wallet className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0">
                  <p className="text-sm font-medium">{ctrl.label}</p>
                  <p className="text-xs text-muted-foreground">{ctrl.desc}</p>
                  </div>
                </div>
                <Switch
                  checked={treasuryControls?.[ctrl.key] ?? false}
                  onCheckedChange={(val) => handleToggleControl(ctrl.key, val)}
                />
              </div>
            ))}
          </div>
          </>
          )}
        </CardContent>
      </Card>

      {/* ── AGENT ADVANCES — FULL PORTFOLIO STATS & CHART ── */}
      <CollapsibleBlock title="Agent Advances — Full Portfolio" open={isOpen('agentAdvances')} onToggle={() => toggleSection('agentAdvances')}>
        <AgentAdvancesStatsCard />
      </CollapsibleBlock>
      </div>
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
      className="flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-foreground shrink-0"
    >
      {open ? 'Hide' : 'Show'}
      <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
  );
}

function CollapsibleBlock({ title, open, onToggle, children }: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{title}</p>
        <SectionToggle open={open} onToggle={onToggle} label={title} />
      </div>
      {open && children}
    </div>
  );
}

function HeroCard({ icon, iconBg, title, value, valueColor, items, footer, footerTone, onClick }: {
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  value: string;
  valueColor: string;
  items: { dot: string; label: string; value: string }[];
  footer: string;
  footerTone: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <div className="p-4 sm:p-5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className={`h-11 w-11 rounded-xl flex items-center justify-center shrink-0 ${iconBg}`}>{icon}</div>
            <p className="font-semibold text-sm truncate">{title}</p>
          </div>
          {onClick && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
        </div>
        <p className={`mt-3 text-xl sm:text-2xl font-bold tabular-nums tracking-tight ${valueColor}`}>{value}</p>
        <div className="mt-3 pt-3 border-t border-border space-y-1.5">
          {items.map((it) => (
            <div key={it.label} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="flex items-center gap-1.5 min-w-0 text-muted-foreground">
                <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${it.dot}`} />
                <span className="truncate">{it.label}</span>
              </span>
              <span className="tabular-nums font-medium shrink-0 text-right">{it.value}</span>
            </div>
          ))}
        </div>
      </div>
      <div className={`flex items-center justify-between gap-2 px-4 sm:px-5 py-2.5 text-[10px] font-medium ${footerTone}`}>
        <span className="truncate">{footer}</span>
        <Info className="h-3 w-3 shrink-0 opacity-70" />
      </div>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="w-full text-left rounded-xl border border-border bg-card overflow-hidden shadow-sm hover:shadow-md active:scale-[0.995] transition-all"
      >
        {content}
      </button>
    );
  }

  return (
    <div className="w-full rounded-xl border border-border bg-card overflow-hidden shadow-sm">
      {content}
    </div>
  );
}


function SummaryItem({ label, value, caption, valueColor, icon }: {
  label: string; value: string; caption: string; valueColor?: string; icon?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border/70 bg-muted/20 p-3">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <p className="text-[10px] font-medium uppercase tracking-wider leading-tight truncate">{label}</p>
      </div>
      <p className={`text-sm sm:text-base font-bold tabular-nums leading-tight mt-1.5 ${valueColor || ''}`}>{value}</p>
      <p className="text-[10px] text-muted-foreground mt-1 leading-tight">{caption}</p>
    </div>
  );
}

function FlowCell({ label, value, color, icon, iconBg, onClick }: {
  label: string; value: string; color: string; icon: React.ReactNode; iconBg?: string; onClick?: () => void;
}) {
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-2 py-6 px-2 hover:bg-muted/30 transition-colors">
      <div className={`h-12 w-12 rounded-full flex items-center justify-center ${iconBg || 'bg-muted'} ${color}`}>{icon}</div>
      <p className="text-[11px] text-muted-foreground font-medium">{label}</p>
      <p className={`text-2xl font-bold tabular-nums ${color}`}>{value}</p>
    </button>
  );
}
