import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { formatDynamic } from '@/lib/currencyFormat';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { format } from 'date-fns';
import {
  Bell, Search, Loader2, RefreshCw, X,
  ChevronLeft, ChevronRight, ChevronUp, ChevronDown, ChevronsUpDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type LogRow = {
  id: string;
  withdrawal_id: string | null;
  recipient_id: string | null;
  recipient_email: string | null;
  amount: number | null;
  status: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string | null;
};

type SortKey = 'recipient_email' | 'amount' | 'status' | 'created_at';
type SortDir = 'asc' | 'desc';
const PAGE_SIZE = 25;

const STATUS_OPTIONS = ['all', 'queued', 'sent', 'failed'] as const;
type StatusFilter = typeof STATUS_OPTIONS[number];

function statusColor(status?: string | null) {
  switch ((status || '').toLowerCase()) {
    case 'sent':
      return 'bg-emerald-500/10 text-emerald-600';
    case 'queued':
    case 'processing':
      return 'bg-amber-500/10 text-amber-600';
    case 'failed':
    case 'error':
      return 'bg-destructive/10 text-destructive';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

/**
 * Withdrawal Notification Log — admin audit of every merchant withdrawal
 * alert email. Filter by recipient (email), amount range and timestamp
 * window so delivery failures can be traced quickly. Filtering, sorting and
 * pagination all run server-side so the page stays fast with large datasets.
 * Access is RLS-restricted to manager / super_admin / cto roles.
 */
export function WithdrawalNotificationLogPanel() {
  const [recipient, setRecipient] = useState('');
  const [minAmount, setMinAmount] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>('created_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const debouncedRecipient = useDebouncedValue(recipient, 300);

  // Reset to first page whenever filters or sort change.
  useEffect(() => {
    setPage(0);
  }, [debouncedRecipient, minAmount, maxAmount, fromDate, toDate, statusFilter, sortKey, sortDir]);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: [
      'withdrawal-notification-log',
      debouncedRecipient, minAmount, maxAmount, fromDate, toDate, statusFilter,
      sortKey, sortDir, page,
    ],
    queryFn: async () => {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let query = supabase
        .from('withdrawal_notification_log')
        .select('*', { count: 'exact' });

      const q = debouncedRecipient.trim();
      if (q) query = query.ilike('recipient_email', `%${q}%`);
      if (statusFilter !== 'all') query = query.eq('status', statusFilter);
      const min = minAmount.trim() === '' ? null : Number(minAmount);
      const max = maxAmount.trim() === '' ? null : Number(maxAmount);
      if (min !== null && Number.isFinite(min)) query = query.gte('amount', min);
      if (max !== null && Number.isFinite(max)) query = query.lte('amount', max);
      if (fromDate) query = query.gte('created_at', new Date(fromDate + 'T00:00:00').toISOString());
      if (toDate) query = query.lte('created_at', new Date(toDate + 'T23:59:59.999').toISOString());

      query = query
        .order(sortKey, { ascending: sortDir === 'asc', nullsFirst: false })
        .range(from, to);

      const { data: result, error, count } = await query;
      if (error) throw error;
      return { rows: (result || []) as LogRow[], total: count ?? 0 };
    },
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const hasFilters = recipient || minAmount || maxAmount || fromDate || toDate || statusFilter !== 'all';
  const clearFilters = () => {
    setRecipient('');
    setMinAmount('');
    setMaxAmount('');
    setFromDate('');
    setToDate('');
    setStatusFilter('all');
  };

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'created_at' || key === 'amount' ? 'desc' : 'asc');
    }
  }

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return <ChevronsUpDown className="h-3 w-3 opacity-40" />;
    return sortDir === 'asc'
      ? <ChevronUp className="h-3 w-3 text-primary" />
      : <ChevronDown className="h-3 w-3 text-primary" />;
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl sm:text-2xl font-bold flex items-center gap-2.5">
          <Bell className="h-6 w-6 text-violet-600" />
          Withdrawal Notification Log
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Every merchant withdrawal alert and every paid-confirmation SMS sent to the withdrawing user — with live delivery status (queued → sent / failed). Search by recipient, status, amount range and date to trace delivery.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">Filters</CardTitle>
            <Button variant="outline" size="sm" className="gap-2 h-8" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search recipient email…"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              className="pl-10 h-11"
              type="email"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-xs text-muted-foreground mb-1 block">Delivery status</label>
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
                <SelectTrigger className="h-11">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="queued">Queued</SelectItem>
                  <SelectItem value="sent">Sent</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Min amount (UGX)</label>
              <Input inputMode="numeric" placeholder="0" value={minAmount} onChange={(e) => setMinAmount(e.target.value.replace(/[^0-9.]/g, ''))} className="h-11" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Max amount (UGX)</label>
              <Input inputMode="numeric" placeholder="Any" value={maxAmount} onChange={(e) => setMaxAmount(e.target.value.replace(/[^0-9.]/g, ''))} className="h-11" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">From date</label>
              <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-11" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">To date</label>
              <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-11" />
            </div>
          </div>
          {hasFilters && (
            <Button variant="ghost" size="sm" className="gap-2 h-8" onClick={clearFilters}>
              <X className="h-3.5 w-3.5" /> Clear filters
            </Button>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2 text-sm">
        <Badge variant="outline" className="px-3 py-1">{total.toLocaleString()} match{total === 1 ? '' : 'es'}</Badge>
        {isFetching && !isLoading && (
          <Badge variant="outline" className="px-3 py-1 gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" /> Updating
          </Badge>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
          ) : rows.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">No notification log entries match your filters.</div>
          ) : (
            <>
            <ScrollArea className="max-h-[600px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHead label="Recipient" col="recipient_email" sortKey={sortKey} onSort={toggleSort}><SortIcon col="recipient_email" /></SortableHead>
                    <SortableHead label="Amount" col="amount" align="right" sortKey={sortKey} onSort={toggleSort}><SortIcon col="amount" /></SortableHead>
                    <SortableHead label="Status" col="status" sortKey={sortKey} onSort={toggleSort}><SortIcon col="status" /></SortableHead>
                    <SortableHead label="When" col="created_at" sortKey={sortKey} onSort={toggleSort}><SortIcon col="created_at" /></SortableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="max-w-[220px]">
                        <p className="truncate font-medium">{r.recipient_email || '—'}</p>
                        {r.error_message && (
                          <p className="text-[11px] text-destructive truncate" title={r.error_message}>{r.error_message}</p>
                        )}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap font-medium">{formatDynamic(Number(r.amount ?? 0))}</TableCell>
                      <TableCell>
                        <Badge className={`text-[10px] px-1.5 py-0 border-0 ${statusColor(r.status)}`}>
                          {(r.status || 'unknown').replace(/_/g, ' ')}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {format(new Date(r.created_at), 'dd MMM yyyy, HH:mm')}
                        {r.updated_at && r.updated_at !== r.created_at && (r.status || '').toLowerCase() !== 'queued' && (
                          <p className="text-[10px]">
                            {(r.status || '').toLowerCase() === 'sent' ? 'Delivered' : 'Resolved'}{' '}
                            {format(new Date(r.updated_at), 'HH:mm')}
                          </p>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
            <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
              <span className="text-[11px] text-muted-foreground">
                Page {page + 1} of {totalPages}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline" size="icon" className="h-7 w-7"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0 || isFetching}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline" size="icon" className="h-7 w-7"
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1 || isFetching}
                  aria-label="Next page"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SortableHead({
  label, col, align, sortKey, onSort, children,
}: {
  label: string;
  col: SortKey;
  align?: 'right';
  sortKey: SortKey;
  onSort: (col: SortKey) => void;
  children: React.ReactNode;
}) {
  return (
    <TableHead className={align === 'right' ? 'text-right' : undefined}>
      <button
        type="button"
        onClick={() => onSort(col)}
        className={cn(
          'inline-flex items-center gap-1 select-none hover:text-foreground transition-colors',
          align === 'right' && 'flex-row-reverse',
          sortKey === col && 'text-foreground',
        )}
      >
        {label}
        {children}
      </button>
    </TableHead>
  );
}