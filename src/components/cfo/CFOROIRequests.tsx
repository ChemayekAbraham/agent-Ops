import { useState, useEffect, useMemo, Fragment } from 'react';\nimport { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { CheckCircle, XCircle, Clock, Loader2, TrendingUp } from 'lucide-react';
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
  const [filter, setFilter] = useState<'coo_approved' | 'approved' | 'rejected' | 'all'>('coo_approved');
  const [search, setSearch] = useState('');

  const { data: operations = [], isLoading } = useQuery({
    queryKey: ['cfo-roi-requests', filter],
    queryFn: async () => {
      let query = supabase
        .from('pending_wallet_operations')
        .select('*')
        .eq('category', 'roi_payout')
        .order('created_at', { ascending: false })
        .limit(100);

      if (filter !== 'all') {
        query = query.eq('status', filter);
      }

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
        <Input
          placeholder="Search partner, agent, ref..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-60"
        />
      </div>

      <div className="flex gap-2 flex-wrap">
        {(['coo_approved', 'approved', 'rejected', 'all'] as const).map(f => (
          <Button
            key={f}
            variant={filter === f ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter(f)}
          >
            {f === 'coo_approved' && <Clock className="h-3.5 w-3.5 mr-1" />}
            {f === 'approved' && <CheckCircle className="h-3.5 w-3.5 mr-1" />}
            {f === 'rejected' && <XCircle className="h-3.5 w-3.5 mr-1" />}
            {f === 'coo_approved' ? 'Pending' : f.charAt(0).toUpperCase() + f.slice(1)}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-muted-foreground">No {filter !== 'all' ? filter : ''} ROI requests found.</CardContent></Card>
      ) : (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40">
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
              {filtered.map(op => {
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
                        <TableCell colSpan={9}>
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
                        <TableCell colSpan={9} className="text-xs text-destructive py-2">Reason: {op.rejection_reason}</TableCell>
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
