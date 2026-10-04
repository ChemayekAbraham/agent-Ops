import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { History, Search, CheckCircle2, XCircle, User, Clock, Loader2 } from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { TenantOpsReportToolbar } from './TenantOpsReportToolbar';

const PIPELINE_STATUSES = [
  'tenant_ops_approved',
  'agent_verified',
  'landlord_ops_approved',
  'coo_approved',
  'funded',
  'disbursed',
  'rejected',
] as const;

const STATUS_META: Record<string, { label: string; color: string; icon: 'approve' | 'reject' }> = {
  tenant_ops_approved: { label: 'Tenant Ops Approved', color: 'bg-blue-100 text-blue-700', icon: 'approve' },
  agent_verified: { label: 'Agent Verified', color: 'bg-purple-100 text-purple-700', icon: 'approve' },
  landlord_ops_approved: { label: 'Landlord Ops Approved', color: 'bg-indigo-100 text-indigo-700', icon: 'approve' },
  coo_approved: { label: 'COO Approved', color: 'bg-emerald-100 text-emerald-700', icon: 'approve' },
  funded: { label: 'CFO Funded', color: 'bg-green-100 text-green-700', icon: 'approve' },
  disbursed: { label: 'Disbursed', color: 'bg-teal-100 text-teal-700', icon: 'approve' },
  rejected: { label: 'Rejected', color: 'bg-destructive/10 text-destructive', icon: 'reject' },
  approved: { label: 'Approved', color: 'bg-green-100 text-green-700', icon: 'approve' },
};

export function ApprovalHistoryLog() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const { data: history, isLoading } = useQuery({
    queryKey: ['approval-history', statusFilter],
    queryFn: async () => {
      // Status filtering happens in the database — filtering a fixed page of 100
      // rows client-side made single-status views look almost empty.
      const statuses = statusFilter === 'all'
        ? [...PIPELINE_STATUSES, 'approved', 'repaying', 'fully_repaid', 'defaulted']
        : [statusFilter];
      const { data, error } = await supabase
        .from('rent_requests')
        .select('id, tenant_id, agent_id, rent_amount, status, created_at, updated_at, house_category, request_city, approval_comment, rejected_reason, tenant_ops_reviewed_by, tenant_ops_reviewed_at, agent_verified_by, agent_verified_at, landlord_ops_reviewed_by, landlord_ops_reviewed_at, coo_reviewed_by, coo_reviewed_at, cfo_reviewed_by, cfo_reviewed_at, assigned_agent_id, payout_method, payout_transaction_reference')
        .in('status', statuses)
        .order('updated_at', { ascending: false })
        .limit(500);
      if (error) throw error;

      if (!data || data.length === 0) return [];

      // Collect all user IDs for name resolution
      const userIds = new Set<string>();
      data.forEach(r => {
        if (r.tenant_id) userIds.add(r.tenant_id);
        if (r.agent_id) userIds.add(r.agent_id);
        if (r.tenant_ops_reviewed_by) userIds.add(r.tenant_ops_reviewed_by);
        if (r.agent_verified_by) userIds.add(r.agent_verified_by);
        if (r.landlord_ops_reviewed_by) userIds.add(r.landlord_ops_reviewed_by);
        if (r.coo_reviewed_by) userIds.add(r.coo_reviewed_by);
        if (r.cfo_reviewed_by) userIds.add(r.cfo_reviewed_by);
      });

      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', [...userIds]);

      const nameMap = new Map((profiles || []).map(p => [p.id, p.full_name]));

      return data.map(r => ({
        ...r,
        tenant_name: nameMap.get(r.tenant_id) || 'Unknown',
        agent_name: r.agent_id ? (nameMap.get(r.agent_id) || 'Unknown') : null,
        reviewers: [
          r.tenant_ops_reviewed_at && { stage: 'Tenant Ops', by: nameMap.get(r.tenant_ops_reviewed_by!) || 'Staff', at: r.tenant_ops_reviewed_at },
          r.agent_verified_at && { stage: 'Agent Ops', by: nameMap.get(r.agent_verified_by!) || 'Staff', at: r.agent_verified_at },
          r.landlord_ops_reviewed_at && { stage: 'Landlord Ops', by: nameMap.get(r.landlord_ops_reviewed_by!) || 'Staff', at: r.landlord_ops_reviewed_at },
          r.coo_reviewed_at && { stage: 'COO', by: nameMap.get(r.coo_reviewed_by!) || 'Staff', at: r.coo_reviewed_at },
          r.cfo_reviewed_at && { stage: 'CFO', by: nameMap.get(r.cfo_reviewed_by!) || 'Staff', at: r.cfo_reviewed_at },
        ].filter(Boolean) as { stage: string; by: string; at: string }[],
      }));
    },
    staleTime: 30000,
  });

  const rows = history || [];
  const filtered = rows.filter(r => {
    const matchesSearch = !search ||
      r.tenant_name.toLowerCase().includes(search.toLowerCase()) ||
      (r.agent_name || '').toLowerCase().includes(search.toLowerCase());
    return matchesSearch;
  });

  return (
    <Card className="border border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base font-bold flex items-center gap-2">
            <History className="h-4 w-4" />
            Approval History
          </CardTitle>
          <Badge variant="secondary" className="text-xs font-bold">
            {filtered.length} records
          </Badge>
        </div>
        <div className="flex gap-2 mt-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search tenant or agent..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 h-9 text-sm"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[160px] h-9 text-sm">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              {PIPELINE_STATUSES.map(s => (
                <SelectItem key={s} value={s}>
                  {STATUS_META[s]?.label || s.replace(/_/g, ' ')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="px-4 pb-3">
          <TenantOpsReportToolbar
            tool="approval_history"
            status={statusFilter}
            search={search}
            visibleCount={filtered.length}
            fileSlug="tenant-approval-history"
          />
        </div>
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            No approval history found
          </div>
        ) : (
          <div className="divide-y divide-border max-h-[500px] overflow-y-auto">
            {filtered.map(req => {
              const meta = STATUS_META[req.status] || { label: req.status, color: 'bg-muted', icon: 'approve' as const };
              return (
                <div key={req.id} className="px-4 py-3 space-y-2">
                  {/* Header row */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {meta.icon === 'reject' ? (
                          <XCircle className="h-4 w-4 text-destructive shrink-0" />
                        ) : (
                          <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                        )}
                        <span className="font-semibold text-sm truncate">{req.tenant_name}</span>
                        <Badge className={`text-[10px] px-1.5 py-0 ${meta.color}`}>
                          {meta.label}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 ml-6">
                        UGX {Number(req.rent_amount || 0).toLocaleString()}
                        {req.request_city && ` · ${req.request_city}`}
                        {req.house_category && ` · ${req.house_category.replace(/_/g, ' ')}`}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[10px] text-muted-foreground">
                        {formatDistanceToNow(new Date(req.updated_at), { addSuffix: true })}
                      </p>
                    </div>
                  </div>

                  {/* Reviewer trail */}
                  {req.reviewers.length > 0 && (
                    <div className="ml-6 flex flex-wrap gap-x-4 gap-y-1">
                      {req.reviewers.map((rv, i) => (
                        <div key={i} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                          <User className="h-2.5 w-2.5" />
                          <span className="font-medium text-foreground">{rv.stage}:</span>
                          <span>{rv.by}</span>
                          <Clock className="h-2.5 w-2.5 ml-1" />
                          <span>{format(new Date(rv.at), 'dd MMM HH:mm')}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Rejection reason or comment */}
                  {req.status === 'rejected' && req.rejected_reason && (
                    <p className="ml-6 text-xs text-destructive bg-destructive/5 rounded px-2 py-1">
                      Reason: {req.rejected_reason}
                    </p>
                  )}
                  {req.approval_comment && (
                    <p className="ml-6 text-xs text-muted-foreground bg-muted/50 rounded px-2 py-1">
                      Note: {req.approval_comment}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
