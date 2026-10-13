import { useState, useEffect, useMemo, Fragment } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { toast } from 'sonner';
import { CheckCircle, XCircle, Clock, Loader2, TrendingUp, CalendarIcon, X, Download } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { TreasuryImpactBanner } from './TreasuryImpactBanner';
import { format } from 'date-fns';
import { CfoApprovalGate } from '@/components/cfo/CfoApprovalGate';

interface PendingOp {
  id: string;
  user_id: string | null;
  amount: number;
  category: string;
  description: string | null;
  status: string;
  created_at: string;
  reference_id: string | null;
  operation_type: string;
  target_wallet_user_id: string | null;
  source_id: string | null;
  metadata: Record<string, any> | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
}

const formatUGX = (n: number) => `UGX ${n.toLocaleString()}`;

export function CFOROIRequests() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [rejectionReasons, setRejectionReasons] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<'coo_approved' | 'approved' | 'rejected'>('coo_approved');
  const [search, setSearch] = useState('');
  const [dateFilter, setDateFilter] = useState<Date | undefined>(undefined);
  const [rangeFilter, setRangeFilter] = useState<'today' | 'yesterday' | 'last_week' | 'this_month' | null>(null);

  // Kampala (UTC+3) day boundaries — the platform's canonical day, used everywhere else
  const kampalaDayStartUtc = (d: Date) => {
    const k = new Date(d.getTime() + 3 * 3600 * 1000);
    return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()) - 3 * 3600 * 1000);
  };
  const rangeBounds = useMemo((): [Date, Date] | null => {
    if (!rangeFilter) return null;
    const now = new Date();
    const todayStart = kampalaDayStartUtc(now);
    if (rangeFilter === 'today') return [todayStart, new Date(todayStart.getTime() + 24 * 3600 * 1000)];
    if (rangeFilter === 'yesterday') return [new Date(todayStart.getTime() - 24 * 3600 * 1000), todayStart];
    if (rangeFilter === 'last_week') return [new Date(todayStart.getTime() - 6 * 24 * 3600 * 1000), new Date(todayStart.getTime() + 24 * 3600 * 1000)];
    // this month: first day of the Kampala month through its end
    const k = new Date(now.getTime() + 3 * 3600 * 1000);
    const monthStartUtc = new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), 1) - 3 * 3600 * 1000);
    return [monthStartUtc, new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth() + 1, 1) - 3 * 3600 * 1000)];
  }, [rangeFilter]);

  const { data: operations = [], isLoading } = useQuery({
    queryKey: ['cfo-roi-requests', filter],
    queryFn: async () => {
      let query = supabase
        .from('pending_wallet_operations')
        .select('*')
        .eq('category', 'roi_payout')
        .order('created_at', { ascending: false })
        .limit(rangeFilter === 'this_month' || rangeFilter === 'last_week' ? 500 : 100);

      query = query.eq('status', filter);

      const { data, error } = await query;
      if (error) throw error;
      return (data || []) as PendingOp[];
    },
  });

  // Fetch profile names for display
  const userIds = [...new Set(operations.flatMap(op => [op.user_id, op.target_wallet_user_id].filter(Boolean) as string[]))];
  const { data: profiles = [] } = useQuery({
    queryKey: ['roi-profiles', userIds.join(',')],
    queryFn: async () => {
      if (userIds.length === 0) return [];
      const { data } = await supabase.from('profiles').select('id, full_name, phone').in('id', userIds);
      return data || [];
    },
    enabled: userIds.length > 0,
  });

  // Settlements = Financial Ops has paid the partner (proxy route)
  const approvedIds = operations.filter(o => o.status === 'approved').map(o => o.id);
  const { data: settlements = [] } = useQuery({
    queryKey: ['roi-settlements', approvedIds.join(',')],
    queryFn: async () => {
      if (approvedIds.length === 0) return [];
      const { data, error } = await supabase
        .from('proxy_payout_settlements')
        .select('approval_id, settled_at, created_at')
        .in('approval_id', approvedIds);
      if (error) throw error;
      return data || [];
    },
    enabled: approvedIds.length > 0,
  });
  const settlementMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of settlements as any[]) m.set(String(s.approval_id), s.settled_at || s.created_at);
    return m;
  }, [settlements]);

  // Real-time: refresh when approvals or Financial Ops payouts change
  useEffect(() => {
    const channel = supabase
      .channel('cfo-roi-requests-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pending_wallet_operations', filter: 'category=eq.roi_payout' },
        () => queryClient.invalidateQueries({ queryKey: ['cfo-roi-requests'] }))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'proxy_payout_settlements' },
        () => queryClient.invalidateQueries({ queryKey: ['roi-settlements'] }))
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [queryClient]);

  // Direct partner-wallet payouts are credited at CFO approval; proxy payouts are paid when Financial Ops settles them.
  const paymentStatus = (op: PendingOp, isProxy: boolean, settledAt?: string): 'paid' | 'pending' | 'none' => {
    if (op.status !== 'approved') return 'none';
    if (!isProxy) return 'paid';
    return settledAt ? 'paid' : 'pending';
  };

  const getName = (id: string | null) => {
    if (!id) return '—';
    const p = profiles.find(pr => pr.id === id);
    return p?.full_name || id.slice(0, 8);
  };

  const approveMutation = useMutation({
    mutationFn: async (opId: string) => {
      const op = operations.find(o => o.id === opId);
      const { data, error } = await supabase.functions.invoke('approve-wallet-operation', {
        body: { operation_id: opId, action: 'approve' },
      });
      if (error) throw error;

      await supabase.from('audit_logs').insert({
        user_id: user?.id,
        action_type: 'cfo_roi_payout_approved',
        table_name: 'pending_wallet_operations',
        record_id: opId,
        metadata: {
          amount: op?.amount,
          target_user_id: op?.user_id,
          proxy_agent_id: op?.target_wallet_user_id || null,
          custody_route: op?.target_wallet_user_id ? 'partner_wallet_v2' : 'direct_partner_wallet',
          description: op?.description,
        },
      });

      return data;
    },
    onSuccess: () => {
      toast.success('ROI payout approved — wallet credited');
      queryClient.invalidateQueries({ queryKey: ['cfo-roi-requests'] });
      queryClient.invalidateQueries({ queryKey: ['cfo-actions-log'] });
    },
    onError: (err: any) => toast.error('Approval failed', { description: err.message }),
  });

  const rejectMutation = useMutation({
    mutationFn: async ({ opId, reason }: { opId: string; reason: string }) => {
      const op = operations.find(o => o.id === opId);
      const { data, error } = await supabase.functions.invoke('approve-wallet-operation', {
        body: { operation_id: opId, action: 'reject', rejection_reason: reason },
      });
      if (error) throw error;

      await supabase.from('audit_logs').insert({
        user_id: user?.id,
        action_type: 'cfo_roi_payout_rejected',
        table_name: 'pending_wallet_operations',
        record_id: opId,
        metadata: {
          amount: op?.amount,
          target_user_id: op?.user_id,
          proxy_agent_id: op?.target_wallet_user_id || null,
          custody_route: op?.target_wallet_user_id ? 'partner_wallet_v2' : 'direct_partner_wallet',
          reason,
        },
      });

      return data;
    },
    onSuccess: () => {
      toast.success('ROI payout rejected');
      queryClient.invalidateQueries({ queryKey: ['cfo-roi-requests'] });
      queryClient.invalidateQueries({ queryKey: ['cfo-actions-log'] });
    },
    onError: (err: any) => toast.error('Rejection failed', { description: err.message }),
  });

  const filtered = operations.filter(op => {
    const created = new Date(op.created_at);
    if (rangeBounds) {
      if (created < rangeBounds[0] || created >= rangeBounds[1]) return false;
    }
    if (dateFilter) {
      const dayStart = kampalaDayStartUtc(dateFilter);
      if (created < dayStart || created >= new Date(dayStart.getTime() + 24 * 3600 * 1000)) return false;
    }
    if (!search) return true;
    const s = search.toLowerCase();
    const meta = op.metadata as Record<string, any> | null;
    return (
      op.description?.toLowerCase().includes(s) ||
      op.reference_id?.toLowerCase().includes(s) ||
      meta?.partner_name?.toLowerCase().includes(s) ||
      meta?.target_agent_name?.toLowerCase().includes(s) ||
      getName(op.user_id).toLowerCase().includes(s)
    );
  });

  const pendingCount = operations.filter(o => o.status === 'coo_approved').length;

  // jsPDF's built-in fonts render only Latin-1; strip anything else to avoid mojibake
  const latin = (s: string) => s.normalize('NFKD').replace(/[^\u0000-\u00FF]/g, '').trim();

  const downloadPdf = () => {
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text('ROI Payout — Expense', 40, 40);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    const filterLabel = filter === 'coo_approved' ? 'Pending (CFO)' : filter === 'approved' ? 'All Approved' : 'Rejected';
    const rangeLabel = rangeFilter === 'today' ? 'Today'
      : rangeFilter === 'yesterday' ? 'Yesterday'
      : rangeFilter === 'last_week' ? 'Last week'
      : rangeFilter === 'this_month' ? 'This month'
      : dateFilter ? format(dateFilter, 'dd MMM yyyy')
      : 'All dates';
    doc.text(`Status: ${filterLabel}   ·   Period: ${rangeLabel}   ·   ${filtered.length} payout${filtered.length === 1 ? '' : 's'}   ·   Generated: ${format(new Date(), 'dd MMM yyyy, HH:mm')}`, 40, 56);

    const rows = filtered.map((op, index) => {
      const meta = op.metadata as Record<string, any> | null;
      const isAltWallet = op.operation_type === 'roi_split_alt_wallet';
      const isProxy = !!op.target_wallet_user_id && !isAltWallet;
      const reasonMatch = op.description?.match(/Reason:\s*(.*)$/i);
      const reason = latin(reasonMatch ? reasonMatch[1].trim() : '—');
      const settledAt = settlementMap.get(op.id);
      const payment = paymentStatus(op, isProxy, settledAt);
      return [
        String(index + 1),
        format(new Date(op.created_at), 'dd MMM yyyy HH:mm'),
        latin(meta?.partner_name || getName(op.user_id)),
        latin(isProxy ? (meta?.target_agent_name || getName(op.target_wallet_user_id))
            : isAltWallet ? (meta?.alt_recipient_name || getName(op.target_wallet_user_id))
            : 'Partner wallet'),
        op.source_id?.slice(0, 8) || '—',
        reason,
        formatUGX(op.amount),
        op.reference_id || '—',
        op.status === 'coo_approved' ? 'Awaiting CFO' : op.status === 'approved' ? 'Approved' : op.status === 'rejected' ? 'Rejected' : op.status,
        payment === 'paid' ? 'Paid' : payment === 'pending' ? 'Pending' : '—',
      ];
    });

    autoTable(doc, {
      startY: 70,
      head: [['#', 'Date', 'Partner', 'Paid to', 'Portfolio', 'Reason', 'Amount', 'Reference', 'CFO', 'Payment']],
      body: rows,
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [76, 29, 149], textColor: 255, fontStyle: 'bold' },
      columnStyles: {
        0: { cellWidth: 24, halign: 'right' },
        1: { cellWidth: 90 },
        5: { cellWidth: 110 },
        6: { cellWidth: 80, halign: 'right' },
        7: { cellWidth: 100 },
      },
      didDrawPage: () => {
        doc.setFontSize(8);
        doc.setTextColor(120);
        doc.text(`Welile · ROI Payout list · Page ${doc.getNumberOfPages()}`, pageWidth - 40, doc.internal.pageSize.getHeight() - 16, { align: 'right' });
        doc.setTextColor(0);
      },
    });

    doc.save(`roi-payouts-${format(new Date(), 'yyyy-MM-dd-HHmm')}.pdf`);
    toast.success(`PDF downloaded — ${filtered.length} payout${filtered.length === 1 ? '' : 's'}`);
  };


  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-primary" />
          ROI Payout — Expense
          {pendingCount > 0 && (
            <Badge variant="destructive" className="ml-2">{pendingCount} pending</Badge>
          )}
        </h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={downloadPdf} disabled={filtered.length === 0}>
            <Download className="h-3.5 w-3.5 mr-1" />
            Download PDF
          </Button>
          <Input
            placeholder="Search partner, agent, ref..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-60"
          />
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {(['coo_approved', 'approved', 'rejected'] as const).map(f => (
          <Button
            key={f}
            variant={filter === f ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter(f)}
          >
            {f === 'coo_approved' && <Clock className="h-3.5 w-3.5 mr-1" />}
            {f === 'approved' && <CheckCircle className="h-3.5 w-3.5 mr-1" />}
            {f === 'rejected' && <XCircle className="h-3.5 w-3.5 mr-1" />}
            {f === 'coo_approved' ? 'Pending' : f === 'approved' ? 'All Approved' : 'Rejected'}
          </Button>
        ))}
        <span className="w-px self-stretch bg-border mx-1" aria-hidden />
        {(['today', 'yesterday', 'last_week', 'this_month'] as const).map(r => (
          <Button
            key={r}
            variant={rangeFilter === r ? 'default' : 'outline'}
            size="sm"
            onClick={() => {
              setRangeFilter(prev => (prev === r ? null : r));
              setDateFilter(undefined);
            }}
          >
            {r === 'today' && 'Today'}
            {r === 'yesterday' && 'Yesterday'}
            {r === 'last_week' && 'Last week'}
            {r === 'this_month' && 'This month'}
          </Button>
        ))}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant={dateFilter ? 'default' : 'outline'}
              size="sm"
              className={cn(!dateFilter && 'text-muted-foreground font-normal')}
              onClick={() => setRangeFilter(null)}
            >
              <CalendarIcon className="h-3.5 w-3.5 mr-1" />
              {dateFilter ? format(dateFilter, 'dd MMM yyyy') : 'Filter by date'}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              selected={dateFilter}
              onSelect={setDateFilter}
              initialFocus
              className="p-3 pointer-events-auto"
            />
            {dateFilter && (
              <div className="border-t p-2 flex justify-end">
                <Button size="sm" variant="ghost" onClick={() => setDateFilter(undefined)}>
                  <X className="h-3.5 w-3.5 mr-1" /> Clear date
                </Button>
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-muted-foreground">No {filter === 'coo_approved' ? 'pending' : filter} ROI requests found.</CardContent></Card>
      ) : (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40">
                <TableHead className="w-10 text-right">#</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Partner</TableHead>
                <TableHead>Paid to</TableHead>
                <TableHead>Portfolio</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>CFO</TableHead>
                <TableHead>Payment</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((op, index) => {
                const meta = op.metadata as Record<string, any> | null;
                const isAltWallet = op.operation_type === 'roi_split_alt_wallet';
                const isProxy = !!op.target_wallet_user_id && !isAltWallet;
                const rejReason = rejectionReasons[op.id] || '';
                const reasonMatch = op.description?.match(/Reason:\s*(.*)$/i);
                const reason = reasonMatch ? reasonMatch[1].trim() : '—';
                const settledAt = settlementMap.get(op.id);
                const payment = paymentStatus(op, isProxy, settledAt);
                return (
                  <Fragment key={op.id}>
                    <TableRow className="align-top">
                      <TableCell className="text-right text-xs text-muted-foreground tabular-nums align-top">{index + 1}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {format(new Date(op.created_at), 'dd MMM yyyy')}<br />{format(new Date(op.created_at), 'HH:mm')}
                      </TableCell>
                      <TableCell className="font-medium">{meta?.partner_name || getName(op.user_id)}</TableCell>
                      <TableCell className="text-sm">
                        {isProxy ? (
                          <span>{meta?.target_agent_name || getName(op.target_wallet_user_id)}<span className="block text-xs text-muted-foreground">Proxy agent</span></span>
                        ) : isAltWallet ? (
                          <span>{meta?.alt_recipient_name || getName(op.target_wallet_user_id)}<span className="block text-xs text-muted-foreground">Different wallet</span></span>
                        ) : (
                          <span className="text-muted-foreground">Partner wallet</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{op.source_id?.slice(0, 8) || '—'}</TableCell>
                      <TableCell className="text-sm max-w-[160px] truncate" title={reason}>{reason}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums whitespace-nowrap">{formatUGX(op.amount)}</TableCell>
                      <TableCell className="font-mono text-xs whitespace-nowrap">{op.reference_id || '—'}</TableCell>
                      <TableCell>
                        <Badge variant={op.status === 'approved' ? 'default' : op.status === 'rejected' ? 'destructive' : 'secondary'} className="whitespace-nowrap">
                          {op.status === 'coo_approved' ? 'Awaiting CFO' : op.status === 'approved' ? 'Approved' : op.status === 'rejected' ? 'Rejected' : op.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {payment === 'paid' ? (
                          <Badge className="bg-success text-success-foreground hover:bg-success whitespace-nowrap"><CheckCircle className="h-3 w-3 mr-1" />Paid</Badge>
                        ) : payment === 'pending' ? (
                          <Badge variant="outline" className="border-warning text-warning whitespace-nowrap"><Clock className="h-3 w-3 mr-1" />Pending</Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                        {payment === 'paid' && settledAt && (
                          <span className="block text-[11px] text-muted-foreground mt-1">{format(new Date(settledAt), 'dd MMM, HH:mm')}</span>
                        )}
                      </TableCell>
                    </TableRow>
                    {op.status === 'coo_approved' && (
                      <TableRow key={op.id + '-actions'} className="bg-muted/20 hover:bg-muted/20">
                        <TableCell colSpan={10}>
                          <CfoApprovalGate>
                            <div className="space-y-2">
                              <TreasuryImpactBanner payoutAmount={op.amount} />
                              <div className="flex items-end gap-2 flex-wrap">
                                <Button size="sm" onClick={() => approveMutation.mutate(op.id)} disabled={approveMutation.isPending}>
                                  {approveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <CheckCircle className="h-3.5 w-3.5 mr-1" />}
                                  Approve
                                </Button>
                                <Textarea
                                  placeholder="Rejection reason (min 10 chars)..."
                                  value={rejReason}
                                  onChange={e => setRejectionReasons(prev => ({ ...prev, [op.id]: e.target.value }))}
                                  className="text-xs min-h-[36px] flex-1 min-w-[200px]"
                                  rows={1}
                                />
                                <Button size="sm" variant="destructive" disabled={rejReason.length < 10 || rejectMutation.isPending}
                                  onClick={() => rejectMutation.mutate({ opId: op.id, reason: rejReason })}>
                                  {rejectMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <XCircle className="h-3.5 w-3.5 mr-1" />}
                                  Reject
                                </Button>
                              </div>
                            </div>
                          </CfoApprovalGate>
                        </TableCell>
                      </TableRow>
                    )}
                    {op.status === 'rejected' && op.rejection_reason && (
                      <TableRow key={op.id + '-rej'} className="hover:bg-transparent">
                        <TableCell colSpan={10} className="text-xs text-destructive py-2">Reason: {op.rejection_reason}</TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
