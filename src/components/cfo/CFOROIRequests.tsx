import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { CheckCircle, XCircle, Clock, Loader2, TrendingUp, User, Wallet } from 'lucide-react';
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
        <div className="space-y-3">
          {filtered.map(op => {
            const meta = op.metadata as Record<string, any> | null;
            const isAltWallet = op.operation_type === 'roi_split_alt_wallet';
            const isProxy = !!op.target_wallet_user_id && !isAltWallet;
            const rejReason = rejectionReasons[op.id] || '';

            // Normalize legacy descriptions that still say "Agent Wallet" — money now lands in Partner Wallet.
            const displayDescription = op.description
              ? op.description
                  .replace(/\[Agent Wallet\]/gi, '[Partner Wallet via Proxy]')
                  .replace(/'s agent wallet/gi, "'s partner wallet (via proxy agent)")
                  .replace(/to agent wallet/gi, 'to partner wallet (via proxy agent)')
              : '';

            return (
              <Card key={op.id} className="border-l-4" style={{
                borderLeftColor: op.status === 'pending' ? 'hsl(var(--warning))' : op.status === 'approved' ? 'hsl(var(--primary))' : 'hsl(var(--destructive))',
              }}>
                <CardContent className="pt-4 space-y-3">
                  <div className="flex items-start justify-between flex-wrap gap-2">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <User className="h-4 w-4 text-muted-foreground" />
                        <span className="font-semibold">{meta?.partner_name || getName(op.user_id)}</span>
                        {isProxy && (
                          <>
                            <Badge variant="outline" className="text-xs">
                              <Wallet className="h-3 w-3 mr-1" />
                              Partner Wallet
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              via proxy: {meta?.target_agent_name || getName(op.target_wallet_user_id)}
                            </span>
                          </>
                        )}
                        {isAltWallet && (
                          <>
                            <Badge variant="outline" className="text-xs">
                              <Wallet className="h-3 w-3 mr-1" />
                              Different Wallet
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              to: {meta?.alt_recipient_name || getName(op.target_wallet_user_id)}
                            </span>
                          </>
                        )}
                      </div>
                      <p className="text-lg font-bold text-primary">{formatUGX(op.amount)}</p>
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(op.created_at), 'dd MMM yyyy, HH:mm')} · Ref: {op.reference_id || '—'}
                      </p>
                      {op.description && (
                        <p className="text-sm text-muted-foreground mt-1">{displayDescription}</p>
                      )}
                    </div>
                    <Badge variant={op.status === 'pending' ? 'secondary' : op.status === 'approved' ? 'default' : 'destructive'}>
                      {op.status}
                    </Badge>
                  </div>

                  {op.status === 'coo_approved' && (
                    <CfoApprovalGate>
                    <div className="space-y-3 pt-2 border-t">
                      <TreasuryImpactBanner payoutAmount={op.amount} />
                      <div className="flex items-end gap-2 flex-wrap">
                      <Button
                        size="sm"
                        onClick={() => approveMutation.mutate(op.id)}
                        disabled={approveMutation.isPending}
                      >
                        {approveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <CheckCircle className="h-3.5 w-3.5 mr-1" />}
                        Approve
                      </Button>
                      <div className="flex-1 min-w-[200px]">
                        <Textarea
                          placeholder="Rejection reason (min 10 chars)..."
                          value={rejReason}
                          onChange={e => setRejectionReasons(prev => ({ ...prev, [op.id]: e.target.value }))}
                          className="text-xs min-h-[36px]"
                          rows={1}
                        />
                      </div>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={rejReason.length < 10 || rejectMutation.isPending}
                        onClick={() => rejectMutation.mutate({ opId: op.id, reason: rejReason })}
                      >
                        {rejectMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <XCircle className="h-3.5 w-3.5 mr-1" />}
                        Reject
                      </Button>
                      </div>
                    </div>
                    </CfoApprovalGate>
                  )}

                  {op.status === 'rejected' && op.rejection_reason && (
                    <p className="text-sm text-destructive border-t pt-2">
                      <strong>Reason:</strong> {op.rejection_reason}
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
