import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ExpandableTable, type ExpandableColumn } from '@/components/ui/expandable-table';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { Search, Loader2, X, Receipt, Banknote, CheckCircle2, XCircle, Users } from 'lucide-react';
import { PageHeader, StatTile, Pager } from './FinopsKit';
import { UserDrilldownDrawer } from '@/components/ops/UserDrilldownDrawer';

interface Row {
  withdrawal_id: string;
  user_id: string;
  user_name: string | null;
  user_phone: string | null;
  amount: number;
  status: string;
  payout_method: string | null;
  transaction_id: string | null;
  mobile_money_number: string | null;
  mobile_money_provider: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  created_at: string;
  processed_at: string | null;
  balance_before: number;
  balance_after: number;
  total_count: number;
}

const PAGE_SIZE = 50;

const STATUS_TONE: Record<string, string> = {
  completed: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30',
  approved: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30',
  paid: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30',
  fin_ops_approved: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30',
  pending: 'bg-amber-500/10 text-amber-700 border-amber-500/30',
  manager_approved: 'bg-amber-500/10 text-amber-700 border-amber-500/30',
  cfo_approved: 'bg-amber-500/10 text-amber-700 border-amber-500/30',
  coo_approved: 'bg-amber-500/10 text-amber-700 border-amber-500/30',
  rejected: 'bg-destructive/10 text-destructive border-destructive/30',
  cancelled: 'bg-muted text-muted-foreground border-border',
  failed: 'bg-destructive/10 text-destructive border-destructive/30',
};

export function WithdrawalHistoryStatement() {
  const [search, setSearch] = useState('');
  const [committed, setCommitted] = useState('');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [drillUserId, setDrillUserId] = useState<string | null>(null);

  const columns: ExpandableColumn<Row>[] = useMemo(() => [
    {
      key: 'datetime',
      header: 'Date / Time',
      primary: true,
      cell: (r) => {
        const ts = r.processed_at || r.created_at;
        return (
          <div className="whitespace-nowrap">
            <span className="font-medium tabular-nums">{format(new Date(ts), 'MMM d, yyyy')}</span>
            <span className="text-[10px] text-muted-foreground tabular-nums ml-1.5">{format(new Date(ts), 'HH:mm:ss')}</span>
          </div>
        );
      },
    },
    {
      key: 'user',
      header: 'User',
      primary: true,
      cell: (r) => (
        <div>
          {r.user_id ? (
            <button
              type="button"
              onClick={() => setDrillUserId(r.user_id)}
              className="font-medium truncate max-w-[200px] text-primary hover:underline text-left"
              title="Open profile, wallet & transfers"
            >
              {r.user_name || 'View user'}
            </button>
          ) : (
            <span className="font-medium truncate max-w-[200px] inline-block">{r.user_name || '—'}</span>
          )}
          <div className="text-[10px] text-muted-foreground tabular-nums">{r.user_phone || '—'}</div>
        </div>
      ),
    },
    {
      key: 'channel',
      header: 'Channel',
      cell: (r) => (
        <div>
          <div className="capitalize">{(r.payout_method || '').replace(/_/g, ' ') || '—'}</div>
          <div className="text-[10px] text-muted-foreground tabular-nums truncate max-w-[180px]">
            {r.mobile_money_number || r.bank_account_number || r.transaction_id || ''}
          </div>
        </div>
      ),
    },
    {
      key: 'balance_before',
      header: 'Balance Before',
      align: 'right',
      cell: (r) => (
        <span className="font-medium tabular-nums whitespace-nowrap">{formatUGX(Number(r.balance_before))}</span>
      ),
    },
    {
      key: 'amount',
      header: 'Withdrawal',
      align: 'right',
      primary: true,
      cell: (r) => (
        <span className="font-bold tabular-nums whitespace-nowrap text-destructive">−{formatUGX(Number(r.amount))}</span>
      ),
    },
    {
      key: 'balance_after',
      header: 'Balance After',
      align: 'right',
      cell: (r) => {
        const settled = ['completed','approved','paid','fin_ops_approved','processed'].includes(r.status);
        return (
          <span className={`font-medium tabular-nums whitespace-nowrap ${settled ? '' : 'text-muted-foreground'}`}>
            {formatUGX(Number(r.balance_after))}
          </span>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      cell: (r) => (
        <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${STATUS_TONE[r.status] || ''}`}>
          {r.status.replace(/_/g, ' ')}
        </Badge>
      ),
    },
  ], []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase.rpc('get_withdrawal_history', {
        p_search: committed.trim() || null,
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
      });
      if (error) throw error;
      const list = (data || []) as Row[];
      setRows(list);
      setTotal(list[0]?.total_count ? Number(list[0].total_count) : 0);
    } catch (e: any) {
      setError(e.message || 'Failed to load withdrawal history');
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [committed, page]);

  useEffect(() => { load(); }, [load]);

  const totals = useMemo(() => {
    const completed = rows.filter(r =>
      ['completed','approved','paid','fin_ops_approved','processed'].includes(r.status)
    );
    return {
      completedCount: completed.length,
      completedAmount: completed.reduce((s, r) => s + Number(r.amount), 0),
      pageAmount: rows.reduce((s, r) => s + Number(r.amount), 0),
      failedCount: rows.filter(r => ['failed','rejected','cancelled'].includes(r.status)).length,
    };
  }, [rows]);

  const submitSearch = () => { setPage(0); setCommitted(search); };
  const clear = () => { setSearch(''); setCommitted(''); setPage(0); };

  return (
    <section className="space-y-5">
      <PageHeader
        icon={Receipt}
        title="Withdrawal History"
        description="Chronological audit trail of every user withdrawal: balance before, amount, balance after."
      />

      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input
            placeholder="Search by user name, phone, TID or MoMo number…"
            aria-label="Search withdrawal history"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitSearch()}
            className="pl-9 pr-9 h-11 rounded-xl"
          />
          {search && (
            <button onClick={clear} className="absolute right-3 top-1/2 -translate-y-1/2" aria-label="Clear search">
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          )}
        </div>
        <Button onClick={submitSearch} disabled={loading} className="h-11 px-5 rounded-xl">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Search'}
        </Button>
      </div>

      {committed && (
        <p className="text-sm text-muted-foreground">
          Filtering by <span className="font-medium text-foreground">"{committed}"</span> · {total} match{total !== 1 ? 'es' : ''}
        </p>
      )}

      {error && (
        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-2xl border bg-card shadow-2xs p-3 sm:p-4 space-y-4">
        <ExpandableTable
          columns={columns}
          rows={rows}
          getRowKey={(r) => r.withdrawal_id}
          loading={loading}
          loadingText={<Loader2 className="h-5 w-5 animate-spin inline" />}
          emptyText="No withdrawals found."
          footer={
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="font-semibold uppercase tracking-wider text-muted-foreground">
                Page total ({rows.length} rows · {totals.completedCount} settled)
              </span>
              <span className="font-bold tabular-nums text-destructive">−{formatUGX(totals.pageAmount)}</span>
            </div>
          }
        />
        <Pager page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} noun="results" />
      </div>

      <div className="space-y-3">
        <h2 className="text-base font-bold tracking-tight">Summary <span className="font-normal text-muted-foreground">(current search, this page)</span></h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatTile icon={Users} tone="primary" label="Total withdrawals" value={total.toLocaleString()} note="All matching records" />
          <StatTile icon={Banknote} tone="primary" label="Amount on this page" value={formatUGX(totals.pageAmount)} />
          <StatTile icon={CheckCircle2} tone="emerald" label="Settled" value={totals.completedCount.toLocaleString()} note="On this page" />
          <StatTile icon={XCircle} tone="rose" label="Failed or rejected" value={totals.failedCount.toLocaleString()} note="On this page" />
        </div>
      </div>

      <UserDrilldownDrawer
        open={!!drillUserId}
        onOpenChange={(v) => { if (!v) setDrillUserId(null); }}
        tenantId={drillUserId}
        defaultTab="tenant"
      />
    </section>
  );
}
