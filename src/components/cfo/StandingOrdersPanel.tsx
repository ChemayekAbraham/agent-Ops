import { useMemo, useState } from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import {
  AlertTriangle, CheckCircle2, Clock, Loader2, RefreshCw, Search,
  ShieldAlert, ShieldQuestion, UserX, Coins, Calendar,
  Copy, ChevronDown, ChevronUp, PauseCircle, Phone, AlertCircle, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useStandingOrders, useSetStandingOrderEnabled,
  type StandingOrderRow, type StandingOrderHealth,
} from '@/hooks/useStandingOrders';

type FilterTab = 'attention' | 'all' | 'orphaned' | 'failing' | 'stalled' | 'ok' | 'paused';

const HEALTH_CONFIG: Record<StandingOrderHealth, {
  label: string;
  badgeClass: string;
  cardBorderClass: string;
  icon: typeof AlertTriangle;
  description: string;
}> = {
  orphaned: {
    label: 'Target Missing',
    badgeClass: 'bg-destructive/15 text-destructive border-destructive/30 font-semibold',
    cardBorderClass: 'border-destructive/40 bg-destructive/[0.02]',
    icon: ShieldAlert,
    description: 'Target account was deleted or cannot be found. Retrying daily causes silent leakage/errors.',
  },
  failing: {
    label: 'Execution Failing',
    badgeClass: 'bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/30 font-semibold',
    cardBorderClass: 'border-rose-500/30 bg-rose-500/[0.02]',
    icon: AlertTriangle,
    description: 'Daily automated sweep attempted payout and encountered an error.',
  },
  stalled: {
    label: 'Overdue / Stalled',
    badgeClass: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30 font-semibold',
    cardBorderClass: 'border-amber-500/30 bg-amber-500/[0.02]',
    icon: ShieldQuestion,
    description: 'Enabled and overdue by over 36 hours without a successful run or recorded failure.',
  },
  ok: {
    label: 'On Track',
    badgeClass: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 font-medium',
    cardBorderClass: 'border-border bg-card',
    icon: CheckCircle2,
    description: 'Running normally according to scheduled frequency.',
  },
};

function describeFrequency(row: StandingOrderRow): string {
  switch (row.frequency) {
    case 'daily':
      return 'Daily';
    case 'weekly': {
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      return `Weekly on ${days[row.day_of_week ?? 1]}`;
    }
    case 'interval':
      return `Every ${row.interval_days ?? 1} days`;
    case 'monthly':
    default:
      return `Monthly on day ${row.day_of_month ?? 1}`;
  }
}

export function StandingOrdersPanel() {
  const { data: orders, isLoading, isFetching, refetch } = useStandingOrders();
  const setEnabled = useSetStandingOrderEnabled();
  const [filter, setFilter] = useState<FilterTab>('attention');
  const [search, setSearch] = useState('');
  const [expandedErrors, setExpandedErrors] = useState<Record<string, boolean>>({});

  const counts = useMemo(() => {
    const list = orders ?? [];
    const attention = list.filter((o) => o.health !== 'ok');
    const orphaned = list.filter((o) => o.health === 'orphaned');
    const failing = list.filter((o) => o.health === 'failing');
    const stalled = list.filter((o) => o.health === 'stalled');
    const ok = list.filter((o) => o.health === 'ok');
    const paused = list.filter((o) => !o.enabled);
    const active = list.filter((o) => o.enabled);

    const totalActiveVolume = active.reduce((sum, o) => sum + Number(o.amount || 0), 0);
    const attentionVolume = attention.reduce((sum, o) => sum + Number(o.amount || 0), 0);

    return {
      total: list.length,
      attention: attention.length,
      orphaned: orphaned.length,
      failing: failing.length,
      stalled: stalled.length,
      ok: ok.length,
      paused: paused.length,
      active: active.length,
      totalActiveVolume,
      attentionVolume,
    };
  }, [orders]);

  const filteredOrders = useMemo(() => {
    const list = orders ?? [];
    let result = list;

    // Filter tab
    switch (filter) {
      case 'attention':
        result = list.filter((o) => o.health !== 'ok');
        break;
      case 'orphaned':
        result = list.filter((o) => o.health === 'orphaned');
        break;
      case 'failing':
        result = list.filter((o) => o.health === 'failing');
        break;
      case 'stalled':
        result = list.filter((o) => o.health === 'stalled');
        break;
      case 'ok':
        result = list.filter((o) => o.health === 'ok');
        break;
      case 'paused':
        result = list.filter((o) => !o.enabled);
        break;
      case 'all':
      default:
        result = list;
        break;
    }

    // Search query
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((o) => {
        const name = (o.target_name || '').toLowerCase();
        const phone = (o.target_phone || '').toLowerCase();
        const id = (o.target_user_id || '').toLowerCase();
        const reason = (o.reason || '').toLowerCase();
        const category = (o.category_id || '').toLowerCase();
        const amountStr = String(o.amount || '');
        return (
          name.includes(q) ||
          phone.includes(q) ||
          id.includes(q) ||
          reason.includes(q) ||
          category.includes(q) ||
          amountStr.includes(q)
        );
      });
    }

    return result;
  }, [orders, filter, search]);

  const handleToggle = (order: StandingOrderRow, next: boolean) => {
    setEnabled.mutate(
      { order, enabled: next },
      {
        onSuccess: () => {
          toast.success(next ? `Standing order for ${order.target_name || 'recipient'} resumed` : `Standing order paused`);
        },
        onError: (e: unknown) => {
          toast.error(e instanceof Error ? e.message : 'Failed to update standing order');
        },
      },
    );
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard`);
  };

  const toggleErrorDetails = (id: string) => {
    setExpandedErrors((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* ── Top Metric Summary Strip ── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {/* Total Commitments */}
          <div className="rounded-2xl border border-border bg-card p-4 space-y-1.5 shadow-sm">
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-xs font-semibold uppercase tracking-wider">Total Orders</span>
              <Coins className="h-4 w-4 text-primary" />
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-bold tracking-tight tabular-nums">{counts.total}</span>
              <span className="text-xs text-muted-foreground">({counts.active} active)</span>
            </div>
            <p className="text-[11px] text-muted-foreground font-medium truncate">
              {formatUGX(counts.totalActiveVolume)} / cycle
            </p>
          </div>

          {/* Needs Attention Alert Tile */}
          <div
            onClick={() => setFilter('attention')}
            className={cn(
              'rounded-2xl border p-4 space-y-1.5 cursor-pointer transition-all shadow-sm',
              counts.attention > 0
                ? 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15'
                : 'border-border bg-card hover:bg-muted/40 text-foreground',
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider">Needs Attention</span>
              <AlertTriangle className={cn('h-4 w-4', counts.attention > 0 ? 'text-destructive' : 'text-muted-foreground')} />
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-bold tracking-tight tabular-nums">{counts.attention}</span>
              {counts.attention > 0 && (
                <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-destructive text-destructive-foreground">
                  Action Required
                </span>
              )}
            </div>
            <p className="text-[11px] font-medium truncate opacity-90">
              {counts.attention > 0 ? `${formatUGX(counts.attentionVolume)} at risk` : 'All standing orders healthy'}
            </p>
          </div>

          {/* Orphaned / Target Missing */}
          <div
            onClick={() => setFilter('orphaned')}
            className={cn(
              'rounded-2xl border p-4 space-y-1.5 cursor-pointer transition-all shadow-sm',
              counts.orphaned > 0
                ? 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300 hover:bg-rose-500/15'
                : 'border-border bg-card hover:bg-muted/40 text-foreground',
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider">Target Missing</span>
              <UserX className={cn('h-4 w-4', counts.orphaned > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground')} />
            </div>
            <div className="text-2xl font-bold tracking-tight tabular-nums">{counts.orphaned}</div>
            <p className="text-[11px] font-medium truncate opacity-85">
              {counts.orphaned > 0 ? 'Deleted / unmapped users' : '0 orphaned targets'}
            </p>
          </div>

          {/* Failing Runs */}
          <div
            onClick={() => setFilter('failing')}
            className={cn(
              'rounded-2xl border p-4 space-y-1.5 cursor-pointer transition-all shadow-sm',
              counts.failing > 0
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300 hover:bg-amber-500/15'
                : 'border-border bg-card hover:bg-muted/40 text-foreground',
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider">Failing Sweep</span>
              <AlertCircle className={cn('h-4 w-4', counts.failing > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')} />
            </div>
            <div className="text-2xl font-bold tracking-tight tabular-nums">{counts.failing}</div>
            <p className="text-[11px] font-medium truncate opacity-85">
              {counts.failing > 0 ? 'Failing on daily cron' : '0 execution errors'}
            </p>
          </div>

          {/* Stalled / Overdue */}
          <div
            onClick={() => setFilter('stalled')}
            className={cn(
              'rounded-2xl border p-4 space-y-1.5 cursor-pointer transition-all shadow-sm',
              counts.stalled > 0
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300 hover:bg-amber-500/15'
                : 'border-border bg-card hover:bg-muted/40 text-foreground',
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider">Overdue / Stalled</span>
              <Clock className={cn('h-4 w-4', counts.stalled > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')} />
            </div>
            <div className="text-2xl font-bold tracking-tight tabular-nums">{counts.stalled}</div>
            <p className="text-[11px] font-medium truncate opacity-85">
              {counts.stalled > 0 ? 'Overdue without run' : 'All runs up to date'}
            </p>
          </div>
        </div>

        {/* ── Toolbar: Filter Tabs, Search & Refresh ── */}
        <div className="rounded-2xl border border-border bg-card p-3 space-y-3 shadow-sm">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-2.5">
            {/* Filter Tabs Strip */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0 scrollbar-none">
              <button
                type="button"
                onClick={() => setFilter('attention')}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all shrink-0',
                  filter === 'attention'
                    ? 'bg-destructive text-destructive-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
                )}
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                Needs Attention
                <span className={cn(
                  'ml-0.5 px-1.5 py-0.2 rounded-full text-[10px] font-bold tabular-nums',
                  filter === 'attention' ? 'bg-white/20 text-white' : 'bg-destructive/15 text-destructive',
                )}>
                  {counts.attention}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setFilter('all')}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all shrink-0',
                  filter === 'all'
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
                )}
              >
                All Orders
                <span className="text-[11px] opacity-75 tabular-nums">({counts.total})</span>
              </button>

              {counts.orphaned > 0 && (
                <button
                  type="button"
                  onClick={() => setFilter('orphaned')}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold transition-all shrink-0',
                    filter === 'orphaned'
                      ? 'bg-rose-600 text-white shadow-sm'
                      : 'text-rose-700 dark:text-rose-300 hover:bg-rose-500/10',
                  )}
                >
                  <UserX className="h-3.5 w-3.5" />
                  Target Missing ({counts.orphaned})
                </button>
              )}

              {counts.failing > 0 && (
                <button
                  type="button"
                  onClick={() => setFilter('failing')}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold transition-all shrink-0',
                    filter === 'failing'
                      ? 'bg-amber-600 text-white shadow-sm'
                      : 'text-amber-700 dark:text-amber-300 hover:bg-amber-500/10',
                  )}
                >
                  <AlertCircle className="h-3.5 w-3.5" />
                  Failing ({counts.failing})
                </button>
              )}

              <button
                type="button"
                onClick={() => setFilter('ok')}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold transition-all shrink-0',
                  filter === 'ok'
                    ? 'bg-emerald-600 text-white shadow-sm'
                    : 'text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10',
                )}
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                On Track ({counts.ok})
              </button>

              <button
                type="button"
                onClick={() => setFilter('paused')}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold transition-all shrink-0',
                  filter === 'paused'
                    ? 'bg-secondary text-secondary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
                )}
              >
                <PauseCircle className="h-3.5 w-3.5" />
                Paused ({counts.paused})
              </button>
            </div>

            {/* Refresh Button */}
            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1.5 font-medium"
                onClick={() => refetch()}
                disabled={isFetching}
              >
                {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                <span>Refresh</span>
              </Button>
            </div>
          </div>

          {/* Search Input Bar */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by recipient name, phone (+256...), user ID, reason, or amount..."
              className="pl-9 pr-8 h-9 text-xs bg-muted/30 border-input"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* ── Main Orders Feed / Cards ── */}
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-16 space-y-3">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-xs text-muted-foreground font-medium">Loading standing orders &amp; execution health…</p>
          </div>
        ) : !filteredOrders.length ? (
          <div className="rounded-2xl border border-dashed border-border bg-card p-12 text-center space-y-3">
            {filter === 'attention' ? (
              <>
                <div className="h-12 w-12 rounded-full bg-emerald-500/10 text-emerald-600 flex items-center justify-center mx-auto">
                  <CheckCircle2 className="h-6 w-6" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-base font-bold text-foreground">Zero Standing Orders Need Attention</h3>
                  <p className="text-xs text-muted-foreground max-w-md mx-auto">
                    All recurring automated payouts are either healthy, on track with their target users, or paused.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setFilter('all')}
                  className="text-xs mt-2"
                >
                  View All Standing Orders ({counts.total})
                </Button>
              </>
            ) : (
              <>
                <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mx-auto text-muted-foreground">
                  <Coins className="h-6 w-6" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-base font-bold text-foreground">No Standing Orders Match Filter</h3>
                  <p className="text-xs text-muted-foreground max-w-md mx-auto">
                    {search ? `No results found for "${search}". Try clearing your search query.` : 'There are no standing orders in this category.'}
                  </p>
                </div>
                {search && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSearch('')}
                    className="text-xs mt-2"
                  >
                    Clear Search
                  </Button>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {filteredOrders.map((row) => {
              const meta = HEALTH_CONFIG[row.health];
              const Icon = meta.icon;
              const isErrorExpanded = !!expandedErrors[row.id];

              return (
                <div
                  key={row.id}
                  className={cn(
                    'rounded-2xl border p-4 sm:p-5 transition-all shadow-sm space-y-3',
                    meta.cardBorderClass,
                    !row.enabled && 'opacity-70 bg-muted/20 border-border',
                  )}
                >
                  {/* Row Header: Recipient + Health Badge + Toggle Switch */}
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                    {/* Left: Recipient Information */}
                    <div className="space-y-1 min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {row.target_missing ? (
                          <div className="flex items-center gap-1.5 text-destructive font-bold text-base">
                            <ShieldAlert className="h-5 w-5 shrink-0" />
                            <span>DELETED / MISSING USER ACCOUNT</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-base text-foreground leading-tight truncate">
                              {row.target_name || 'Unnamed Recipient'}
                            </span>
                            {row.target_phone && (
                              <button
                                type="button"
                                onClick={() => copyToClipboard(row.target_phone!, 'Phone number')}
                                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground font-mono bg-muted/60 px-2 py-0.5 rounded-md transition-colors"
                                title="Click to copy phone"
                              >
                                <Phone className="h-3 w-3" />
                                {row.target_phone}
                              </button>
                            )}
                          </div>
                        )}
                      </div>

                      {/* User ID and Category */}
                      <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                        <button
                          type="button"
                          onClick={() => copyToClipboard(row.target_user_id, 'Target User ID')}
                          className="font-mono text-[11px] text-muted-foreground/80 hover:text-foreground bg-muted/40 hover:bg-muted px-1.5 py-0.5 rounded transition-colors inline-flex items-center gap-1"
                          title="Click to copy User UUID"
                        >
                          <span className="truncate max-w-[140px] sm:max-w-[200px]">UID: {row.target_user_id}</span>
                          <Copy className="h-2.5 w-2.5 shrink-0" />
                        </button>
                        <span>•</span>
                        <span className="capitalize font-medium text-foreground/80">
                          {row.category_id.replace(/_/g, ' ')}
                          {row.sub_category ? ` · ${row.sub_category.replace(/_/g, ' ')}` : ''}
                        </span>
                        {row.reason && (
                          <>
                            <span>•</span>
                            <span className="italic text-foreground/70 truncate max-w-[280px]">
                              "{row.reason}"
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Right: Health Status & Active Switch */}
                    <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-border/60">
                      {/* Health Badge with Tooltip */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge variant="outline" className={cn('text-xs px-2.5 py-1 gap-1.5', meta.badgeClass)}>
                            <Icon className="h-3.5 w-3.5 shrink-0" />
                            <span>{meta.label}</span>
                            {row.consecutive_failures > 1 && (
                              <span className="ml-1 px-1.5 py-0.2 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold">
                                {row.consecutive_failures}x
                              </span>
                            )}
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs text-xs">
                          {meta.description}
                        </TooltipContent>
                      </Tooltip>

                      {/* Enable/Disable Toggle Switch with Contextual State Label */}
                      <div className="flex items-center gap-2 pl-2 border-l border-border/60">
                        <div className="flex flex-col items-end text-right">
                          <span className={cn('text-xs font-bold leading-none', row.enabled ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground')}>
                            {row.enabled ? 'Active' : 'Paused'}
                          </span>
                          <span className="text-[10px] text-muted-foreground mt-0.5">
                            {row.enabled ? 'Auto-runs' : 'Manual stop'}
                          </span>
                        </div>
                        <Switch
                          checked={row.enabled}
                          onCheckedChange={(checked) => handleToggle(row, checked)}
                          disabled={setEnabled.isPending}
                          aria-label={`Toggle standing order for ${row.target_name || row.target_user_id}`}
                        />
                      </div>
                    </div>
                  </div>

                  {/* ── Financials, Frequency & Schedule Strip ── */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 p-3 rounded-xl bg-muted/40 border border-border/60 text-xs">
                    {/* Amount */}
                    <div className="space-y-0.5">
                      <span className="text-[10px] uppercase font-semibold text-muted-foreground">Payout Amount</span>
                      <p className="font-bold text-sm sm:text-base text-primary tabular-nums">
                        {formatUGX(row.amount)}
                      </p>
                    </div>

                    {/* Cadence */}
                    <div className="space-y-0.5">
                      <span className="text-[10px] uppercase font-semibold text-muted-foreground">Frequency</span>
                      <p className="font-semibold text-foreground flex items-center gap-1 truncate">
                        <Calendar className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="truncate">{describeFrequency(row)}</span>
                      </p>
                    </div>

                    {/* Next Run */}
                    <div className="space-y-0.5">
                      <span className="text-[10px] uppercase font-semibold text-muted-foreground">Next Scheduled Run</span>
                      {row.next_run_at ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <p className="font-medium text-foreground tabular-nums cursor-help truncate">
                              {formatDistanceToNow(new Date(row.next_run_at), { addSuffix: true })}
                            </p>
                          </TooltipTrigger>
                          <TooltipContent className="text-xs">
                            {format(new Date(row.next_run_at), 'EEEE, MMMM d, yyyy · HH:mm:ss')}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <p className="text-muted-foreground font-medium">—</p>
                      )}
                    </div>

                    {/* Last Run Status */}
                    <div className="space-y-0.5">
                      <span className="text-[10px] uppercase font-semibold text-muted-foreground">Last Run</span>
                      {row.last_run_at ? (
                        <p className="font-medium text-foreground tabular-nums truncate">
                          {formatDistanceToNow(new Date(row.last_run_at), { addSuffix: true })}
                        </p>
                      ) : (
                        <p className="text-muted-foreground font-medium">Never executed</p>
                      )}
                    </div>
                  </div>

                  {/* ── High-Priority Incident Callout / Leak Warning ── */}
                  {row.target_missing && (
                    <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 space-y-1.5 text-xs text-destructive">
                      <div className="flex items-center gap-2 font-bold">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        <span>Silent Leak Risk: Target User Profile Missing in Database</span>
                      </div>
                      <p className="leading-relaxed opacity-90 text-[11px]">
                        The account for target user <code className="bg-destructive/20 px-1 py-0.5 rounded font-mono font-bold">{row.target_user_id}</code> was deleted or no longer exists.
                        The daily automated job is attempting this payout every cycle and throwing unhandled exceptions.
                      </p>
                      <div className="flex items-center gap-2 pt-1">
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-7 text-xs font-semibold gap-1"
                          onClick={() => handleToggle(row, false)}
                          disabled={!row.enabled || setEnabled.isPending}
                        >
                          <PauseCircle className="h-3.5 w-3.5" />
                          {row.enabled ? 'Pause this Standing Order Now' : 'Already Paused'}
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* ── Failure Details Banner ── */}
                  {row.health === 'failing' && (
                    <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 space-y-1 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 font-bold text-rose-700 dark:text-rose-300">
                          <AlertTriangle className="h-4 w-4 shrink-0" />
                          <span>Latest Run Failed ({row.consecutive_failures} consecutive failure{row.consecutive_failures === 1 ? '' : 's'})</span>
                        </div>
                        {row.last_run_error && (
                          <button
                            type="button"
                            onClick={() => toggleErrorDetails(row.id)}
                            className="text-[11px] font-semibold text-rose-700 dark:text-rose-300 hover:underline inline-flex items-center gap-0.5"
                          >
                            {isErrorExpanded ? 'Hide raw error' : 'View raw error'}
                            {isErrorExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                          </button>
                        )}
                      </div>
                      {row.last_run_error && isErrorExpanded && (
                        <div className="mt-2 p-2 rounded-lg bg-background/80 border border-rose-500/30 font-mono text-[11px] text-rose-800 dark:text-rose-300 whitespace-pre-wrap break-all">
                          {row.last_run_error}
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── Stalled Warning Banner ── */}
                  {row.health === 'stalled' && (
                    <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 space-y-1 text-xs text-amber-800 dark:text-amber-300">
                      <div className="flex items-center gap-1.5 font-bold">
                        <Clock className="h-4 w-4 shrink-0" />
                        <span>Execution Stalled / Overdue</span>
                      </div>
                      <p className="leading-relaxed text-[11px] opacity-90">
                        This order is marked active but its scheduled execution time has passed by over 36 hours without executing or recording a failure in the sweep logs.
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}

export default StandingOrdersPanel;
