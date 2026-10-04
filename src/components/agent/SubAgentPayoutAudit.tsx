import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ShieldCheck,
  Loader2,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Wallet,
  RefreshCw,
  Filter,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format, isWithinInterval, parseISO, startOfDay, endOfDay } from 'date-fns';
import { cn } from '@/lib/utils';

/**
 * Agent payout audit — presentation only.
 *
 * All verification is performed server-side by the Ledger Delivery
 * Verification service (`get_payout_delivery_audit` → `verify_ledger_delivery`).
 * This component performs NO matching of earnings to wallet credits: it does
 * not compare source ids, amounts, timestamps or metadata. It renders the
 * authoritative status returned by the ledger.
 */

type MatchStatus = 'credited' | 'other_scope' | 'pending' | 'failed' | 'not_found' | 'unverified';

interface AuditRow {
  key: string;
  kind: string;
  label: string;
  subAgentName: string | null;
  amount: number;
  occurredAt: string;
  status: MatchStatus;
  verificationStatus: string;
  matchMethod: string | null;
  walletTransactionId: string | null;
  transactionGroupId: string | null;
  walletBucket: string | null;
  ledgerScope: string | null;
  category: string | null;
  creditedAmount: number | null;
  creditedAt: string | null;
  failureReason: string | null;
  processingState: string | null;
  retryStatus: string | null;
}

export function SubAgentPayoutAudit() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Filters
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [subAgentFilter, setSubAgentFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!user) return;
    if (opts?.silent) setRefreshing(true); else setLoading(true);
    setLoadError(null);

    // Single server-side call. The ledger decides delivery status.
    const { data, error } = await supabase.rpc('get_payout_delivery_audit', {
      p_user_id: user.id,
      p_limit: 300,
    });

    if (error) {
      setLoadError(error.message || 'Ledger verification unavailable');
      setRows([]);
    } else {
      setRows(((data as any[]) || []).map((r) => {
        const vs = String(r.verification_status || 'not_found');
        const bucket = r.wallet_bucket as string | null;
        const status: MatchStatus =
          vs === 'credited'
            ? (bucket === 'withdrawable' ? 'credited' : 'other_scope')
            : (vs as MatchStatus);
        return {
          key: String(r.item_key),
          kind: String(r.kind),
          label: String(r.label || r.kind),
          subAgentName: r.counterparty_name || null,
          amount: Number(r.earned_amount || 0),
          occurredAt: r.occurred_at,
          status,
          verificationStatus: vs,
          matchMethod: r.match_method || null,
          walletTransactionId: r.wallet_transaction_id || null,
          transactionGroupId: r.ledger_transaction_group_id || null,
          walletBucket: bucket,
          ledgerScope: r.ledger_scope || null,
          category: r.category || null,
          creditedAmount: r.credited_amount === null || r.credited_amount === undefined ? null : Number(r.credited_amount),
          creditedAt: r.credited_at || null,
          failureReason: r.failure_reason || null,
          processingState: r.processing_state || null,
          retryStatus: r.retry_status || null,
        };
      }));
    }

    setLoading(false);
    setRefreshing(false);
  }, [user]);

  useEffect(() => { load(); }, [load]);

  // Unique filter options
  const subAgentOptions = useMemo(() => {
    const names = Array.from(new Set(rows.map((r) => r.subAgentName).filter(Boolean)));
    return names.sort() as string[];
  }, [rows]);

  const categoryOptions = useMemo(() => {
    const cats = Array.from(new Set(rows.map((r) => r.kind)));
    return cats.sort();
  }, [rows]);

  // Apply filters client-side (instant)
  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      const t = parseISO(r.occurredAt);
      if (dateFrom && !isWithinInterval(t, { start: startOfDay(parseISO(dateFrom)), end: endOfDay(dateTo ? parseISO(dateTo) : new Date(3000, 0, 1)) })) return false;
      if (dateTo && !isWithinInterval(t, { start: startOfDay(dateFrom ? parseISO(dateFrom) : new Date(1970, 0, 1)), end: endOfDay(parseISO(dateTo)) })) return false;
      if (subAgentFilter !== 'all' && r.subAgentName !== subAgentFilter) return false;
      if (categoryFilter !== 'all' && r.kind !== categoryFilter) return false;
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      return true;
    });
  }, [rows, dateFrom, dateTo, subAgentFilter, categoryFilter, statusFilter]);

  const summary = useMemo(() => {
    const total = filteredRows.length;
    const withdrawable = filteredRows.filter((r) => r.status === 'credited').length;
    const otherScope = filteredRows.filter((r) => r.status === 'other_scope').length;
    const pending = filteredRows.filter((r) => r.status === 'pending').length;
    const failed = filteredRows.filter((r) => r.status === 'failed').length;
    const unmatched = filteredRows.filter((r) => r.status === 'not_found').length;
    const earned = filteredRows.reduce((s, r) => s + r.amount, 0);
    const landed = filteredRows
      .filter((r) => r.status === 'credited')
      .reduce((s, r) => s + (r.creditedAmount ?? r.amount), 0);
    return { total, withdrawable, otherScope, pending, failed, unmatched, earned, landed };
  }, [filteredRows]);

  const hasActiveFilters = dateFrom || dateTo || subAgentFilter !== 'all' || categoryFilter !== 'all' || statusFilter !== 'all';

  return (
    <Card id="subagent-audit" className="scroll-mt-28 border-border/60 shadow-none">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-orange-500" />
            Payout Audit
          </CardTitle>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className={cn('h-8 text-xs gap-1.5', hasActiveFilters && 'border-primary/60 text-primary')}
              onClick={() => setShowFilters((s) => !s)}
            >
              <Filter className="h-3.5 w-3.5" />
              Filters
              {hasActiveFilters && <span className="ml-0.5 rounded-full bg-primary text-primary-foreground w-4 h-4 flex items-center justify-center text-[9px]">•</span>}
              {showFilters ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs gap-1.5"
              onClick={() => load({ silent: true })}
              disabled={loading || refreshing}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Every sub-agent earning leg matched to its withdrawable wallet credit.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Filters panel */}
        {showFilters && (
          <div className="rounded-xl border border-border/60 bg-muted/30 p-3 space-y-3">
            {/* Date range */}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-[10px] font-medium text-muted-foreground">From</label>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="w-full h-8 px-2 rounded-md border border-border bg-background text-xs"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-medium text-muted-foreground">To</label>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="w-full h-8 px-2 rounded-md border border-border bg-background text-xs"
                />
              </div>
            </div>

            {/* Sub-agent */}
            {subAgentOptions.length > 0 && (
              <div className="space-y-1">
                <label className="text-[10px] font-medium text-muted-foreground">Sub-agent</label>
                <select
                  value={subAgentFilter}
                  onChange={(e) => setSubAgentFilter(e.target.value)}
                  className="w-full h-8 px-2 rounded-md border border-border bg-background text-xs"
                >
                  <option value="all">All sub-agents</option>
                  {subAgentOptions.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Category & Status */}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-[10px] font-medium text-muted-foreground">Category</label>
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  className="w-full h-8 px-2 rounded-md border border-border bg-background text-xs"
                >
                  <option value="all">All categories</option>
                  {categoryOptions.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-medium text-muted-foreground">Status</label>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="w-full h-8 px-2 rounded-md border border-border bg-background text-xs"
                >
                  <option value="all">All statuses</option>
                  <option value="credited">Credited</option>
                  <option value="other_scope">Wrong scope</option>
                  <option value="pending">Pending</option>
                  <option value="failed">Failed</option>
                  <option value="not_found">Not found</option>
                </select>
              </div>
            </div>

            {hasActiveFilters && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-[10px] w-full"
                onClick={() => {
                  setDateFrom('');
                  setDateTo('');
                  setSubAgentFilter('all');
                  setCategoryFilter('all');
                  setStatusFilter('all');
                }}
              >
                Clear all filters
              </Button>
            )}
          </div>
        )}

        {loadError ? (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
            <p className="text-[11px] font-medium text-amber-600 flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" /> Ledger verification unavailable
            </p>
            <p className="text-[10px] text-muted-foreground mt-1">{loadError}</p>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : filteredRows.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-8">
            {hasActiveFilters
              ? 'No results match the selected filters.'
              : 'No sub-agent earnings yet. Once your team earns, each payout will appear here with its wallet credit.'}
          </p>
        ) : (
          <>
            {/* Summary */}
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-border/60 p-2.5">
                <p className="text-[10px] text-muted-foreground">Earned (legs)</p>
                <p className="text-sm font-bold">{formatUGX(summary.earned)}</p>
                <p className="text-[10px] text-muted-foreground">{summary.total} legs</p>
              </div>
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-2.5">
                <p className="text-[10px] text-muted-foreground">Credited to wallet</p>
                <p className="text-sm font-bold text-emerald-600">{formatUGX(summary.landed)}</p>
                <p className="text-[10px] text-muted-foreground">{summary.withdrawable} verified</p>
              </div>
            </div>
            {(summary.otherScope > 0 || summary.pending > 0 || summary.failed > 0 || summary.unmatched > 0) && (
              <div className="flex flex-wrap gap-2">
                {summary.otherScope > 0 && (
                  <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-600">
                    {summary.otherScope} wrong scope
                  </Badge>
                )}
                {summary.pending > 0 && (
                  <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-600">
                    {summary.pending} pending
                  </Badge>
                )}
                {summary.failed > 0 && (
                  <Badge variant="outline" className="text-[10px] border-destructive/40 text-destructive">
                    {summary.failed} failed
                  </Badge>
                )}
                {summary.unmatched > 0 && (
                  <Badge variant="outline" className="text-[10px] border-destructive/40 text-destructive">
                    {summary.unmatched} not found
                  </Badge>
                )}
              </div>
            )}

            {/* Rows */}
            <div className="space-y-2">
              {filteredRows.map((row) => (
                <AuditRowCard key={row.key} row={row} />
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: MatchStatus }) {
  if (status === 'credited') {
    return (
      <Badge className="text-[10px] gap-1 bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/15 border-0">
        <CheckCircle2 className="h-3 w-3" /> Credited
      </Badge>
    );
  }
  if (status === 'other_scope') {
    return (
      <Badge variant="outline" className="text-[10px] gap-1 border-amber-500/40 text-amber-600">
        <AlertTriangle className="h-3 w-3" /> Wrong scope
      </Badge>
    );
  }
  if (status === 'pending') {
    return (
      <Badge variant="outline" className="text-[10px] gap-1 border-amber-500/40 text-amber-600">
        <Loader2 className="h-3 w-3" /> Pending
      </Badge>
    );
  }
  if (status === 'failed') {
    return (
      <Badge variant="outline" className="text-[10px] gap-1 border-destructive/40 text-destructive">
        <XCircle className="h-3 w-3" /> Failed
      </Badge>
    );
  }
  if (status === 'unverified') {
    return (
      <Badge variant="outline" className="text-[10px] gap-1 border-border text-muted-foreground">
        <AlertTriangle className="h-3 w-3" /> Unverified
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px] gap-1 border-destructive/40 text-destructive">
      <XCircle className="h-3 w-3" /> Not found
    </Badge>
  );
}

function AuditRowCard({ row }: { row: AuditRow }) {
  const credited = row.verificationStatus === 'credited';
  return (
    <div className="rounded-xl border border-border/60 p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold leading-tight truncate">{row.label}</p>
          <p className="text-[10px] text-muted-foreground">
            {row.kind}
            {row.subAgentName ? ` • ${row.subAgentName}` : ''}
          </p>
        </div>
        <StatusBadge status={row.status} />
      </div>

      <div className="flex items-stretch gap-2">
        {/* Earning leg */}
        <div className="flex-1 rounded-lg bg-muted/40 p-2">
          <p className="text-[9px] uppercase tracking-wide text-muted-foreground">Earning leg</p>
          <p className="text-sm font-bold">{formatUGX(row.amount)}</p>
          <p className="text-[10px] text-muted-foreground">
            {format(new Date(row.occurredAt), 'MMM d, yyyy • h:mm a')}
          </p>
        </div>

        <div className="flex items-center text-muted-foreground">
          <ArrowRight className="h-4 w-4" />
        </div>

        {/* Wallet credit */}
        <div className={cn(
          'flex-1 rounded-lg p-2',
          credited ? 'bg-emerald-500/5' : 'bg-destructive/5',
        )}>
          <p className="text-[9px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
            <Wallet className="h-2.5 w-2.5" /> Wallet credit
          </p>
          {credited ? (
            <>
              <p className="text-sm font-bold">{formatUGX(row.creditedAmount ?? row.amount)}</p>
              {row.creditedAt && (
                <p className="text-[10px] text-muted-foreground">
                  {format(new Date(row.creditedAt), 'MMM d, yyyy • h:mm a')}
                </p>
              )}
            </>
          ) : (
            <p className="text-[11px] text-destructive font-medium mt-0.5">
              {row.failureReason || 'Not credited'}
            </p>
          )}
        </div>
      </div>

      {/* Ledger metadata */}
      {credited ? (
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="secondary" className="text-[9px] font-normal">cat: {row.category || '—'}</Badge>
          <Badge variant="secondary" className="text-[9px] font-normal">scope: {row.ledgerScope || '—'}</Badge>
          <Badge variant="secondary" className="text-[9px] font-normal">bucket: {row.walletBucket || '—'}</Badge>
          <Badge variant="secondary" className="text-[9px] font-normal">verified by: {row.matchMethod || '—'}</Badge>
          {row.walletTransactionId && (
            <Badge variant="secondary" className="text-[9px] font-normal">
              txn: {row.walletTransactionId.slice(0, 8)}
            </Badge>
          )}
          {row.transactionGroupId && (
            <Badge variant="secondary" className="text-[9px] font-normal">
              group: {row.transactionGroupId.slice(0, 8)}
            </Badge>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {row.processingState && (
            <Badge variant="secondary" className="text-[9px] font-normal">state: {row.processingState}</Badge>
          )}
          {row.retryStatus && (
            <Badge variant="secondary" className="text-[9px] font-normal">retry: {row.retryStatus.replace(/_/g, ' ')}</Badge>
          )}
        </div>
      )}
    </div>
  );
}