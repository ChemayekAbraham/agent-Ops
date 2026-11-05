import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, LayoutGrid, Users, Handshake, Home, Building2, Package,
  FlaskConical, Search, RefreshCw, ChevronRight, CalendarDays, AlertTriangle,
  CheckCircle2, TrendingUp, Wallet, MapPin, X, ArrowUpRight, Clock,
  ShieldCheck, BarChart3, Activity, Globe
} from 'lucide-react';
import {
  ResponsiveContainer, Tooltip, PieChart, Pie, Cell, ComposedChart, Bar, Line,
  CartesianGrid, XAxis, YAxis
} from 'recharts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import TenantReceivablesDetail from '@/components/executive/TenantReceivablesDetail';
import AgentReceivablesDetail from '@/components/executive/AgentReceivablesDetail';
import ReceivablesProjection from '@/components/cfo/ReceivablesProjection';
import ReceivablesByLocation from '@/components/cfo/ReceivablesByLocation';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { kampalaTodayYmd } from '@/lib/kampalaDays';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useReceivablesBreakdown, useReceivablesPredictiveForecast, useReceivablesForecast,
  useTenantReceivablesByLocation, type ReceivablesForecast, type ReceivableProduct,
} from '@/hooks/useReceivables';

/**
 * CFO Receivables Command Center — Streamlined Executive Workspace.
 * Authoritative read-only presentation backed directly by receivables RPCs.
 */

type SubDef = { key: string; label: string };
type CatDef = { key: string; label: string; icon: typeof Users; color: string; subs: SubDef[] };

const CATS: CatDef[] = [
  {
    key: 'tenant',
    label: 'Tenant Products & Services',
    icon: Home,
    color: 'emerald',
    subs: [
      { key: 'rent_plan', label: 'Rent Access Plans' },
      { key: 'tenant_service_charge', label: 'Tenant Service Charges' },
      { key: 'business_advance', label: 'Business Advances' },
    ],
  },
  {
    key: 'agent',
    label: 'Agent Products & Services',
    icon: Users,
    color: 'blue',
    subs: [
      { key: 'merchandise_recovery', label: 'Merchandise & Smartphone Recovery' },
      { key: 'agent_advance', label: 'Agent Advances' },
      { key: 'agent_advance_access_fee', label: 'Agent Advance Access Fees' },
      { key: 'bike_recovery', label: 'Bike Recoveries' },
      { key: 'credit_access_draw', label: 'Credit Access Draws' },
      { key: 'merchandise_credit_sale', label: 'Merchandise Credit Sales' },
    ],
  },
  {
    key: 'landlord',
    label: 'Landlord Products & Services',
    icon: Building2,
    color: 'amber',
    subs: [
      { key: 'welile_homes', label: 'Welile Homes Subscriptions' },
    ],
  },
  {
    key: 'partner',
    label: 'Partner Products & Services',
    icon: Handshake,
    color: 'purple',
    subs: [
      { key: 'promissory_note', label: 'Promissory Notes' },
    ],
  },
  {
    key: 'other',
    label: 'Unclassified / Other',
    icon: Package,
    color: 'slate',
    subs: [],
  },
  {
    key: 'rnd',
    label: 'R&D',
    icon: FlaskConical,
    color: 'cyan',
    subs: [],
  },
];

const CAT_SUBTITLES: Record<string, string> = {
  tenant: 'tenant portfolio and collection performance',
  agent: 'agent products, operational advances and recoveries',
  landlord: 'landlord subscriptions and property partnerships',
  partner: 'institutional and supporter promissory notes',
  other: 'unclassified receivables and operational charges',
  rnd: 'research and experimental product allocations',
};

const money = (v: number | null | undefined) => (v == null ? '—' : formatUGX(v));

const compact = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
};

const CATEGORY_COLORS: Record<string, { bg: string; text: string; fill: string }> = {
  tenant: { bg: 'bg-emerald-500/10 dark:bg-emerald-500/15', text: 'text-emerald-600 dark:text-emerald-400', fill: '#10b981' },
  agent: { bg: 'bg-blue-500/10 dark:bg-blue-500/15', text: 'text-blue-600 dark:text-blue-400', fill: '#3b82f6' },
  landlord: { bg: 'bg-amber-500/10 dark:bg-amber-500/15', text: 'text-amber-600 dark:text-amber-400', fill: '#f59e0b' },
  partner: { bg: 'bg-purple-500/10 dark:bg-purple-500/15', text: 'text-purple-600 dark:text-purple-400', fill: '#8b5cf6' },
  other: { bg: 'bg-slate-500/10 dark:bg-slate-500/15', text: 'text-slate-600 dark:text-slate-400', fill: '#64748b' },
  rnd: { bg: 'bg-cyan-500/10 dark:bg-cyan-500/15', text: 'text-cyan-600 dark:text-cyan-400', fill: '#06b6d4' },
};

const SLICE_COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#64748b', '#06b6d4'];

export default function ReceivablesOverview() {
  const [search, setSearch] = useState('');
  const [params, setParams] = useSearchParams();
  const requestedCat = params.get('cat') ?? 'overview';
  const catKey = requestedCat === 'agent_lending' ? 'forecast' : requestedCat;
  const isDetailCat = ['tenant', 'agent', 'landlord', 'partner', 'other', 'rnd'].includes(catKey);
  const subParam = params.get('sub');

  const go = (cat: string, sub?: string) => {
    const n = new URLSearchParams();
    if (cat !== 'overview') n.set('cat', cat);
    if (sub) n.set('sub', sub);
    setParams(n, { replace: true });
  };

  const breakdown = useReceivablesBreakdown();
  const live = breakdown.data?.categories ?? [];
  const liveCat = (k: string) => live.find((c) => c.key === k);

  const cats = CATS.map((c) => {
    const lc = liveCat(c.key);
    const extra = (lc?.products ?? []).filter((p) => !c.subs.some((s) => s.key === p.key))
      .map((p) => ({ key: p.key, label: p.label }));
    return { ...c, subs: [...c.subs, ...extra], outstanding: lc?.outstanding ?? 0, count: lc?.item_count ?? 0 };
  });

  const cat = cats.find((c) => c.key === catKey);
  const subKey = cat ? (subParam && cat.subs.some((s) => s.key === subParam) ? subParam : cat.subs[0]?.key) : undefined;
  const sub = cat?.subs.find((s) => s.key === subKey);
  const product = cat && subKey ? liveCat(cat.key)?.products.find((p) => p.key === subKey) : undefined;
  const totalReceivables = breakdown.data?.total ?? 0;
  const totalCount = cats.reduce((sum, c) => sum + c.count, 0);

  // Filter to active categories for the sidebar (or all if searching)
  const activeCats = useMemo(() => {
    return cats.filter((c) => c.outstanding > 0 || c.count > 0 || c.key === catKey);
  }, [cats, catKey]);

  return (
    <main className="receivables-workspace min-h-screen bg-background text-foreground antialiased selection:bg-primary/20">
      {/* Top Header Bar */}
      <header className="border-b border-border/80 bg-card/90 backdrop-blur-md lg:fixed lg:inset-x-0 lg:top-0 lg:z-30 flex h-14 items-center px-4 transition-colors">
        <Link
          to="/cfo/dashboard"
          className="hidden h-full w-[210px] shrink-0 items-center gap-2.5 border-r border-border/80 pr-4 text-sm font-semibold tracking-tight text-foreground hover:text-primary transition-colors lg:flex"
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <TrendingUp className="h-4 w-4" />
          </div>
          <div className="flex flex-col leading-none">
            <span className="font-semibold text-xs tracking-tight">Welile CFO</span>
            <span className="text-[10px] text-muted-foreground font-normal">Receivables Desk</span>
          </div>
        </Link>

        {/* Global Search */}
        <div className="relative mx-4 w-full max-w-md">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            aria-label="Search receivable categories"
            placeholder="Search categories or products…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 rounded-lg bg-muted/40 border-border/60 pl-9 pr-8 text-xs focus-visible:bg-background focus-visible:ring-1 focus-visible:ring-primary/40 transition-all placeholder:text-muted-foreground/70"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2.5 top-2.5 rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Right Header Status Badges */}
        <div className="ml-auto flex items-center gap-2.5">
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[11px] font-medium border border-emerald-500/20">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span>Live Ledger</span>
          </div>
          <Badge variant="outline" className="h-6 px-2 text-[10px] font-semibold uppercase tracking-wider bg-muted/60 text-muted-foreground border-border/80">
            CFO
          </Badge>
        </div>
      </header>

      {/* Main Layout: Fixed Sidebar + Content */}
      <div className="lg:pt-14 grid grid-cols-1 lg:grid-cols-[210px_minmax(0,1fr)]">
        {/* Navigation Sidebar */}
        <nav
          aria-label="Receivable categories"
          className="border-r border-border/80 bg-card px-3 py-4 flex flex-col lg:fixed lg:bottom-0 lg:left-0 lg:top-14 lg:w-[210px] lg:overflow-y-auto space-y-4"
        >
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="h-8 justify-start px-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 rounded-md"
          >
            <Link to="/cfo/dashboard">
              <ArrowLeft className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
              CFO Dashboard
            </Link>
          </Button>

          {/* Section: Overview */}
          <div className="space-y-1">
            <p className="px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Command Center
            </p>
            <SideItem
              active={catKey === 'overview'}
              icon={LayoutGrid}
              label="Overview"
              count={totalCount}
              onClick={() => go('overview')}
            />
          </div>

          {/* Section: Active Categories */}
          <div className="space-y-1">
            <p className="px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Categories
            </p>
            {activeCats.map((c) => (
              <SideItem
                key={c.key}
                active={catKey === c.key}
                icon={c.icon}
                label={c.label}
                count={c.count}
                onClick={() => go(c.key)}
              />
            ))}
          </div>

          <div className="border-t border-border/60 pt-2" />

          {/* Section: Analytics & Tools */}
          <div className="space-y-1">
            <p className="px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Analytics & Deep Dives
            </p>
            <SideItem
              active={catKey === 'forecast'}
              icon={TrendingUp}
              label="Runoff & Projection"
              onClick={() => go('forecast')}
            />
            <SideItem
              active={catKey === 'locations'}
              icon={Globe}
              label="Location Hierarchy"
              onClick={() => go('locations')}
            />
          </div>
        </nav>

        {/* Workspace Canvas */}
        <div className="min-w-0 px-4 py-5 lg:px-6 lg:py-6 lg:col-start-2">
          {/* Breadcrumb Trail */}
          {isDetailCat && cat && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <button
                type="button"
                onClick={() => go('overview')}
                className="hover:text-primary transition-colors font-medium"
              >
                Receivables
              </button>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />
              <button
                type="button"
                onClick={() => go(cat.key)}
                className={`transition-colors ${!sub ? 'text-foreground font-semibold' : 'hover:text-primary font-medium'}`}
              >
                {cat.label}
              </button>
              {sub && (
                <>
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />
                  <span className="text-foreground font-semibold">{sub.label}</span>
                </>
              )}
            </div>
          )}

          {/* Page Header */}
          <header className="mb-5 flex flex-wrap items-start justify-between gap-4 border-b border-border/60 pb-4">
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl lg:text-2xl font-bold tracking-tight text-foreground">
                  {isDetailCat
                    ? cat?.label
                    : catKey === 'forecast'
                    ? 'Receivables Runoff & Projection'
                    : catKey === 'locations'
                    ? 'Receivables Location Hierarchy'
                    : 'Receivables Overview'}
                </h1>
                {isDetailCat && cat && (
                  <Badge variant="secondary" className="text-[11px] font-medium bg-primary/10 text-primary border-primary/20">
                    {cat.count.toLocaleString()} accounts
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground max-w-2xl leading-relaxed">
                {isDetailCat
                  ? `Portfolio breakdown and collection performance for ${CAT_SUBTITLES[catKey] ?? 'these products'}.`
                  : catKey === 'locations'
                  ? 'Geographical distribution and concentration of open receivables across Uganda.'
                  : 'Portfolio health, delinquency exposure, and 7-day collection runoff. Authoritative live position.'}
              </p>
            </div>

            {/* Header Right Actions */}
            <div className="flex items-center gap-3">
              <span className="text-[11px] text-muted-foreground/80 tabular-nums">
                As of <span className="font-medium text-foreground">{breakdown.data?.as_at?.slice(0, 10) ?? '—'}</span> · EAT
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={breakdown.isFetching}
                onClick={() => void breakdown.refetch()}
                className="h-8 gap-1.5 rounded-lg text-xs font-medium border-border/80 hover:bg-muted/80 shadow-xs"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${breakdown.isFetching ? 'animate-spin' : ''}`} />
                <span>Refresh</span>
              </Button>
            </div>
          </header>

          {/* Body Content */}
          <div className="min-w-0 flex flex-col gap-5">
            {catKey === 'forecast' ? (
              <ReceivablesProjection />
            ) : catKey === 'locations' ? (
              <ReceivablesByLocation />
            ) : breakdown.isLoading ? (
              <div className="rounded-xl border border-border/80 bg-card p-12 text-center shadow-xs">
                <RefreshCw className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
                <p className="mt-3 text-sm font-medium text-muted-foreground">Loading authoritative receivables…</p>
              </div>
            ) : breakdown.isError ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center shadow-xs">
                <AlertTriangle className="mx-auto h-6 w-6 text-destructive" />
                <p className="mt-2 text-sm font-semibold text-destructive">Could not load live receivables.</p>
                <p className="mt-1 text-xs text-muted-foreground">Please check your network and refresh.</p>
                <Button variant="outline" size="sm" onClick={() => void breakdown.refetch()} className="mt-4">
                  Retry
                </Button>
              </div>
            ) : !cat ? (
              <Overview
                cats={cats}
                products={(k) => liveCat(k)?.products ?? []}
                onOpen={go}
                total={totalReceivables}
                search={search}
              />
            ) : (
              <>
                {/* Product / Subcategory Tabs */}
                {cat.subs.length === 0 ? (
                  <div className="rounded-xl border border-border/80 bg-card p-10 text-center shadow-xs">
                    <Package className="mx-auto h-8 w-8 text-muted-foreground/50" />
                    <p className="mt-3 text-sm font-medium text-muted-foreground">
                      No active receivable products are recorded under this category yet.
                    </p>
                  </div>
                ) : (
                  <>
                    <div
                      role="tablist"
                      className="inline-flex flex-wrap items-center gap-1.5 rounded-xl border border-border/70 bg-card/60 p-1.5 shadow-2xs backdrop-blur-xs"
                    >
                      {cat.subs.map((s) => {
                        const prod = liveCat(cat.key)?.products.find((p) => p.key === s.key);
                        return (
                          <button
                            key={s.key}
                            type="button"
                            role="tab"
                            aria-selected={s.key === subKey}
                            onClick={() => go(cat.key, s.key)}
                            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-medium transition-all ${
                              s.key === subKey
                                ? 'bg-primary text-primary-foreground shadow-xs'
                                : 'text-muted-foreground hover:text-foreground hover:bg-muted/80'
                            }`}
                          >
                            <span>{s.label}</span>
                            {prod && prod.outstanding > 0 ? (
                              <span
                                className={`rounded-full px-1.5 py-0.2 text-[10px] font-semibold tabular-nums ${
                                  s.key === subKey
                                    ? 'bg-primary-foreground/20 text-primary-foreground'
                                    : 'bg-muted text-muted-foreground'
                                }`}
                              >
                                {compact(prod.outstanding)}
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>

                    {sub && (
                      <SubDetail
                        key={sub.key}
                        catKey={cat.key}
                        label={sub.label}
                        productKey={sub.key}
                        product={product}
                      />
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * Sidebar Navigation Item
 */
function SideItem({
  active,
  icon: Icon,
  label,
  count,
  onClick,
}: {
  active: boolean;
  icon: typeof Users;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`group w-full h-auto justify-start flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs transition-all ${
        active
          ? 'bg-primary/10 text-primary font-medium shadow-2xs ring-1 ring-primary/25'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
      }`}
    >
      <div
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors ${
          active
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted/70 text-muted-foreground group-hover:text-foreground group-hover:bg-muted'
        }`}
      >
        <Icon className="h-3.5 w-3.5" />
      </div>
      <span className="flex-1 min-w-0 truncate font-normal leading-tight group-hover:text-foreground">
        {label}
      </span>
      {count !== undefined && (
        <span
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] tabular-nums font-medium transition-colors ${
            active
              ? 'bg-primary/20 text-primary'
              : 'bg-muted text-muted-foreground group-hover:bg-muted/90'
          }`}
        >
          {count > 9999 ? compact(count) : count.toLocaleString()}
        </span>
      )}
    </button>
  );
}

/**
 * Executive Card Container
 */
function Card({
  title,
  subtitle,
  right,
  className,
  children,
}: {
  title?: string;
  subtitle?: string;
  right?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`rounded-xl border border-border/80 bg-card p-4 shadow-xs transition-all ${className ?? ''}`}>
      {title && (
        <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-2.5">
          <div>
            <h2 className="text-xs font-semibold tracking-tight text-foreground uppercase">{title}</h2>
            {subtitle && <p className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</p>}
          </div>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * Streamlined CFO Receivables Overview
 */
function Overview({
  cats,
  products,
  onOpen,
  total,
  search,
}: {
  cats: (CatDef & { outstanding: number; count: number })[];
  products: (k: string) => ReceivableProduct[];
  onOpen: (c: string, s?: string) => void;
  total: number;
  search: string;
}) {
  const today = kampalaTodayYmd();
  const end = new Date(`${today}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);

  const forecast = useReceivablesPredictiveForecast('day', 7);
  const scheduled = useReceivablesForecast(today, end.toISOString().slice(0, 10));
  const locations = useTenantReceivablesByLocation({ level: 'region' });

  const actual = forecast.data?.actual;
  const items = cats.flatMap((c) => products(c.key).flatMap((p) => p.items));
  const complete = cats.every((c) => products(c.key).every((p) => p.items.length === p.item_count));
  const overdueItems = items.filter((i) => i.due_date && i.due_date.slice(0, 10) < today);

  const overdueFor = (key: string) => {
    const ps = products(key);
    return ps.every((p) => p.items.length === p.item_count)
      ? ps
          .flatMap((p) => p.items)
          .filter((i) => i.due_date && i.due_date.slice(0, 10) < today)
          .reduce((sum, i) => sum + Number(i.amount), 0)
      : undefined;
  };

  const expected =
    forecast.data && forecast.data.periods.every((p) => p.quality !== 'insufficient' && p.quality !== 'low')
      ? forecast.data.periods.reduce((sum, p) => sum + Number(p.runoff_amount), 0)
      : undefined;

  const chart = (forecast.data?.periods ?? []).map((p) => ({
    label: p.label,
    amount: p.quality === 'insufficient' || p.quality === 'low' ? null : Number(p.runoff_amount),
  }));

  let cumulative = 0;
  const chartRows = chart.map((p) => {
    cumulative += p.amount ?? 0;
    return { ...p, cumulative: p.amount === null ? null : cumulative };
  });

  const totalCount = cats.reduce((sum, c) => sum + c.count, 0);
  const topLocations = [...(locations.data?.rows ?? [])]
    .sort((a, b) => b.outstanding - a.outstanding)
    .slice(0, 5);

  const largestOverdue = complete && overdueItems.length ? Math.max(...overdueItems.map((i) => Number(i.amount))) : undefined;
  const longest =
    complete && overdueItems.length
      ? Math.max(
          ...overdueItems.map((i) =>
            Math.floor((Date.parse(today) - Date.parse(i.due_date?.slice(0, 10) ?? today)) / 86400000)
          )
        )
      : undefined;

  // Active categories with balance or items
  const activeCats = useMemo(() => {
    const list = cats.filter((c) => c.outstanding > 0 || c.count > 0);
    if (!search.trim()) return list;
    const term = search.toLowerCase();
    return list.filter((c) => c.label.toLowerCase().includes(term));
  }, [cats, search]);

  const currentPct = total > 0 && actual?.not_yet_due != null ? (actual.not_yet_due / total) * 100 : null;
  const overduePct = total > 0 && actual?.overdue != null ? (actual.overdue / total) * 100 : null;

  return (
    <div className="space-y-5">
      {/* 1. TOP EXECUTIVE METRIC STRIP (4 Focused Cards) */}
      <section aria-label="Receivables summary" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3.5">
        <OverviewMetric
          label="Total Receivables"
          value={money(total)}
          note={`${totalCount.toLocaleString()} active open accounts`}
          icon={Wallet}
          tone="primary"
          badge="Book Value"
        />
        <OverviewMetric
          label="Current Portfolio"
          value={money(actual?.not_yet_due)}
          note={currentPct != null ? `${currentPct.toFixed(1)}% of portfolio · Performing` : 'Not yet due'}
          icon={CheckCircle2}
          tone="success"
          badge="Performing"
        />
        <OverviewMetric
          label="Overdue in Arrears"
          value={money(actual?.overdue)}
          note={overduePct != null ? `${overduePct.toFixed(1)}% delinquency rate` : 'Past contractual date'}
          icon={AlertTriangle}
          tone="destructive"
          badge="At Risk"
        />
        <OverviewMetric
          label="7-Day Expected Inflow"
          value={expected !== undefined ? money(expected) : 'Unavailable'}
          note={`Scheduled target: ${money(scheduled.data?.scheduled_total)}`}
          icon={TrendingUp}
          tone="info"
          badge="Modelled Runoff"
        />
      </section>

      {/* 2. MAIN BALANCED 2-COLUMN EXECUTIVE CANVAS */}
      <div className="grid gap-5 xl:grid-cols-2 [&>*]:min-w-0">
        {/* LEFT COLUMN: Category Exposure & Distribution */}
        <div className="space-y-5">
          {/* Table: Receivables by Category */}
          <Card
            title="Portfolio by Product Category"
            subtitle="Authoritative book value and delinquency across business lines"
            right={
              <span className="text-[11px] text-muted-foreground font-medium">
                {activeCats.length} Active Lines
              </span>
            }
          >
            <div className="overflow-x-auto -mx-4 -mb-4 px-4 pb-4">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/60 text-[11px] text-muted-foreground">
                    <th className="py-2.5 text-left font-medium">Category</th>
                    <th className="py-2.5 text-right font-medium">Accounts</th>
                    <th className="py-2.5 text-right font-medium">Outstanding (UGX)</th>
                    <th className="py-2.5 text-right font-medium">Overdue (UGX)</th>
                    <th className="py-2.5 text-right font-medium">Share</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {activeCats.map((c) => {
                    const sharePct = total > 0 ? (c.outstanding / total) * 100 : 0;
                    const catStyle = CATEGORY_COLORS[c.key] ?? CATEGORY_COLORS.other;
                    const ov = overdueFor(c.key);
                    return (
                      <tr
                        key={c.key}
                        onClick={() => onOpen(c.key)}
                        className="group cursor-pointer hover:bg-muted/40 transition-colors"
                      >
                        <td className="py-3 pr-2">
                          <div className="flex items-center gap-2.5">
                            <span
                              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${catStyle.bg} ${catStyle.text} transition-transform group-hover:scale-105`}
                            >
                              <c.icon className="h-4 w-4" />
                            </span>
                            <span className="font-medium text-foreground group-hover:text-primary transition-colors">
                              {c.label}
                            </span>
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 group-hover:text-primary group-hover:translate-x-0.5 transition-all ml-auto" />
                          </div>
                        </td>
                        <td className="py-3 px-2 text-right tabular-nums text-muted-foreground">
                          {c.count.toLocaleString()}
                        </td>
                        <td className="py-3 px-2 text-right tabular-nums font-semibold text-foreground whitespace-nowrap">
                          {formatUGX(c.outstanding).replace(/^UGX\s*/, '')}
                        </td>
                        <td className="py-3 px-2 text-right tabular-nums whitespace-nowrap">
                          {ov != null && ov > 0 ? (
                            <span className="inline-flex rounded-md bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive">
                              {money(ov).replace(/^UGX\s*/, '')}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </td>
                        <td className="py-3 pl-2 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <span className="tabular-nums font-medium text-muted-foreground text-[11px]">
                              {sharePct.toFixed(1)}%
                            </span>
                            <div className="h-1.5 w-12 rounded-full bg-muted overflow-hidden">
                              <div
                                className="h-full rounded-full transition-all duration-500"
                                style={{ width: `${Math.min(100, Math.max(0, sharePct))}%`, backgroundColor: catStyle.fill }}
                              />
                            </div>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Portfolio Donut Distribution */}
          <Card title="Portfolio Capital Distribution" subtitle="Share of capital deployed by category">
            <div className="flex flex-col sm:flex-row items-center gap-5 pt-1">
              <div className="relative h-40 w-40 shrink-0">
                {total > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={activeCats}
                        dataKey="outstanding"
                        nameKey="label"
                        innerRadius="65%"
                        outerRadius="90%"
                        paddingAngle={2}
                        stroke="hsl(var(--card))"
                        strokeWidth={2}
                      >
                        {activeCats.map((c, i) => (
                          <Cell key={c.key} fill={SLICE_COLORS[i % SLICE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v: number) => formatUGX(v)} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    No active balances
                  </div>
                )}
                {total > 0 && (
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Total</span>
                    <span className="text-base font-bold tabular-nums text-foreground">{compact(total)}</span>
                    <span className="text-[9px] text-muted-foreground">UGX</span>
                  </div>
                )}
              </div>

              {/* Clean Legend */}
              <div className="flex-1 w-full space-y-2">
                {activeCats.map((c, i) => {
                  const pct = total ? (c.outstanding / total) * 100 : 0;
                  return (
                    <div
                      key={c.key}
                      onClick={() => onOpen(c.key)}
                      className="flex items-center justify-between text-xs hover:bg-muted/40 p-1.5 rounded-lg cursor-pointer transition-colors"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="h-2.5 w-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: SLICE_COLORS[i % SLICE_COLORS.length] }}
                        />
                        <span className="truncate text-xs text-muted-foreground">{c.label}</span>
                      </div>
                      <div className="text-right shrink-0 ml-2">
                        <span className="tabular-nums font-semibold text-xs text-foreground mr-2">
                          {formatUGX(c.outstanding)}
                        </span>
                        <span className="tabular-nums text-muted-foreground text-[11px]">
                          ({pct.toFixed(1)}%)
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </Card>
        </div>

        {/* RIGHT COLUMN: 7-Day Inflows & Concentration Risk */}
        <div className="space-y-5">
          {/* 7-Day Receivables Runoff Schedule */}
          <Card
            title="7-Day Collection Runoff"
            subtitle="Modelled empirical recoveries based on past collection velocity"
            right={
              <div className="flex items-center gap-2.5 text-[11px] text-muted-foreground font-medium">
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-xs bg-primary" /> Daily Runoff
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-1.5 w-3 rounded-full bg-emerald-500" /> Cumulative
                </span>
              </div>
            }
          >
            <div className="h-44 w-full rounded-xl bg-muted/20 p-2">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartRows} margin={{ top: 10, right: 6, left: -20, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="2 2" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tickFormatter={compact}
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip formatter={(v: number) => formatUGX(v)} />
                  <Bar
                    dataKey="amount"
                    name="Daily runoff"
                    fill="hsl(var(--primary))"
                    maxBarSize={28}
                    radius={[4, 4, 0, 0]}
                  />
                  <Line
                    dataKey="cumulative"
                    name="Cumulative runoff"
                    stroke="#10b981"
                    strokeWidth={2.5}
                    dot={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2.5 flex items-center justify-between text-[11px] text-muted-foreground">
              <span>Expected 7-Day Total: <strong className="text-foreground">{money(expected)}</strong></span>
              <span className="italic">Excludes unoriginated business</span>
            </div>
          </Card>

          {/* Regional Concentration & Credit Risk */}
          <Card
            title="Concentration & Delinquency Exposure"
            subtitle="Top geographical risk and critical delinquency aging"
            right={
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[10px] text-primary hover:text-primary hover:bg-primary/10"
                onClick={() => onOpen('locations')}
              >
                Full Hierarchy <ChevronRight className="h-3 w-3 ml-0.5" />
              </Button>
            }
          >
            {/* 2 Key Credit Risk Diagnostic Metrics */}
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="p-3 rounded-lg border border-border/70 bg-rose-500/5">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-rose-600 dark:text-rose-400">
                    Largest Overdue Account
                  </span>
                  <AlertTriangle className="h-3.5 w-3.5 text-rose-600 dark:text-rose-400" />
                </div>
                <p className="text-sm font-bold tabular-nums text-foreground">{money(largestOverdue)}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Highest single overdue exposure</p>
              </div>

              <div className="p-3 rounded-lg border border-border/70 bg-amber-500/5">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                    Maximum Aging Duration
                  </span>
                  <Clock className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                </div>
                <p className="text-sm font-bold tabular-nums text-foreground">{longest !== undefined ? `${longest} days` : '—'}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Days beyond contractual maturity</p>
              </div>
            </div>

            {/* Top Regional Exposure List */}
            <div className="space-y-2">
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                Top Regions by Capital Deployed
              </p>
              {topLocations.map((r, i) => {
                const share = total > 0 ? (r.outstanding / total) * 100 : 0;
                return (
                  <div
                    key={r.label}
                    className="flex items-center justify-between text-xs p-2 rounded-lg hover:bg-muted/40 transition-colors"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-semibold text-muted-foreground">
                        {i + 1}
                      </span>
                      <MapPin className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                      <span className="truncate text-xs font-medium text-foreground">{r.label}</span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <div className="text-right">
                        <p className="text-xs font-semibold tabular-nums text-foreground">{formatUGX(r.outstanding)}</p>
                        <p className="text-[10px] text-muted-foreground tabular-nums">{r.tenant_count.toLocaleString()} accounts</p>
                      </div>
                      <div className="h-1.5 w-10 rounded-full bg-muted overflow-hidden hidden sm:block">
                        <div
                          className="h-full rounded-full bg-blue-500"
                          style={{ width: `${Math.min(100, Math.max(0, share))}%` }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
              {!topLocations.length && (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  {locations.isLoading ? 'Loading location exposures…' : 'No location data available.'}
                </p>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/**
 * Metric Card with Executive Polish
 */
function OverviewMetric({
  label,
  value,
  note,
  icon: Icon,
  tone,
  badge,
}: {
  label: string;
  value: string;
  note: string;
  icon: typeof Users;
  tone: 'primary' | 'success' | 'destructive' | 'info';
  badge?: string;
}) {
  const toneMap = {
    primary: {
      border: 'border-border/80 hover:border-primary/40',
      iconBg: 'bg-primary/10 text-primary',
      badge: 'bg-primary/10 text-primary',
    },
    success: {
      border: 'border-border/80 hover:border-emerald-500/40',
      iconBg: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
      badge: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    },
    destructive: {
      border: 'border-border/80 hover:border-rose-500/40',
      iconBg: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
      badge: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
    },
    info: {
      border: 'border-border/80 hover:border-blue-500/40',
      iconBg: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
      badge: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
    },
  };

  const style = toneMap[tone];

  return (
    <div
      className={`min-w-0 rounded-xl border bg-card p-4 shadow-2xs transition-all duration-200 ${style.border}`}
    >
      <div className="mb-2.5 flex items-center justify-between gap-1.5">
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${style.iconBg}`}>
          <Icon className="h-4 w-4" />
        </div>
        {badge && (
          <span className={`rounded-md px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${style.badge}`}>
            {badge}
          </span>
        )}
      </div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
        {label}
      </p>
      <p className="mt-1 text-base lg:text-lg font-bold tabular-nums tracking-tight text-foreground truncate" title={value}>
        {value}
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground/85 truncate">{note}</p>
    </div>
  );
}

/**
 * Subcategory Detail View
 */
function SubDetail({
  catKey,
  label,
  productKey,
  product,
}: {
  catKey: string;
  label: string;
  productKey: string;
  product?: ReceivableProduct;
}) {
  const t = kampalaTodayYmd();
  const items = useMemo(() => product?.items ?? [], [product]);
  const complete = !!product && items.length === product.item_count;
  const overdue = complete ? items.filter((i) => i.due_date && i.due_date < t).reduce((s, i) => s + i.amount, 0) : undefined;
  const current = overdue !== undefined && product ? Math.max(0, product.outstanding - overdue) : undefined;

  const isTenant = catKey === 'tenant';
  const loc = useTenantReceivablesByLocation({ level: 'region', productKey }, isTenant && !!product);

  const fc = useReceivablesPredictiveForecast('day', 7).data;
  const ideal = useQuery({
    queryKey: ['receivables-overview-ideal-7d', fc?.as_at],
    enabled: !!fc,
    staleTime: 5 * 60 * 1000,
    queryFn: async () =>
      Promise.all(
        (fc?.periods ?? []).map(async (p) => {
          const { data, error } = await supabase.rpc('get_receivables_forecast', {
            p_from: p.forecast_from,
            p_to: p.period_end,
          });
          if (error) throw error;
          return data as unknown as ReceivablesForecast;
        })
      ),
  });

  const stream = fc?.streams.find((s) => s.category_key === catKey && s.product_key === productKey);
  const hasBehaviour = !!stream && !stream.insufficient_data;
  const arrearsIdx = (fc?.periods ?? []).findIndex((p) => p.forecast_from <= t);

  const proj = (fc?.periods ?? []).map((p, i) => {
    const raw = ideal.data?.[i]?.products
      .filter((s) => s.product_key === productKey)
      .reduce((a, s) => a + s.scheduled, 0);
    return {
      label: p.label,
      behaviour: hasBehaviour
        ? p.sources
            .filter((s) => s.product_key === productKey && s.basis === 'modelled')
            .reduce((a, s) => a + s.runoff, 0)
        : null,
      ideal: raw == null ? null : i === arrearsIdx && overdue !== undefined ? Math.max(0, raw - overdue) : raw,
    };
  });

  const bTotal = hasBehaviour ? proj.reduce((a, p) => a + (p.behaviour ?? 0), 0) : null;
  const iTotal = ideal.data && (arrearsIdx < 0 || overdue !== undefined) ? proj.reduce((a, p) => a + (p.ideal ?? 0), 0) : null;

  if (!product) {
    return (
      <Card title={label}>
        <p className="text-sm text-muted-foreground py-6 text-center">
          No live outstanding balance is recorded for {label} yet.
        </p>
      </Card>
    );
  }

  if (isTenant) {
    return (
      <TenantReceivablesDetail
        product={product}
        current={current}
        overdue={overdue}
        complete={complete}
        today={t}
        locations={loc.data}
        locationLoading={loc.isLoading}
        locationError={loc.isError}
        forecast={proj}
        behaviourTotal={bTotal}
        idealTotal={iTotal}
        arrears={overdue}
      />
    );
  }

  return (
    <AgentReceivablesDetail
      product={product}
      current={current}
      overdue={overdue}
      complete={complete}
      today={t}
      forecast={proj}
      behaviourTotal={bTotal}
      idealTotal={iTotal}
      arrears={overdue}
    />
  );
}
