import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Loader2, CheckCircle2, Banknote, Zap, Calendar, User, X,
} from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { TreasuryImpactBanner } from './TreasuryImpactBanner';
import { CfoApprovalGate } from '@/components/cfo/CfoApprovalGate';

const MONTHLY_RATE = 0.33;
const fmt = (n: number) =>
  `UGX ${new Intl.NumberFormat('en-UG', { maximumFractionDigits: 0 }).format(n)}`;

function calcTerms(amount: number, months: number) {
  const days = months * 30;
  const accessFee = Math.round(amount * (Math.pow(1 + MONTHLY_RATE, months) - 1));
  const totalPayable = amount + accessFee;
  const dailyCharge = days > 0 ? Math.ceil(totalPayable / days) : 0;
  return { days, accessFee, totalPayable, dailyCharge };
}

const PAGE_SIZE = 10;

function getPageNumbers(totalPages: number, currentPage: number) {
  const pages: (number | string)[] = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else if (currentPage <= 4) {
    pages.push(1, 2, 3, 4, 5, '...', totalPages);
  } else if (currentPage >= totalPages - 3) {
    pages.push(1, '...', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages);
  } else {
    pages.push(1, '...', currentPage - 1, currentPage, currentPage + 1, '...', totalPages);
  }
  return pages;
}

interface PendingDraw {
  id: string;
  user_id: string;
  agent_id: string | null;
  amount: number;
  requested_amount: number | null;
  duration_months: number;
  submitted_at: string | null;
  created_at: string;
  user_name: string;
  user_phone: string | null;
  agent_name: string;
}

export function CreditDrawApprovalQueue() {
  const qc = useQueryClient();
  const [edits, setEdits] = useState<Record<string, { amount: string; months: string }>>({});
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [confirming, setConfirming] = useState<PendingDraw | null>(null);

  // Filters + pagination
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [page, setPage] = useState(1);

  const { data: items = [], isLoading } = useQuery<PendingDraw[]>({
    queryKey: ['credit-draw-approval-queue'],
    queryFn: async () => {
      const { data: draws, error } = await supabase
        .from('credit_access_draws')
        .select('id, user_id, agent_id, amount, requested_amount, duration_months, submitted_at, created_at')
        .eq('status', 'pending_cfo')
        .order('submitted_at', { ascending: true, nullsFirst: false });
      if (error) throw error;
      if (!draws?.length) return [];

      const ids = [...new Set(draws.flatMap(d => [d.user_id, d.agent_id].filter(Boolean) as string[]))];
      const map = new Map<string, { name: string; phone: string | null }>();
      if (ids.length) {
        const { data: profiles } = await supabase
          .from('profiles').select('id, full_name, phone').in('id', ids);
        for (const p of profiles || []) map.set(p.id, { name: p.full_name || 'Unknown', phone: (p as any).phone || null });
      }
      return draws.map(d => ({
        ...d,
        amount: Number(d.amount) || 0,
        requested_amount: d.requested_amount != null ? Number(d.requested_amount) : null,
        user_name: map.get(d.user_id)?.name || 'Unknown User',
        user_phone: map.get(d.user_id)?.phone || null,
        agent_name: d.agent_id ? (map.get(d.agent_id)?.name || 'Unknown Agent') : 'No Agent',
      }));
    },
    staleTime: 15_000,
  });

  const totalPrincipal = useMemo(() => items.reduce((s, i) => s + i.amount, 0), [items]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((item) => {
      if (q) {
        const hay = [
          item.user_name,
          item.user_phone,
          item.agent_name,
          String(item.requested_amount ?? item.amount),
          String(item.id).slice(0, 8),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      const day = String(item.submitted_at || item.created_at).slice(0, 10);
      if (fromDate && day < fromDate) return false;
      if (toDate && day > toDate) return false;
      return true;
    });
  }, [items, search, fromDate, toDate]);

  const hasActiveFilters = !!(search || fromDate || toDate);
  const clearFilters = () => {
    setSearch(''); setFromDate(''); setToDate(''); setPage(1);
  };

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const approve = useMutation({
    mutationFn: async (draw: PendingDraw) => {
      const e = edits[draw.id];
      const amount = e?.amount ? Math.round(Number(e.amount)) : draw.amount;
      const months = e?.months ? Math.round(Number(e.months)) : draw.duration_months;
      const { data, error } = await supabase.functions.invoke('cfo-approve-credit-draw', {
        body: { draw_id: draw.id, action: 'approve', amount, duration_months: months },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    // Optimistically drop the approved card from the queue so the action feels
    // instant — the CFO no longer waits on the full disbursement round-trip.
    onMutate: async (draw: PendingDraw) => {
      await qc.cancelQueries({ queryKey: ['credit-draw-approval-queue'] });
      const prev = qc.getQueryData<PendingDraw[]>(['credit-draw-approval-queue']);
      qc.setQueryData<PendingDraw[]>(['credit-draw-approval-queue'], (old) =>
        (old || []).filter((d) => d.id !== draw.id));
      toast.success('Credit approved & disbursing to wallet');
      return { prev };
    },
    onError: (err: any, _draw, ctx) => {
      // Roll back the optimistic removal if the disbursement failed.
      if (ctx?.prev) qc.setQueryData(['credit-draw-approval-queue'], ctx.prev);
      toast.error(err.message || 'Approval failed');
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['credit-draw-approval-queue'] });
      qc.invalidateQueries({ queryKey: ['treasury-cash-snapshot'] });
      qc.invalidateQueries({ queryKey: ['cfo-overview'] });
    },
  });

  const reject = useMutation({
    mutationFn: async (drawId: string) => {
      if (rejectReason.trim().length < 5) throw new Error('Enter a rejection reason (min 5 chars)');
      const { data, error } = await supabase.functions.invoke('cfo-approve-credit-draw', {
        body: { draw_id: drawId, action: 'reject', rejection_reason: rejectReason },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      toast.success('Credit request rejected');
      setRejectingId(null);
      setRejectReason('');
      qc.invalidateQueries({ queryKey: ['credit-draw-approval-queue'] });
    },
    onError: (err: any) => toast.error(err.message || 'Rejection failed'),
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Zap className="h-4 w-4 text-warning" />
          Credit Access Approval Queue
          {visible.length > 0 && (
            <Badge variant="outline" className="text-[10px] ml-1 bg-warning/10 text-warning border-warning/30">
              {visible.length} pending · {fmt(visible.reduce((s, i) => s + i.amount, 0))} in current view
            </Badge>
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Every credit access draw lands here first. Edit the amount/term if needed, then manually approve to
          disburse into the user's <strong>withdrawable wallet</strong> — or reject it.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <CheckCircle2 className="h-10 w-10 mx-auto mb-2 text-emerald-500" />
            <p className="font-medium">No Pending Credit Requests</p>
            <p className="text-xs">All credit access draws have been reviewed</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label htmlFor="cd-search" className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Search</Label>
                <Input
                  id="cd-search"
                  placeholder="Applicant, phone or agent"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Submitted date range</Label>
                <div className="flex items-center gap-2">
                  <Input type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); setPage(1); }} className="h-8 text-xs" />
                  <span className="text-muted-foreground">-</span>
                  <Input type="date" value={toDate} onChange={(e) => { setToDate(e.target.value); setPage(1); }} className="h-8 text-xs" />
                </div>
              </div>
              <div className="flex items-end">
                <Button variant="outline" size="sm" className="h-8 text-xs w-full" onClick={clearFilters} disabled={!hasActiveFilters}>
                  Clear Filters
                </Button>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold">Credit access draws</h3>
              <Badge variant="secondary">{visible.length} of {items.length} shown</Badge>
            </div>
          </div>
        )}

      {visible.length === 0 && items.length > 0 && (
        <div className="text-center py-8 text-muted-foreground">
          <CheckCircle2 className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No credit access draws match the selected filters.</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={clearFilters}>Clear filters</Button>
        </div>
      )}

      {visible.length > 0 && (
              <div className="rounded-xl border border-border overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-muted-foreground">
                    <th className="px-3 py-2 text-left font-semibold whitespace-nowrap">Applicant</th>
                    <th className="px-3 py-2 text-left font-semibold whitespace-nowrap">Submitted</th>
                    <th className="px-3 py-2 text-right font-semibold whitespace-nowrap">Requested</th>
                    <th className="px-3 py-2 text-right font-semibold whitespace-nowrap">Amount (UGX)</th>
                    <th className="px-3 py-2 text-center font-semibold whitespace-nowrap">Months</th>
                    <th className="px-3 py-2 text-right font-semibold whitespace-nowrap">Access fee</th>
                    <th className="px-3 py-2 text-right font-semibold whitespace-nowrap">Total repay</th>
                    <th className="px-3 py-2 text-right font-semibold whitespace-nowrap">Daily charge</th>
                    <th className="px-3 py-2 text-right font-semibold whitespace-nowrap">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map(item => {
                    const e = edits[item.id];
                    const amount = e?.amount !== undefined && e.amount !== '' ? Number(e.amount) : item.amount;
                    const months = e?.months !== undefined && e.months !== '' ? Number(e.months) : item.duration_months;
                    const terms = calcTerms(amount || 0, Math.max(1, Math.min(12, months || 1)));
                    const edited = amount !== item.amount || months !== item.duration_months;
                    return (
                      <tr key={item.id} className="border-b border-border last:border-0 align-middle hover:bg-muted/30">
                        <td className="px-3 py-2">
                          <p className="font-medium flex items-center gap-1.5">
                            <User className="h-3.5 w-3.5 text-primary shrink-0" />
                            <span className="truncate max-w-[140px]">{item.user_name}</span>
                          </p>
                          <p className="text-[10px] text-muted-foreground">
                            {item.user_phone || '—'} · {item.agent_name}
                          </p>
                          {edited && (
                            <Badge variant="outline" className="mt-1 text-[9px] bg-amber-100 text-amber-700 border-amber-200">
                              Edited by CFO
                            </Badge>
                          )}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-[11px] text-muted-foreground">
                          <span className="inline-flex items-center gap-1">
                            <Calendar className="h-2.5 w-2.5" />
                            {format(new Date(item.submitted_at || item.created_at), 'dd MMM HH:mm')}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          {fmt(item.requested_amount ?? item.amount)}
                          <span className="block text-[10px] text-muted-foreground">{item.duration_months} mo</span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Input
                            type="number"
                            value={e?.amount ?? String(item.amount)}
                            onChange={ev => setEdits(p => ({ ...p, [item.id]: { amount: ev.target.value, months: p[item.id]?.months ?? String(item.duration_months) } }))}
                            className="h-8 w-28 text-xs text-right"
                          />
                        </td>
                        <td className="px-3 py-2 text-center">
                          <Input
                            type="number"
                            min={1}
                            max={12}
                            value={e?.months ?? String(item.duration_months)}
                            onChange={ev => setEdits(p => ({ ...p, [item.id]: { months: ev.target.value, amount: p[item.id]?.amount ?? String(item.amount) } }))}
                            className="h-8 w-16 text-xs text-center mx-auto"
                          />
                        </td>
                        <td className="px-3 py-2 text-right font-semibold text-warning whitespace-nowrap">{fmt(terms.accessFee)}</td>
                        <td className="px-3 py-2 text-right font-semibold whitespace-nowrap">{fmt(terms.totalPayable)}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">{fmt(terms.dailyCharge)}</td>
                        <td className="px-3 py-2">
                          <CfoApprovalGate>
                          {rejectingId === item.id ? (
                            <div className="space-y-1 min-w-[180px]">
                              <Input
                                placeholder="Reason for rejection"
                                value={rejectReason}
                                onChange={ev => setRejectReason(ev.target.value)}
                                className="h-8 text-xs"
                              />
                              <div className="flex gap-1 justify-end">
                                <Button size="sm" variant="destructive" className="h-7 text-[11px]"
                                  onClick={() => reject.mutate(item.id)} disabled={reject.isPending}>
                                  {reject.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <X className="h-3 w-3 mr-1" />}
                                  Confirm
                                </Button>
                                <Button size="sm" variant="outline" className="h-7 text-[11px]"
                                  onClick={() => { setRejectingId(null); setRejectReason(''); }}>
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex gap-1 justify-end">
                              <Button
                                size="sm"
                                className="h-7 text-[11px] whitespace-nowrap"
                                onClick={() => setConfirming(item)}
                                disabled={approve.isPending || !amount || amount < 10000}
                              >
                                {approve.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Banknote className="h-3 w-3 mr-1" />}
                                Approve
                              </Button>
                              <Button size="sm" variant="outline" className="h-7 text-[11px] text-destructive"
                                onClick={() => { setRejectingId(item.id); setRejectReason(''); }}>
                                Reject
                              </Button>
                            </div>
                          )}
                          </CfoApprovalGate>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="border-t px-3 py-2">
                <div className="flex flex-col sm:flex-row items-center justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">
                    Page {safePage} of {totalPages} · {visible.length} requests
                  </span>
                  <div className="flex flex-wrap items-center justify-center gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      disabled={safePage === 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                    >
                      Previous
                    </Button>
                    {getPageNumbers(totalPages, safePage).map((p, idx) => (
                      p === '...' ? (
                        <span key={`ellipsis-${idx}`} className="px-1 text-muted-foreground">…</span>
                      ) : (
                        <Button
                          key={p}
                          size="sm"
                          variant={safePage === p ? 'default' : 'outline'}
                          className="h-7 min-w-[28px] px-2 text-xs"
                          onClick={() => setPage(Number(p))}
                        >
                          {p}
                        </Button>
                      )
                    ))}
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      disabled={safePage === totalPages}
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
      )}
      </CardContent>

      {/* Two-step confirm before money actually moves */}
      <AlertDialog open={!!confirming} onOpenChange={(o) => { if (!o) setConfirming(null); }}>
        <AlertDialogContent>
          {confirming && (() => {
            const e = edits[confirming.id];
            const amount = e?.amount !== undefined && e.amount !== '' ? Number(e.amount) : confirming.amount;
            const months = e?.months !== undefined && e.months !== '' ? Number(e.months) : confirming.duration_months;
            const terms = calcTerms(amount || 0, Math.max(1, Math.min(12, months || 1)));
            return (
              <>
                <AlertDialogHeader>
                  <AlertDialogTitle>Confirm disbursement?</AlertDialogTitle>
                  <AlertDialogDescription asChild>
                    <div className="space-y-2 text-sm">
                      <p>
                        You are about to credit <strong>{fmt(amount || 0)}</strong> into{' '}
                        <strong>{confirming.user_name}</strong>'s withdrawable wallet for{' '}
                        <strong>{Math.max(1, Math.min(12, months || 1))} month(s)</strong>.
                      </p>
                      <div className="rounded-md bg-muted/40 p-2 grid grid-cols-3 gap-2 text-center text-[11px]">
                        <div><p className="text-muted-foreground">Access Fee</p><p className="font-bold text-warning">{fmt(terms.accessFee)}</p></div>
                        <div><p className="text-muted-foreground">Total Repay</p><p className="font-bold">{fmt(terms.totalPayable)}</p></div>
                        <div><p className="text-muted-foreground">Daily Charge</p><p className="font-bold">{fmt(terms.dailyCharge)}</p></div>
                      </div>
                      <TreasuryImpactBanner payoutAmount={amount || 0} />
                      <p className="text-xs text-muted-foreground">This moves real money and cannot be undone.</p>
                    </div>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={approve.isPending}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={(ev) => { ev.preventDefault(); const target = confirming; setConfirming(null); approve.mutate(target); }}
                    disabled={approve.isPending}
                  >
                    {approve.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Banknote className="h-3 w-3 mr-1" />}
                    Confirm & Disburse {fmt(amount || 0)}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </>
            );
          })()}
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}