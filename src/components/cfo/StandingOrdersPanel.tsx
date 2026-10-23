import { Fragment, useMemo, useState } from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import {
  AlertTriangle, CheckCircle2, Clock, Loader2, RefreshCw, Search,
  ShieldAlert, ShieldQuestion, UserX, Coins, Calendar,
  Copy, PauseCircle, Phone, AlertCircle, X,
  MoreHorizontal, Pencil, FileText, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import { useAuth } from '@/hooks/useAuth';
import { StandingOrderAmountDialog } from './StandingOrderAmountDialog';
import { standingOrderAmountDevelopmentEnabled } from '@/hooks/useStandingOrderAmount';
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
  const { roles } = useAuth();
  const [editingAmount, setEditingAmount] = useState<StandingOrderRow | null>(null);
  // Any account holding CFO or super admin sees the control, whichever role is active in the switcher (CFO accounts
  // also hold Supporter, which is the default active role). standing_order_set_amount still checks cfo/super_admin
  // and staff MFA on every save, and the dialog stays preview-only outside local development.
  const canEditAmount = roles.includes('cfo') || roles.includes('super_admin');
  const [filter, setFilter] = useState<FilterTab>('all');
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

  const [statusFilter, setStatusFilter] = useState<'any' | 'active' | 'paused'>('any');
  const [freqFilter, setFreqFilter] = useState<string>('any');
  const [pageSize, setPageSize] = useState(15);
  const [page, setPage] = useState(1);

  const visibleOrders = useMemo(() => filteredOrders.filter((o) =>
    (statusFilter === 'any' || (statusFilter === 'active' ? o.enabled : !o.enabled)) &&
    (freqFilter === 'any' || o.frequency === freqFilter),
  ), [filteredOrders, statusFilter, freqFilter]);
  const pageCount = Math.max(1, Math.ceil(visibleOrders.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageRows = visibleOrders.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const pills: { key: FilterTab; label: string; count: number; icon: typeof AlertTriangle; active: string; idle: string }[] = [
    { key: 'all', label: 'All Orders', count: counts.total, icon: Coins, active: 'bg-primary text-primary-foreground border-primary', idle: 'text-foreground' },
    { key: 'attention', label: 'Needs Attention', count: counts.attention, icon: AlertTriangle, active: 'bg-destructive text-destructive-foreground border-destructive', idle: 'text-destructive' },
    { key: 'orphaned', label: 'Target Missing', count: counts.orphaned, icon: UserX, active: 'bg-amber-600 text-white border-amber-600', idle: 'text-amber-700 dark:text-amber-400' },
    { key: 'ok', label: 'On Track', count: counts.ok, icon: CheckCircle2, active: 'bg-emerald-600 text-white border-emerald-600', idle: 'text-emerald-700 dark:text-emerald-400' },
    { key: 'paused', label: 'Paused', count: counts.paused, icon: PauseCircle, active: 'bg-muted-foreground text-background border-muted-foreground', idle: 'text-muted-foreground' },
  ];

  const initials = (name: string | null) => (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join('') || '?';

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* Filter pills + Refresh */}
        <div className="flex flex-wrap items-center gap-2">
          {pills.map((p) => {
            const PIcon = p.icon;
            const on = filter === p.key;
            return (
              <button key={p.key} type="button" onClick={() => { setFilter(p.key); setPage(1); }}
                className={cn('flex items-center gap-2 h-10 px-4 rounded-xl border text-sm font-semibold shadow-sm transition-colors',
                  on ? p.active : cn('bg-card border-border hover:bg-muted/50', p.idle))}>
                <PIcon className="h-4 w-4" />
                {p.label}
                <span className="tabular-nums opacity-90">{p.count}</span>
              </button>
            );
          })}
          <Button variant="outline" className="ml-auto h-10 gap-2 border-primary/40 text-primary" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
        </div>

        {/* Search + selects */}
        <div className="flex flex-col md:flex-row gap-2 rounded-xl border border-border bg-card p-2 shadow-sm">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              placeholder="Search by recipient name, phone, UID, or reason..."
              className="pl-9 pr-8 h-10 border-0 shadow-none focus-visible:ring-0" />
            {search && (
              <button type="button" onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v as typeof statusFilter); setPage(1); }}>
            <SelectTrigger className="h-10 md:w-44"><SelectValue placeholder="All Statuses" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">All Statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="paused">Paused</SelectItem>
            </SelectContent>
          </Select>
          <Select value={freqFilter} onValueChange={(v) => { setFreqFilter(v); setPage(1); }}>
            <SelectTrigger className="h-10 md:w-44"><SelectValue placeholder="All Frequencies" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">All Frequencies</SelectItem>
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
              <SelectItem value="interval">Every few days</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filter} onValueChange={(v) => { setFilter(v as FilterTab); setPage(1); }}>
            <SelectTrigger className="h-10 md:w-36 border-primary/50 text-primary"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="attention">Needs Attention</SelectItem>
              <SelectItem value="orphaned">Target Missing</SelectItem>
              <SelectItem value="failing">Failing</SelectItem>
              <SelectItem value="stalled">Overdue</SelectItem>
              <SelectItem value="ok">On Track</SelectItem>
              <SelectItem value="paused">Paused</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-xs text-muted-foreground">Loading standing orders…</p>
            </div>
          ) : !visibleOrders.length ? (
            <div className="p-12 text-center space-y-2">
              <Coins className="h-8 w-8 mx-auto text-muted-foreground" />
              <p className="font-semibold">No standing orders match these filters</p>
              <Button variant="outline" size="sm" onClick={() => { setFilter('all'); setSearch(''); setStatusFilter('any'); setFreqFilter('any'); }}>Clear filters</Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-[11px] uppercase tracking-wider text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="w-10 px-4 py-3"><Checkbox aria-label="Select all" /></th>
                    <th className="text-left font-semibold px-3 py-3">Recipient</th>
                    <th className="text-left font-semibold px-3 py-3">Payout Amount</th>
                    <th className="text-left font-semibold px-3 py-3">Frequency</th>
                    <th className="text-left font-semibold px-3 py-3">Next Scheduled Run</th>
                    <th className="text-left font-semibold px-3 py-3">Last Run</th>
                    <th className="text-left font-semibold px-3 py-3">Status</th>
                    <th className="text-center font-semibold px-3 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row) => {
                    const meta = HEALTH_CONFIG[row.health];
                    const Icon = row.enabled ? meta.icon : PauseCircle;
                    const isErrorExpanded = !!expandedErrors[row.id];
                    return (
                      <Fragment key={row.id}>
                        <tr key={row.id} className={cn('border-b border-border/60 hover:bg-muted/30', !row.enabled && 'opacity-75')}>
                          <td className="px-4 py-3"><Checkbox aria-label="Select order" /></td>
                          <td className="px-3 py-3">
                            <div className="flex items-center gap-3 min-w-[220px]">
                              <div className={cn('h-10 w-10 rounded-full flex items-center justify-center text-sm font-semibold shrink-0',
                                row.target_missing ? 'bg-destructive/15 text-destructive' : 'bg-primary/10 text-primary')}>
                                {row.target_missing ? <UserX className="h-4 w-4" /> : initials(row.target_name)}
                              </div>
                              <div className="min-w-0">
                                <p className={cn('text-xs font-semibold uppercase truncate', row.target_missing && 'text-destructive')}>
                                  {row.target_missing ? 'Deleted / missing account' : row.target_name || 'Unnamed recipient'}
                                </p>
                                {row.target_phone && <p className="text-xs text-muted-foreground">{row.target_phone}</p>}
                                <button type="button" onClick={() => copyToClipboard(row.target_user_id, 'User ID')}
                                  className="text-[11px] text-muted-foreground hover:text-foreground truncate max-w-[180px] block text-left" title={row.target_user_id}>
                                  UID: {row.target_user_id}
                                </button>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap">
                            <p className="font-bold tabular-nums">{formatUGX(row.amount)}</p>
                            {canEditAmount && (
                              <button type="button" onClick={() => setEditingAmount(row)} className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                                <Pencil className="h-3 w-3" /> Change amount
                              </button>
                            )}
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex items-start gap-2 text-xs">
                              <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
                              <span>{describeFrequency(row)}</span>
                            </div>
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex items-start gap-2 text-xs">
                              <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
                              {row.next_run_at ? (
                                <div>
                                  <p>{formatDistanceToNow(new Date(row.next_run_at), { addSuffix: true })}</p>
                                  <p className="text-muted-foreground">{format(new Date(row.next_run_at), 'dd MMM yyyy, HH:mm')}</p>
                                </div>
                              ) : <span className="text-muted-foreground">—</span>}
                            </div>
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex items-start gap-2 text-xs">
                              {row.last_run_at ? (
                                <>
                                  {row.health === 'failing'
                                    ? <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
                                    : <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />}
                                  <div>
                                    <p>{format(new Date(row.last_run_at), 'dd MMM yyyy, HH:mm')}</p>
                                    <p className="text-muted-foreground">{row.health === 'failing' ? 'Failed' : 'Successful'}</p>
                                  </div>
                                </>
                              ) : (
                                <><FileText className="h-4 w-4 text-muted-foreground shrink-0" /><span className="text-muted-foreground">Never executed</span></>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-3">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge variant="outline" className={cn('rounded-full gap-1 whitespace-nowrap', row.enabled ? meta.badgeClass : 'bg-primary/10 text-primary border-primary/30')}>
                                  <Icon className="h-3.5 w-3.5" />
                                  {row.enabled ? meta.label : 'Paused'}
                                  {row.consecutive_failures > 1 && <span className="font-bold">· {row.consecutive_failures}x</span>}
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs text-xs">{meta.description}</TooltipContent>
                            </Tooltip>
                          </td>
                          <td className="px-3 py-3 text-center">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="outline" size="icon" className="h-9 w-9" aria-label="Order actions">
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {canEditAmount && <DropdownMenuItem onClick={() => setEditingAmount(row)}><Pencil className="h-4 w-4 mr-2" />Change amount</DropdownMenuItem>}
                                <DropdownMenuItem disabled={setEnabled.isPending} onClick={() => handleToggle(row, !row.enabled)}>
                                  <PauseCircle className="h-4 w-4 mr-2" />{row.enabled ? 'Pause order' : 'Resume order'}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => copyToClipboard(row.target_user_id, 'User ID')}><Copy className="h-4 w-4 mr-2" />Copy user ID</DropdownMenuItem>
                                {row.target_phone && <DropdownMenuItem onClick={() => copyToClipboard(row.target_phone!, 'Phone number')}><Phone className="h-4 w-4 mr-2" />Copy phone</DropdownMenuItem>}
                                {row.last_run_error && <DropdownMenuItem onClick={() => toggleErrorDetails(row.id)}><AlertTriangle className="h-4 w-4 mr-2" />{isErrorExpanded ? 'Hide error' : 'View error'}</DropdownMenuItem>}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </td>
                        </tr>
                        {(row.target_missing || row.health === 'stalled' || (row.last_run_error && isErrorExpanded)) && (
                          <tr key={`${row.id}-note`} className="border-b border-border/60">
                            <td />
                            <td colSpan={7} className="px-3 pb-3">
                              <div className={cn('rounded-lg border px-3 py-2 text-xs flex flex-wrap items-center gap-2',
                                row.target_missing || row.health === 'failing' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300')}>
                                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                <span className="flex-1">
                                  {row.target_missing ? 'Recipient account no longer exists — this order fails every cycle.'
                                    : row.health === 'stalled' ? 'Overdue by over 36 hours without a run or recorded failure.'
                                    : row.last_run_error}
                                </span>
                                {row.target_missing && row.enabled && (
                                  <Button size="sm" variant="destructive" className="h-7 text-xs" disabled={setEnabled.isPending} onClick={() => handleToggle(row, false)}>Pause now</Button>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Footer / pagination */}
          {!isLoading && visibleOrders.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 text-xs text-muted-foreground">
              <div className="flex items-center gap-3">
                <span>Showing {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, visibleOrders.length)} of {visibleOrders.length} standing orders</span>
                <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setPage(1); }}>
                  <SelectTrigger className="h-8 w-32 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[10, 15, 25, 50].map((n) => <SelectItem key={n} value={String(n)}>{n} per page</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" className="h-8 w-8" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></Button>
                {Array.from({ length: pageCount }, (_, i) => i + 1).slice(Math.max(0, currentPage - 3), Math.max(0, currentPage - 3) + 5).map((n) => (
                  <Button key={n} variant={n === currentPage ? 'default' : 'ghost'} size="icon" className="h-8 w-8 text-xs" onClick={() => setPage(n)}>{n}</Button>
                ))}
                <Button variant="ghost" size="icon" className="h-8 w-8" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></Button>
              </div>
            </div>
          )}
        </div>
      </div>
      {editingAmount && <StandingOrderAmountDialog key={editingAmount.id} order={editingAmount} previewOnly={!standingOrderAmountDevelopmentEnabled()} onClose={() => setEditingAmount(null)} />}
    </TooltipProvider>
  );
}

export default StandingOrdersPanel;
