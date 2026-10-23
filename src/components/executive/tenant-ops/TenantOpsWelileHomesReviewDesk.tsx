import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  Home,
  UserCheck,
  Search,
  CheckCircle2,
  Clock,
  ArrowRight,
  ShieldCheck,
  AlertCircle,
  RefreshCw,
  Phone,
  Building2,
  Users,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Sparkles,
  Smartphone,
  ArrowLeft,
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
  rejection_reason: string | null;
  agent_name?: string;
  agent_phone?: string;
}

interface TenantItem {
  id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_phone: string;
  monthly_rent: number;
  outstanding_balance: number;
  landlord_name: string;
  landlord_phone: string;
  has_smartphone: boolean;
  subscription_status: string;
}

interface Props {
  onBack?: () => void;
}

export function TenantOpsWelileHomesReviewDesk({ onBack }: Props) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [filterTab, setFilterTab] = useState<'pending_tenant_ops' | 'sent_to_coo' | 'all'>('pending_tenant_ops');
  const [search, setSearch] = useState('');
  const [expandedRequestId, setExpandedRequestId] = useState<string | null>(null);

  // Fetch Welile Homes float requests
  const { data: floatRequests = [], isLoading, refetch } = useQuery({
    queryKey: ['tenant-ops-welile-homes-float-requests'],
    queryFn: async (): Promise<FloatRequest[]> => {
      const { data, error } = await supabase
        .from('float_requests')
        .select('id, agent_id, requested_amount, reason, expected_recipient_phone, status, created_at, approved_at, rejection_reason')
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
        // Only include requests that have actually reached Tenant Ops (cleared/approved by Agent Ops).
        // Never show requests still waiting or pending at a previous stage!
        const hasReachedTenantOps =
          ['agent_ops_approved', 'tenant_ops_approved', 'coo_approved', 'approved', 'funded', 'disbursed'].includes(r.status) ||
          (r.status === 'rejected' && (r.rejection_reason || '').toLowerCase().includes('tenant ops'));

        if (!hasReachedTenantOps) return false;

        const reason = (r.reason || '').toLowerCase();
        return (
          ['agent_ops_approved', 'tenant_ops_approved', 'coo_approved'].includes(r.status) ||
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

  // Fetch tenants attached to the expanded agent's request
  const expandedAgentId = floatRequests.find((r) => r.id === expandedRequestId)?.agent_id;
  const { data: attachedTenants = [], isLoading: tenantsLoading } = useQuery({
    queryKey: ['tenant-ops-welile-attached-tenants', expandedAgentId],
    enabled: !!expandedAgentId,
    queryFn: async (): Promise<TenantItem[]> => {
      const { data: subs, error } = await supabase
        .from('welile_homes_subscriptions')
        .select('id, tenant_id, monthly_rent, outstanding_balance, landlord_name, landlord_phone, has_smartphone, subscription_status')
        .eq('agent_id', expandedAgentId!)
        .eq('mode', 'agent_collection')
        .order('created_at', { ascending: false });

      if (error) throw error;
      if (!subs || subs.length === 0) return [];

      const tIds = Array.from(new Set(subs.map((s) => s.tenant_id).filter(Boolean)));
      const { data: tProfiles } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', tIds);

      const tMap = new Map((tProfiles ?? []).map((p) => [p.id, p]));

      return subs.map((s) => {
        const p = tMap.get(s.tenant_id);
        return {
          id: s.id,
          tenant_id: s.tenant_id,
          tenant_name: p?.full_name || 'Tenant',
          tenant_phone: p?.phone || 'No phone',
          monthly_rent: Number(s.monthly_rent) || 0,
          outstanding_balance: Number(s.outstanding_balance) || 0,
          landlord_name: s.landlord_name || 'Landlord',
          landlord_phone: s.landlord_phone || '',
          has_smartphone: !!s.has_smartphone,
          subscription_status: s.subscription_status || 'active',
        };
      });
    },
  });

  // Action: Approve & Forward to COO (Skips Partner Ops!)
  const approveMutation = useMutation({
    mutationFn: async (requestId: string) => {
      const { error } = await supabase
        .from('float_requests')
        .update({
          status: 'tenant_ops_approved',
          approved_by: user?.id,
          approved_at: new Date().toISOString(),
        })
        .eq('id', requestId);

      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Float request approved and forwarded directly to COO');
      qc.invalidateQueries({ queryKey: ['tenant-ops-welile-homes-float-requests'] });
    },
    onError: (err: any) => {
      toast.error('Failed to forward to COO: ' + (err.message || 'Unknown error'));
    },
  });

  // Action: Return to Agent Ops
  const returnMutation = useMutation({
    mutationFn: async (requestId: string) => {
      const { error } = await supabase
        .from('float_requests')
        .update({
          status: 'pending',
          rejection_reason: 'Returned by Tenant Ops for agent review',
        })
        .eq('id', requestId);

      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Returned request back to Agent Ops');
      qc.invalidateQueries({ queryKey: ['tenant-ops-welile-homes-float-requests'] });
    },
    onError: (err: any) => {
      toast.error('Failed to return request: ' + (err.message || 'Unknown error'));
    },
  });

  // Filter requests according to active tab
  const filteredRequests = floatRequests.filter((r) => {
    // Search query filter
    if (search.trim()) {
      const q = search.toLowerCase();
      const matchSearch =
        r.agent_name?.toLowerCase().includes(q) ||
        r.agent_phone?.includes(q) ||
        r.reason?.toLowerCase().includes(q);
      if (!matchSearch) return false;
    }

    if (filterTab === 'pending_tenant_ops') {
      return r.status === 'agent_ops_approved';
    }
    if (filterTab === 'sent_to_coo') {
      return r.status === 'tenant_ops_approved' || r.status === 'coo_approved' || r.status === 'approved' || r.status === 'funded';
    }
    return true;
  });

  const pendingCount = floatRequests.filter((r) => r.status === 'agent_ops_approved').length;
  const sentCount = floatRequests.filter(
    (r) => r.status === 'tenant_ops_approved' || r.status === 'coo_approved' || r.status === 'approved' || r.status === 'funded'
  ).length;
  const totalVolume = floatRequests.reduce((sum, r) => sum + (Number(r.requested_amount) || 0), 0);

  return (
    <div className="space-y-4">
      {/* Top Banner & Header */}
      <div className="p-4 sm:p-5 rounded-2xl border border-primary/30 bg-gradient-to-r from-primary/10 via-primary/5 to-transparent shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2.5 sm:p-3 rounded-2xl bg-primary text-primary-foreground shrink-0 shadow-md">
              <Home className="h-5 w-5 sm:h-6 sm:w-6" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-base sm:text-lg font-bold text-foreground truncate">
                  Welile Homes · Tenant Vetting Desk
                </h1>
                <Badge className="bg-primary text-primary-foreground text-[10px] px-2 py-0.5">
                  Tenant Ops Stage
                </Badge>
                {pendingCount > 0 && (
                  <Badge variant="destructive" className="text-[10px] px-2 py-0.5 animate-pulse font-medium">
                    {pendingCount} Awaiting Review
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Verify enrolled tenants on agent landlord float requests. Once cleared, requests advance directly to the COO (Partner Ops bypassed).
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {onBack && (
              <Button
                variant="outline"
                size="sm"
                onClick={onBack}
                className="gap-1.5 text-xs font-semibold"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to Home
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isLoading}
              className="gap-1.5 text-xs font-semibold"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </div>

        {/* 3 KPI Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-3 pt-3 mt-3 border-t border-border/50">
          <div className="p-3 rounded-xl bg-background/60 border border-border/40">
            <span className="text-[11px] text-muted-foreground block font-medium">Pending Tenant Ops Review</span>
            <span className="text-lg font-bold text-amber-600 dark:text-amber-400 tabular-nums">
              {pendingCount}
            </span>
            <span className="text-[10px] text-muted-foreground block">Cleared by Agent Ops, awaiting tenant vetting</span>
          </div>

          <div className="p-3 rounded-xl bg-background/60 border border-border/40">
            <span className="text-[11px] text-muted-foreground block font-medium">Forwarded to COO</span>
            <span className="text-lg font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
              {sentCount}
            </span>
            <span className="text-[10px] text-muted-foreground block">Advanced to COO executive approval</span>
          </div>

          <div className="p-3 rounded-xl bg-background/60 border border-border/40">
            <span className="text-[11px] text-muted-foreground block font-medium">Total Welile Homes Float</span>
            <span className="text-lg font-bold text-foreground tabular-nums">
              {formatUGX(totalVolume)}
            </span>
            <span className="text-[10px] text-muted-foreground block">Across all agent requests</span>
          </div>
        </div>
      </div>

      {/* Filter Tabs & Search Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
          <button
            type="button"
            onClick={() => setFilterTab('pending_tenant_ops')}
            className={cn(
              'px-3 py-1.5 rounded-full text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer shrink-0',
              filterTab === 'pending_tenant_ops'
                ? 'bg-amber-600 text-white font-bold shadow-xs'
                : 'bg-muted text-muted-foreground hover:text-foreground border border-border/40'
            )}
          >
            <Clock className="h-3.5 w-3.5" />
            Ready for Tenant Review ({pendingCount})
          </button>

          <button
            type="button"
            onClick={() => setFilterTab('sent_to_coo')}
            className={cn(
              'px-3 py-1.5 rounded-full text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer shrink-0',
              filterTab === 'sent_to_coo'
                ? 'bg-emerald-600 text-white font-bold shadow-xs'
                : 'bg-muted text-muted-foreground hover:text-foreground border border-border/40'
            )}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Sent to COO ({sentCount})
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

      {/* Requests List */}
      <div className="space-y-3">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28 w-full rounded-2xl" />
            ))}
          </div>
        ) : filteredRequests.length === 0 ? (
          <Card className="rounded-2xl p-8 text-center border-dashed border-border/70">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary mb-3">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <p className="text-sm font-semibold text-foreground">
              {filterTab === 'pending_tenant_ops'
                ? 'No float requests currently awaiting Tenant Ops review'
                : 'No requests match your current filter'}
            </p>
            <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
              {filterTab === 'pending_tenant_ops'
                ? 'When Agent Ops clears an agent landlord float request, it will appear here for tenant verification before proceeding directly to the COO.'
                : 'Try adjusting your search or tab filters above.'}
            </p>
          </Card>
        ) : (
          filteredRequests.map((req) => {
            const isExpanded = expandedRequestId === req.id;
            const isPendingTenantOps = req.status === 'agent_ops_approved';
            const isSentToCoo = req.status === 'tenant_ops_approved';

            return (
              <Card
                key={req.id}
                className={cn(
                  'rounded-2xl border transition-all overflow-hidden shadow-2xs',
                  isPendingTenantOps
                    ? 'border-amber-500/40 bg-card hover:border-amber-500/60'
                    : 'border-border/70 bg-card'
                )}
              >
                <div className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3.5">
                  <div className="flex items-start sm:items-center gap-3.5 min-w-0">
                    <div
                      className={cn(
                        'p-2.5 rounded-xl shrink-0',
                        isPendingTenantOps
                          ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                          : isSentToCoo
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

                        {isPendingTenantOps && (
                          <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30 text-[10px]">
                            Stage 2: Awaiting Tenant Ops
                          </Badge>
                        )}
                        {isSentToCoo && (
                          <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 text-[10px]">
                            Stage 3: Forwarded to COO
                          </Badge>
                        )}
                      </div>

                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                        {req.reason || 'Welile Homes landlord float requisition'}
                      </p>

                      <div className="flex items-center gap-3 text-[11px] text-muted-foreground mt-1.5 flex-wrap">
                        <span>Submitted {new Date(req.created_at).toLocaleDateString('en-GB')}</span>
                        <span>•</span>
                        <span className="font-semibold text-foreground">
                          Requested Float: {formatUGX(req.requested_amount)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 self-end sm:self-center shrink-0 flex-wrap">
                    {/* Expand Button to Inspect Attached Tenants */}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setExpandedRequestId(isExpanded ? null : req.id)}
                      className="gap-1.5 text-xs h-9"
                    >
                      <Users className="h-3.5 w-3.5" />
                      <span>{isExpanded ? 'Hide Tenants' : 'Inspect Tenants'}</span>
                      {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    </Button>

                    {/* Action: Approve and Forward to COO */}
                    {isPendingTenantOps && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => returnMutation.mutate(req.id)}
                          disabled={returnMutation.isPending}
                          className="gap-1 text-xs h-9 text-muted-foreground hover:text-destructive"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          Return to Agent Ops
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
                          Approve & Forward to COO
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                {/* Expanded Attached Tenants Inspection Panel */}
                {isExpanded && (
                  <div className="p-4 pt-2 border-t border-border/50 bg-muted/20">
                    <div className="mb-2 flex items-center justify-between">
                      <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider flex items-center gap-1.5">
                        <Users className="h-3.5 w-3.5 text-primary" />
                        Attached Enrolled Tenants for this Agent ({attachedTenants.length})
                      </h4>
                      <span className="text-[11px] text-muted-foreground">
                        Review tenant identity & repayment compliance
                      </span>
                    </div>

                    {tenantsLoading ? (
                      <div className="py-4 text-center text-xs text-muted-foreground">
                        Loading attached tenant profiles...
                      </div>
                    ) : attachedTenants.length === 0 ? (
                      <div className="py-4 text-center text-xs text-muted-foreground">
                        No active enrolled tenant subscriptions found under this agent.
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                        {attachedTenants.map((t) => (
                          <div
                            key={t.id}
                            className="p-3 rounded-xl border border-border/70 bg-card flex flex-col justify-between gap-2"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <p className="font-bold text-xs text-foreground">{t.tenant_name}</p>
                                <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
                                  <Phone className="h-3 w-3" />
                                  {t.tenant_phone}
                                </p>
                              </div>
                              <Badge variant="outline" className="text-[10px] font-semibold">
                                {formatUGX(t.monthly_rent)}/mo
                              </Badge>
                            </div>

                            <div className="text-[11px] text-muted-foreground pt-1.5 border-t border-border/40 flex items-center justify-between">
                              <span>Landlord: <b className="text-foreground">{t.landlord_name}</b></span>
                              {t.has_smartphone ? (
                                <span className="text-emerald-600 dark:text-emerald-400 flex items-center gap-0.5 text-[10px]">
                                  <Smartphone className="h-3 w-3" /> App user
                                </span>
                              ) : (
                                <span className="text-muted-foreground text-[10px]">Feature phone</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
