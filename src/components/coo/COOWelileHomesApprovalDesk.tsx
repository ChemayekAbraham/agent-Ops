import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  Home,
  CheckCircle2,
  Clock,
  ShieldCheck,
  RefreshCw,
  Search,
  Building2,
  Users,
  RotateCcw,
  XCircle,
  Zap,
} from 'lucide-react';

interface FloatRequest {
  id: string;
  agent_id: string;
  requested_amount: number;
  reason: string | null;
  expected_recipient_phone: string | null;
  status: string;
  created_at: string;
  approved_at: string | null;
  approved_by: string | null;
  agent_name?: string;
  agent_phone?: string;
}

export function COOWelileHomesApprovalDesk() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [filterTab, setFilterTab] = useState<'pending_coo' | 'forwarded_to_cfo' | 'all'>('pending_coo');
  const [search, setSearch] = useState('');

  // Fetch Welile Homes float requests
  const { data: floatRequests = [], isLoading, refetch } = useQuery({
    queryKey: ['coo-welile-homes-float-requests'],
    queryFn: async (): Promise<FloatRequest[]> => {
      const { data, error } = await supabase
        .from('float_requests')
        .select('id, agent_id, requested_amount, reason, expected_recipient_phone, status, created_at, approved_at, approved_by')
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) throw error;
      const allRows = data ?? [];

      // Include by pipeline status, keyword, or active Welile Homes agents
      const { data: subs } = await supabase
        .from('welile_homes_subscriptions')
        .select('agent_id');
      const homesAgentIds = new Set((subs ?? []).map((s) => s.agent_id).filter(Boolean));

      const welileRows = allRows.filter((r) => {
        // Only include requests that have actually reached COO (cleared/approved by Tenant Ops).
        // Never show requests still waiting or pending at previous stages (Agent Ops or Tenant Ops)!
        const hasReachedCoo =
          ['tenant_ops_approved', 'coo_approved', 'approved', 'funded', 'disbursed'].includes(r.status) ||
          (r.status === 'rejected' && (r.rejection_reason || '').toLowerCase().includes('coo'));

        if (!hasReachedCoo) return false;

        const reason = (r.reason || '').toLowerCase();
        return (
          ['tenant_ops_approved', 'coo_approved'].includes(r.status) ||
          reason.includes('welile') ||
          reason.includes('homes') ||
          reason.includes('landlord') ||
          reason.includes('tenant') ||
          homesAgentIds.has(r.agent_id)
        );
      });

      if (welileRows.length === 0) return [];

      const agentIds = Array.from(new Set(welileRows.map((r) => r.agent_id).filter(Boolean)));
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', agentIds);

      const profileMap = new Map((profiles ?? []).map((p) => [p.id, p]));

      return welileRows.map((r) => ({
        ...r,
        agent_name: profileMap.get(r.agent_id)?.full_name || 'Agent',
        agent_phone: profileMap.get(r.agent_id)?.phone || r.expected_recipient_phone || '',
      }));
    },
    refetchInterval: 30_000,
  });

  // Action: Approve & Forward directly to CFO (Skips Partner Ops!)
  const approveMutation = useMutation({
    mutationFn: async (requestId: string) => {
      const { error } = await supabase
        .from('float_requests')
        .update({
          status: 'coo_approved',
          approved_by: user?.id,
          approved_at: new Date().toISOString(),
        })
        .eq('id', requestId);

      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Approved by COO and forwarded directly to CFO for disbursement');
      qc.invalidateQueries({ queryKey: ['coo-welile-homes-float-requests'] });
    },
    onError: (err: any) => {
      toast.error('Failed to forward to CFO: ' + (err.message || 'Unknown error'));
    },
  });

  // Action: Return to Tenant Ops
  const returnMutation = useMutation({
    mutationFn: async (requestId: string) => {
      const { error } = await supabase
        .from('float_requests')
        .update({
          status: 'agent_ops_approved',
          rejection_reason: 'Returned by COO to Tenant Ops for further verification',
        })
        .eq('id', requestId);

      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Returned request back to Tenant Ops');
      qc.invalidateQueries({ queryKey: ['coo-welile-homes-float-requests'] });
    },
    onError: (err: any) => {
      toast.error('Failed to return request: ' + (err.message || 'Unknown error'));
    },
  });

  // Action: Reject
  const rejectMutation = useMutation({
    mutationFn: async (requestId: string) => {
      const { error } = await supabase
        .from('float_requests')
        .update({
          status: 'rejected',
          rejection_reason: 'Rejected at COO executive review',
          approved_by: user?.id,
          approved_at: new Date().toISOString(),
        })
        .eq('id', requestId);

      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Request rejected');
      qc.invalidateQueries({ queryKey: ['coo-welile-homes-float-requests'] });
    },
    onError: (err: any) => {
      toast.error('Failed to reject: ' + (err.message || 'Unknown error'));
    },
  });

  const pendingCount = floatRequests.filter((r) => r.status === 'tenant_ops_approved').length;
  const forwardedCount = floatRequests.filter(
    (r) => r.status === 'coo_approved' || r.status === 'approved' || r.status === 'funded'
  ).length;
  const totalPendingAmount = floatRequests
    .filter((r) => r.status === 'tenant_ops_approved')
    .reduce((s, r) => s + (Number(r.requested_amount) || 0), 0);

  const filtered = floatRequests.filter((r) => {
    if (search.trim()) {
      const q = search.toLowerCase();
      const match =
        r.agent_name?.toLowerCase().includes(q) ||
        r.agent_phone?.includes(q) ||
        r.reason?.toLowerCase().includes(q);
      if (!match) return false;
    }

    if (filterTab === 'pending_coo') {
      return r.status === 'tenant_ops_approved';
    }
    if (filterTab === 'forwarded_to_cfo') {
      return r.status === 'coo_approved' || r.status === 'approved' || r.status === 'funded';
    }
    return true;
  });

  return (
    <div className="space-y-4">
      {/* KPI & Summary Banner */}
      <div className="p-4 sm:p-5 rounded-2xl border border-primary/30 bg-gradient-to-r from-primary/10 via-primary/5 to-transparent shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-primary text-primary-foreground shrink-0 shadow-md">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base font-bold text-foreground">
                  Welile Homes Executive Approvals
                </h2>
                <Badge className="bg-primary text-primary-foreground text-[10px]">
                  COO Stage
                </Badge>
                <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-600 flex items-center gap-1">
                  <Zap className="h-3 w-3" /> Partner Ops Bypassed
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Executive sign-off on agent landlord float requests cleared by Agent Ops and Tenant Ops. Your approval routes directly to the CFO for disbursement.
              </p>
            </div>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isLoading}
            className="gap-1.5 text-xs font-semibold self-end sm:self-center"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
            Refresh
          </Button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-3 pt-3 mt-3 border-t border-border/50">
          <div className="p-3 rounded-xl bg-background/60 border border-border/40">
            <span className="text-[11px] text-muted-foreground block font-medium">Pending COO Sign-Off</span>
            <span className="text-lg font-bold text-amber-600 dark:text-amber-400 tabular-nums">
              {pendingCount}
            </span>
            <span className="text-[10px] text-muted-foreground block">Cleared by Tenant Ops</span>
          </div>

          <div className="p-3 rounded-xl bg-background/60 border border-border/40">
            <span className="text-[11px] text-muted-foreground block font-medium">Float Volume Pending</span>
            <span className="text-lg font-bold text-foreground tabular-nums">
              {formatUGX(totalPendingAmount)}
            </span>
            <span className="text-[10px] text-muted-foreground block">Across pending requests</span>
          </div>

          <div className="p-3 rounded-xl bg-background/60 border border-border/40">
            <span className="text-[11px] text-muted-foreground block font-medium">Forwarded to CFO</span>
            <span className="text-lg font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
              {forwardedCount}
            </span>
            <span className="text-[10px] text-muted-foreground block">Approved for disbursement</span>
          </div>
        </div>
      </div>

      {/* Tabs & Search */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
          <button
            type="button"
            onClick={() => setFilterTab('pending_coo')}
            className={cn(
              'px-3 py-1.5 rounded-full text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer shrink-0',
              filterTab === 'pending_coo'
                ? 'bg-amber-600 text-white font-bold shadow-xs'
                : 'bg-muted text-muted-foreground hover:text-foreground border border-border/40'
            )}
          >
            <Clock className="h-3.5 w-3.5" />
            Awaiting COO Sign-Off ({pendingCount})
          </button>

          <button
            type="button"
            onClick={() => setFilterTab('forwarded_to_cfo')}
            className={cn(
              'px-3 py-1.5 rounded-full text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer shrink-0',
              filterTab === 'forwarded_to_cfo'
                ? 'bg-emerald-600 text-white font-bold shadow-xs'
                : 'bg-muted text-muted-foreground hover:text-foreground border border-border/40'
            )}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Forwarded to CFO ({forwardedCount})
          </button>

          <button
            type="button"
            onClick={() => setFilterTab('all')}
            className={cn(
              'px-3 py-1.5 rounded-full text-xs font-medium transition-all cursor-pointer shrink-0',
              filterTab === 'all'
                ? 'bg-foreground text-background font-bold shadow-xs'
                : 'bg-muted text-muted-foreground hover:text-foreground border border-border/40'
            )}
          >
            All Requests ({floatRequests.length})
          </button>
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search agent name, phone..."
            className="pl-8 h-9 text-xs rounded-xl bg-background"
          />
        </div>
      </div>

      {/* Cards List */}
      <div className="space-y-3">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <Skeleton key={i} className="h-28 w-full rounded-2xl" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <Card className="rounded-2xl p-8 text-center border-dashed border-border/70">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary mb-3">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <p className="text-sm font-semibold text-foreground">
              {filterTab === 'pending_coo'
                ? 'No requests awaiting COO sign-off'
                : 'No requests found for this filter'}
            </p>
            <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
              Requests verified by Tenant Ops will appear here for executive approval before routing directly to CFO.
            </p>
          </Card>
        ) : (
          filtered.map((req) => {
            const isPendingCoo = req.status === 'tenant_ops_approved';
            const isForwardedToCfo =
              req.status === 'coo_approved' || req.status === 'approved' || req.status === 'funded';

            return (
              <Card
                key={req.id}
                className={cn(
                  'rounded-2xl border p-4 sm:p-5 transition-all shadow-2xs',
                  isPendingCoo ? 'border-amber-500/40 bg-card hover:border-amber-500/60' : 'border-border/70 bg-card'
                )}
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3.5">
                  <div className="flex items-start sm:items-center gap-3.5 min-w-0">
                    <div
                      className={cn(
                        'p-2.5 rounded-xl shrink-0',
                        isPendingCoo
                          ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                          : isForwardedToCfo
                          ? 'bg-emerald-500/10 text-emerald-600'
                          : 'bg-muted text-muted-foreground'
                      )}
                    >
                      <Building2 className="h-5 w-5" />
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-sm sm:text-base text-foreground">
                          {req.agent_name}
                        </span>
                        {req.agent_phone && (
                          <span className="text-xs text-muted-foreground">({req.agent_phone})</span>
                        )}

                        {isPendingCoo && (
                          <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30 text-[10px]">
                            Stage 3: Ready for COO Approval
                          </Badge>
                        )}
                        {isForwardedToCfo && (
                          <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 text-[10px]">
                            Stage 4: Forwarded to CFO
                          </Badge>
                        )}
                      </div>

                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                        {req.reason || 'Welile Homes landlord float requisition'}
                      </p>

                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground mt-2 flex-wrap">
                        <span className="font-semibold text-foreground">
                          Float: {formatUGX(req.requested_amount)}
                        </span>
                        <span>•</span>
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium">✓ Agent Ops Vetted</span>
                        <span>•</span>
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium">✓ Tenant Ops Cleared</span>
                        <span>•</span>
                        <span className="text-purple-600 dark:text-purple-400 font-medium">⚡ Skips Partner Ops</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 self-end sm:self-center shrink-0 flex-wrap">
                    {isPendingCoo && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => returnMutation.mutate(req.id)}
                          disabled={returnMutation.isPending}
                          className="gap-1 text-xs h-9 text-muted-foreground"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          Return to Tenant Ops
                        </Button>

                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => rejectMutation.mutate(req.id)}
                          disabled={rejectMutation.isPending}
                          className="gap-1 text-xs h-9 text-destructive hover:bg-destructive/10"
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          Reject
                        </Button>

                        <Button
                          size="sm"
                          onClick={() => approveMutation.mutate(req.id)}
                          disabled={approveMutation.isPending}
                          className="gap-1.5 text-xs h-9 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow-xs"
                        >
                          {approveMutation.isPending ? (
                            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          )}
                          Approve & Forward to CFO
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
