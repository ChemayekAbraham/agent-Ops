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
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { format } from 'date-fns';
import {
  MessageSquare, Search, Loader2, RefreshCw, X,
  ChevronLeft, ChevronRight, ChevronDown,
} from 'lucide-react';

type AttemptRecord = {
  provider?: string;
  ok?: boolean;
  error?: string | null;
  response?: unknown;
  attempt?: number;
};

type LogRow = {
  id: string;
  created_at: string;
  recipient_phone: string;
  recipient_user_id: string | null;
  recipient_name: string | null;
  message: string | null;
  status: string | null;
  provider: string | null;
  provider_message_id: string | null;
  provider_response: { attempts?: AttemptRecord[]; retries?: number; total_provider_calls?: number } | null;
  cost: string | null;
  reference_id: string | null;
  source: string | null;
  error: string | null;
};

const PAGE_SIZE = 25;

// Sources produced by the claim & payout SMS instrumentation.
const SOURCE_OPTIONS = [
  { value: 'all', label: 'All claim & payout SMS' },
  { value: 'withdrawal_claim', label: 'Claim alert (to customer)' },
  { value: 'withdrawal_payout', label: 'Paid confirmation (to customer)' },
  { value: 'merchant_commission', label: 'Merchant commission' },
  { value: 'proxy_payout', label: 'Proxy partner payout' },
] as const;
const AUDIT_SOURCES = SOURCE_OPTIONS.filter((s) => s.value !== 'all').map((s) => s.value);

const STATUS_OPTIONS = ['all', 'sent', 'queued', 'failed'] as const;
type StatusFilter = typeof STATUS_OPTIONS[number];

function statusColor(status?: string | null) {
  switch ((status || '').toLowerCase()) {
    case 'sent': return 'bg-emerald-500/10 text-emerald-600';
    case 'queued':
    case 'processing': return 'bg-amber-500/10 text-amber-600';
    case 'failed':
    case 'error': return 'bg-destructive/10 text-destructive';
    default: return 'bg-muted text-muted-foreground';
  }
}

function sourceLabel(source?: string | null) {
  return SOURCE_OPTIONS.find((s) => s.value === source)?.label ?? (source || 'unknown').replace(/_/g, ' ');
}

/**
 * SMS Delivery Log — full delivery-status audit for every claim & payout SMS.
 * Shows the winning/last provider, per-provider response trail, retry count
 * and failure reason so Financial Ops can trace exactly what happened for any
 * merchant claim or payout text. RLS-restricted to finance/tech leadership.
 */
export function SmsDeliveryLogPanel() {
  const [recipient, setRecipient] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [page, setPage] = useState(0);

  const debouncedRecipient = useDebouncedValue(recipient, 300);

  useEffect(() => {
    setPage(0);
  }, [debouncedRecipient, statusFilter, sourceFilter, fromDate, toDate]);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['sms-delivery-log', debouncedRecipient, statusFilter, sourceFilter, fromDate, toDate, page],
    queryFn: async () => {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let query = supabase.from('sms_delivery_log').select('*', { count: 'exact' });

      // Scope strictly to claim & payout SMS for this Financial Ops audit view.
      if (sourceFilter === 'all') query = query.in('source', AUDIT_SOURCES);
      else query = query.eq('source', sourceFilter);

      const q = debouncedRecipient.trim();
      if (q) query = query.or(`recipient_phone.ilike.%${q}%,recipient_name.ilike.%${q}%,reference_id.ilike.%${q}%`);
      if (statusFilter !== 'all') query = query.eq('status', statusFilter);
      if (fromDate) query = query.gte('created_at', new Date(fromDate + 'T00:00:00').toISOString());
      if (toDate) query = query.lte('created_at', new Date(toDate + 'T23:59:59.999').toISOString());

      query = query.order('created_at', { ascending: false }).range(from, to);

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

  const hasFilters = recipient || statusFilter !== 'all' || sourceFilter !== 'all' || fromDate || toDate;
  const clearFilters = () => {
    setRecipient('');
    setStatusFilter('all');
    setSourceFilter('all');
    setFromDate('');
    setToDate('');
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl sm:text-2xl font-bold flex items-center gap-2.5">
          <MessageSquare className="h-6 w-6 text-sky-600" />
          SMS Delivery Log
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Full delivery-status audit of every claim &amp; payout SMS — the provider used, its raw response, retry count and any failure reason. Expand a row to inspect the per-provider attempt trail.
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
              placeholder="Search phone, name or withdrawal ref…"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              className="pl-10 h-11"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-xs text-muted-foreground mb-1 block">SMS type</label>
              <Select value={sourceFilter} onValueChange={setSourceFilter}>
                <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SOURCE_OPTIONS.map((s) => (
                    <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2">
              <label className="text-xs text-muted-foreground mb-1 block">Delivery status</label>
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
                <SelectTrigger className="h-11"><SelectValue placeholder="All statuses" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="sent">Sent</SelectItem>
                  <SelectItem value="queued">Queued</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
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
            <div className="py-12 text-center text-sm text-muted-foreground">No SMS delivery records match your filters.</div>
          ) : (
            <>
              <ScrollArea className="max-h-[600px]">
                <div className="divide-y divide-border">
                  {rows.map((r) => {
                    const attempts = r.provider_response?.attempts ?? [];
                    const retries = r.provider_response?.retries ?? 0;
                    return (
                      <Collapsible key={r.id}>
                        <div className="px-3 py-3">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <Badge className={`text-[10px] px-1.5 py-0 border-0 ${statusColor(r.status)}`}>
                                  {(r.status || 'unknown').replace(/_/g, ' ')}
                                </Badge>
                                <span className="text-xs font-medium">{sourceLabel(r.source)}</span>
                              </div>
                              <p className="text-sm font-medium truncate mt-1">
                                {r.recipient_name || 'Unknown'} · {r.recipient_phone || '—'}
                              </p>
                              <p className="text-[11px] text-muted-foreground truncate">
                                Provider: <span className="font-medium">{r.provider || '—'}</span>
                                {' · '}Attempts: {attempts.length}{retries > 0 ? ` · Retries: ${retries}` : ''}
                                {r.reference_id ? ` · Ref: ${r.reference_id.slice(0, 8)}…` : ''}
                              </p>
                              {r.error && (
                                <p className="text-[11px] text-destructive mt-0.5 line-clamp-2" title={r.error}>{r.error}</p>
                              )}
                            </div>
                            <div className="text-right shrink-0">
                              <p className="text-[11px] text-muted-foreground whitespace-nowrap">
                                {format(new Date(r.created_at), 'dd MMM, HH:mm')}
                              </p>
                              {(attempts.length > 0 || r.message) && (
                                <CollapsibleTrigger asChild>
                                  <Button variant="ghost" size="sm" className="h-7 gap-1 text-[11px] mt-1">
                                    Details <ChevronDown className="h-3 w-3" />
                                  </Button>
                                </CollapsibleTrigger>
                              )}
                            </div>
                          </div>
                          <CollapsibleContent className="mt-2 space-y-2">
                            {r.message && (
                              <div className="rounded-md bg-muted/50 p-2">
                                <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">Message</p>
                                <p className="text-xs whitespace-pre-wrap break-words">{r.message}</p>
                              </div>
                            )}
                            {attempts.length > 0 && (
                              <div className="space-y-1.5">
                                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Provider attempts</p>
                                {attempts.map((a, i) => (
                                  <div key={i} className="rounded-md border border-border p-2 text-xs">
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="font-medium">
                                        {a.attempt ? `#${a.attempt} · ` : ''}{a.provider || 'provider'}
                                      </span>
                                      <Badge className={`text-[10px] px-1.5 py-0 border-0 ${a.ok ? 'bg-emerald-500/10 text-emerald-600' : 'bg-destructive/10 text-destructive'}`}>
                                        {a.ok ? 'accepted' : 'rejected'}
                                      </Badge>
                                    </div>
                                    {a.error && <p className="text-[11px] text-destructive mt-1">{a.error}</p>}
                                    {a.response != null && (
                                      <pre className="mt-1 text-[10px] text-muted-foreground overflow-x-auto whitespace-pre-wrap break-words">
                                        {typeof a.response === 'string' ? a.response : JSON.stringify(a.response, null, 2)}
                                      </pre>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </CollapsibleContent>
                        </div>
                      </Collapsible>
                    );
                  })}
                </div>
              </ScrollArea>
              <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
                <span className="text-[11px] text-muted-foreground">Page {page + 1} of {totalPages}</span>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0 || isFetching} aria-label="Previous page">
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1 || isFetching} aria-label="Next page">
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
