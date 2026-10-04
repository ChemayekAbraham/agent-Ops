import * as React from 'react';
import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { UserSearchPicker } from './UserSearchPicker';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { History, RefreshCw, Loader2, CheckCircle2, XCircle, Wallet, Ban, Filter, RotateCcw } from 'lucide-react';

interface RunEntry {
  id: string;
  recipient_name: string | null;
  amount: number | null;
  reason: string | null;
  category_id: string | null;
  status: 'success' | 'failed' | 'cancelled';
  error_message: string | null;
  ran_at: string;
}

interface PickedUser { id: string; full_name: string; phone?: string | null }

const PAGE_SIZE = 12;

type StatusFilter = 'all' | 'success' | 'failed' | 'cancelled';

// Default filter values — what "Reset" restores and the initial state.
const DEFAULT_STATUS: StatusFilter = 'all';
const DEFAULT_FROM = '';
const DEFAULT_TO = '';

function formatTs(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function AutoPayoutHistory() {
  const { toast } = useToast();
  const [user, setUser] = useState<PickedUser | null>(null);
  const [entries, setEntries] = useState<RunEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [totalPaid, setTotalPaid] = useState(0);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(DEFAULT_STATUS);
  const [fromDate, setFromDate] = useState(DEFAULT_FROM);
  const [toDate, setToDate] = useState(DEFAULT_TO);

  const load = useCallback(async (uid: string, p: number) => {
    setLoading(true);
    const from = p * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    let q = supabase
      .from('scheduled_payout_runs')
      .select('id, recipient_name, amount, reason, category_id, status, error_message, ran_at', { count: 'exact' })
      .eq('target_user_id', uid);
    if (statusFilter !== 'all') q = q.eq('status', statusFilter);
    if (fromDate) q = q.gte('ran_at', new Date(`${fromDate}T00:00:00`).toISOString());
    if (toDate) q = q.lte('ran_at', new Date(`${toDate}T23:59:59`).toISOString());
    const { data, error, count } = await q
      .order('ran_at', { ascending: false })
      .range(from, to);
    if (error) {
      console.error('[AutoPayoutHistory] load failed:', error);
      toast({ title: 'Could not load history', description: error.message, variant: 'destructive' });
      setLoading(false);
      return;
    }
    setEntries((data ?? []) as RunEntry[]);
    setTotal(count ?? 0);

    // Sum of successful auto payouts to this individual.
    const { data: sumRows } = await supabase
      .from('scheduled_payout_runs')
      .select('amount')
      .eq('target_user_id', uid)
      .eq('status', 'success');
    setTotalPaid((sumRows ?? []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0));
    setLoading(false);
  }, [toast, statusFilter, fromDate, toDate]);

  useEffect(() => {
    if (user) load(user.id, page);
  }, [user, page, load]);

  // Reset to first page whenever a filter changes.
  useEffect(() => {
    setPage(0);
  }, [statusFilter, fromDate, toDate]);

  const onSelect = (u: PickedUser | null) => {
    setPage(0);
    setUser(u);
    if (!u) { setEntries([]); setTotal(0); setTotalPaid(0); }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const isDefault = statusFilter === DEFAULT_STATUS && fromDate === DEFAULT_FROM && toDate === DEFAULT_TO;
  const hasFilter = !isDefault;
  const resetFilters = () => {
    setStatusFilter(DEFAULT_STATUS);
    setFromDate(DEFAULT_FROM);
    setToDate(DEFAULT_TO);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <History className="h-4 w-4 text-primary" />
            Auto Payout History (Per Individual)
          </CardTitle>
          {user && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => load(user.id, page)} disabled={loading}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">Search a person to see every automated payout that landed in their wallet.</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <UserSearchPicker
          label="Recipient"
          placeholder="Search by name or phone…"
          selectedUser={user as any}
          onSelect={onSelect as any}
        />

        {user && (
          <div className="flex items-center justify-between rounded-lg border p-3 bg-muted/10">
            <div className="text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{user.full_name}</span> · {total} run{total === 1 ? '' : 's'}
            </div>
            <div className="text-right">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Total auto-paid</p>
              <p className="text-sm font-bold flex items-center gap-1 justify-end"><Wallet className="h-3.5 w-3.5 text-primary" /> UGX {totalPaid.toLocaleString()}</p>
            </div>
          </div>
        )}

        {user && (
          <div className="rounded-lg border p-3 space-y-2 bg-muted/5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold flex items-center gap-1 text-muted-foreground uppercase tracking-wide">
                <Filter className="h-3 w-3" /> Filters
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[11px] px-2 gap-1"
                onClick={resetFilters}
                disabled={isDefault}
              >
                <RotateCcw className="h-3 w-3" /> Reset
              </Button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">Status</Label>
                <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
                  <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="success">Success</SelectItem>
                    <SelectItem value="failed">Failed</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">From</Label>
                <Input type="date" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)} className="h-9 text-xs" />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">To</Label>
                <Input type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)} className="h-9 text-xs" />
              </div>
            </div>
          </div>
        )}

        {!user ? (
          <p className="text-xs text-muted-foreground italic py-4 text-center">Pick a recipient above to view their auto payout history.</p>
        ) : loading ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground text-xs gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : entries.length === 0 ? (
          <p className="text-xs text-muted-foreground italic py-4 text-center">
            {hasFilter ? 'No payouts match the current filters.' : 'No automated payouts have run for this person yet.'}
          </p>
        ) : (
          <>
            {entries.map(e => (
              <div key={e.id} className="rounded-lg border p-3 space-y-1 bg-muted/10">
                <div className="flex items-start justify-between gap-2">
                  {e.status === 'success' ? (
                    <Badge className="bg-emerald-600 hover:bg-emerald-600 text-white text-[10px] gap-1"><CheckCircle2 className="h-3 w-3" /> Paid</Badge>
                  ) : e.status === 'cancelled' ? (
                    <Badge className="bg-amber-500 hover:bg-amber-500 text-white text-[10px] gap-1"><Ban className="h-3 w-3" /> Cancelled</Badge>
                  ) : (
                    <Badge className="bg-destructive hover:bg-destructive text-destructive-foreground text-[10px] gap-1"><XCircle className="h-3 w-3" /> Failed</Badge>
                  )}
                  {e.amount != null && (
                    <span className="text-sm font-bold whitespace-nowrap">UGX {Number(e.amount).toLocaleString()}</span>
                  )}
                </div>
                {(e.reason || e.category_id) && (
                  <p className="text-[11px] text-muted-foreground truncate">{[e.reason, e.category_id].filter(Boolean).join(' · ')}</p>
                )}
                {e.status !== 'success' && e.error_message && (
                  <p className="text-[11px] text-destructive truncate">{e.error_message}</p>
                )}
                <p className="text-[11px] text-muted-foreground">{formatTs(e.ran_at)}</p>
              </div>
            ))}
            {totalPages > 1 && (
              <div className="flex items-center justify-between pt-1">
                <Button variant="outline" size="sm" className="h-7 text-xs" disabled={page === 0 || loading} onClick={() => setPage(p => Math.max(0, p - 1))}>
                  Previous
                </Button>
                <span className="text-[11px] text-muted-foreground">Page {page + 1} of {totalPages}</span>
                <Button variant="outline" size="sm" className="h-7 text-xs" disabled={page + 1 >= totalPages || loading} onClick={() => setPage(p => p + 1)}>
                  Next
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
