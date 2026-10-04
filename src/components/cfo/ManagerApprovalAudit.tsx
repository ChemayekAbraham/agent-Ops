import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CompactAmount } from '@/components/ui/CompactAmount';
import { ShieldCheck, Users, CheckCircle, XCircle } from 'lucide-react';
import { format, startOfDay, startOfWeek, startOfMonth, isAfter } from 'date-fns';

type DateRange = 'today' | 'week' | 'month' | 'all';
type StatusFilter = 'all' | 'approved' | 'rejected';

export function ManagerApprovalAudit() {
  const [dateRange, setDateRange] = useState<DateRange>('month');
  const [managerFilter, setManagerFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  // Fetch reviewed operations
  const { data: operations = [], isLoading } = useQuery({
    queryKey: ['approval-audit-ops'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('pending_wallet_operations')
        .select('id, amount, status, category, description, operation_type, reviewed_by, reviewed_at, created_at')
        .in('status', ['approved', 'rejected'])
        .not('reviewed_by', 'is', null)
        .order('reviewed_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
  });

  // Fetch profiles for reviewer names (decoupled pattern)
  const reviewerIds = useMemo(
    () => [...new Set(operations.map((o) => o.reviewed_by).filter(Boolean))] as string[],
    [operations],
  );

  const { data: profiles = [] } = useQuery({
    queryKey: ['approval-audit-profiles', reviewerIds],
    enabled: reviewerIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', reviewerIds);
      if (error) throw error;
      return data || [];
    },
  });

  // Fetch roles for reviewers
  const { data: roles = [] } = useQuery({
    queryKey: ['approval-audit-roles', reviewerIds],
    enabled: reviewerIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('user_roles')
        .select('user_id, role')
        .in('user_id', reviewerIds);
      if (error) throw error;
      return data || [];
    },
  });

  const profileMap = useMemo(
    () => Object.fromEntries(profiles.map((p) => [p.id, p.full_name || 'Unknown'])),
    [profiles],
  );

  const roleMap = useMemo(
    () => Object.fromEntries(roles.map((r) => [r.user_id, r.role])),
    [roles],
  );

  // Date filter
  const cutoffDate = useMemo(() => {
    const now = new Date();
    switch (dateRange) {
      case 'today': return startOfDay(now);
      case 'week': return startOfWeek(now, { weekStartsOn: 1 });
      case 'month': return startOfMonth(now);
      default: return null;
    }
  }, [dateRange]);

  const filtered = useMemo(() => {
    return operations.filter((op) => {
      if (cutoffDate && op.reviewed_at && !isAfter(new Date(op.reviewed_at), cutoffDate)) return false;
      if (managerFilter !== 'all' && op.reviewed_by !== managerFilter) return false;
      if (statusFilter !== 'all' && op.status !== statusFilter) return false;
      return true;
    });
  }, [operations, cutoffDate, managerFilter, statusFilter]);

  // Summary metrics
  const todayStart = startOfDay(new Date());
  const approvedToday = operations.filter(
    (o) => o.status === 'approved' && o.reviewed_at && isAfter(new Date(o.reviewed_at), todayStart),
  );
  const totalApprovedToday = approvedToday.reduce((s, o) => s + (o.amount || 0), 0);
  const totalReviewed = operations.length;
  const uniqueApprovers = reviewerIds.length;
  const approvedCount = operations.filter((o) => o.status === 'approved').length;
  const rejectedCount = operations.filter((o) => o.status === 'rejected').length;
  const approvalPct = totalReviewed > 0 ? Math.round((approvedCount / totalReviewed) * 100) : 0;

  // Distinct managers for filter dropdown
  const managerOptions = useMemo(
    () => reviewerIds.map((id) => ({ id, name: profileMap[id] || id.slice(0, 8) })),
    [reviewerIds, profileMap],
  );

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">🛡️ Manager Approval Audit</h1>
      <p className="text-sm text-muted-foreground">
        Track every financial approval — who approved it, when, and how much.
      </p>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
              <CheckCircle className="h-3.5 w-3.5 text-emerald-500" /> Approved Today
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CompactAmount value={totalApprovedToday} className="text-lg font-bold" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5 text-primary" /> Total Reviewed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-bold">{totalReviewed}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
              <Users className="h-3.5 w-3.5 text-primary" /> Unique Approvers
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-bold">{uniqueApprovers}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
              <XCircle className="h-3.5 w-3.5 text-destructive" /> Approval Rate
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-bold">
              {approvalPct}%{' '}
              <span className="text-xs font-normal text-muted-foreground">
                ({approvedCount}✓ / {rejectedCount}✗)
              </span>
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <Select value={dateRange} onValueChange={(v) => setDateRange(v as DateRange)}>
          <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="today">Today</SelectItem>
            <SelectItem value="week">This Week</SelectItem>
            <SelectItem value="month">This Month</SelectItem>
            <SelectItem value="all">All Time</SelectItem>
          </SelectContent>
        </Select>

        <Select value={managerFilter} onValueChange={setManagerFilter}>
          <SelectTrigger className="w-[180px]"><SelectValue placeholder="All Managers" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Managers</SelectItem>
            {managerOptions.map((m) => (
              <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
          <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table (desktop) */}
      {isLoading ? (
        <p className="text-sm text-muted-foreground py-8 text-center">Loading audit data…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">No reviewed operations found.</p>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block rounded-xl border overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Amount</TableHead>
                  <TableHead>Approved By</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Approved At</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Description</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((op) => (
                  <TableRow key={op.id}>
                    <TableCell className="font-medium">
                      <CompactAmount value={op.amount || 0} />
                    </TableCell>
                    <TableCell>{profileMap[op.reviewed_by!] || '—'}</TableCell>
                    <TableCell className="capitalize">{roleMap[op.reviewed_by!] || '—'}</TableCell>
                    <TableCell className="text-xs">
                      {op.reviewed_at ? format(new Date(op.reviewed_at), 'dd MMM yyyy HH:mm') : '—'}
                    </TableCell>
                    <TableCell className="text-xs capitalize">{op.category || op.operation_type || '—'}</TableCell>
                    <TableCell>
                      <Badge variant={op.status === 'approved' ? 'default' : 'destructive'}>
                        {op.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate text-xs">
                      {op.description || '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-3">
            {filtered.map((op) => (
              <Card key={op.id}>
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <CompactAmount value={op.amount || 0} className="font-bold" />
                    <Badge variant={op.status === 'approved' ? 'default' : 'destructive'}>
                      {op.status}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground space-y-0.5">
                    <p>By: {profileMap[op.reviewed_by!] || '—'} ({roleMap[op.reviewed_by!] || '—'})</p>
                    <p>At: {op.reviewed_at ? format(new Date(op.reviewed_at), 'dd MMM yyyy HH:mm') : '—'}</p>
                    <p>Category: {op.category || op.operation_type || '—'}</p>
                    {op.description && <p className="truncate">{op.description}</p>}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
