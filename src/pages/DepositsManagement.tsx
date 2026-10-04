import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  ArrowLeft,
  Wallet,
  Check,
  X,
  Loader2,
  User,
  Phone,
  Calendar as CalendarIcon,
  Filter,
  ChevronLeft,
  ChevronRight,
  Download,
  RefreshCw,
  Search,
  ClipboardList,
  CheckSquare,
  Square,
  CheckCheck,
} from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { format, startOfDay, endOfDay } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';
import { exportToCSV, formatDateForExport } from '@/lib/exportUtils';
import { cn } from '@/lib/utils';
import { AuditLogViewer } from '@/components/manager/AuditLogViewer';
import ScreenLoader from '@/components/common/ScreenLoader';

interface DepositRequest {
  id: string;
  user_id: string;
  agent_id: string;
  amount: number;
  status: string;
  created_at: string;
  approved_at: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  processed_by: string | null;
  transaction_id: string | null;
  provider: string | null;
  notes: string | null;
  user_name?: string;
  user_phone?: string;
  agent_name?: string;
  processed_by_name?: string;
}

interface Agent {
  id: string;
  full_name: string;
}

const PAGE_SIZE = 50;

export default function DepositsManagement() {
  const { user, role, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Data state
  const [deposits, setDeposits] = useState<DepositRequest[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);

  // Filter state
  const [statusFilter, setStatusFilter] = useState<string>(searchParams.get('status') || 'all');
  const [agentFilter, setAgentFilter] = useState<string>(searchParams.get('agent') || 'all');
  const [minAmount, setMinAmount] = useState<string>(searchParams.get('minAmount') || '');
  const [maxAmount, setMaxAmount] = useState<string>(searchParams.get('maxAmount') || '');
  const [startDate, setStartDate] = useState<Date | undefined>(
    searchParams.get('startDate') ? new Date(searchParams.get('startDate')!) : undefined
  );
  const [endDate, setEndDate] = useState<Date | undefined>(
    searchParams.get('endDate') ? new Date(searchParams.get('endDate')!) : undefined
  );
  const [searchQuery, setSearchQuery] = useState<string>(searchParams.get('q') || '');
  const [debouncedSearch, setDebouncedSearch] = useState(searchQuery);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  // Pagination
  const [page, setPage] = useState(Number(searchParams.get('page')) || 1);

  // Processing state
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
  const [rejectDialog, setRejectDialog] = useState<{ open: boolean; deposit: DepositRequest | null; isBulk?: boolean }>({
    open: false,
    deposit: null,
    isBulk: false,
  });
  const [rejectionReason, setRejectionReason] = useState('');
  const [approveDialog, setApproveDialog] = useState<{ open: boolean; deposit: DepositRequest | null }>({ open: false, deposit: null });
  const [approveTid, setApproveTid] = useState('');

  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkProcessing, setBulkProcessing] = useState(false);

  const pendingDeposits = deposits.filter(d => d.status === 'pending');
  const allPendingSelected = pendingDeposits.length > 0 && pendingDeposits.every(d => selectedIds.has(d.id));
  const somePendingSelected = pendingDeposits.some(d => selectedIds.has(d.id));
  const selectedPendingCount = pendingDeposits.filter(d => selectedIds.has(d.id)).length;

  // Redirect non-managers
  useEffect(() => {
    if (!authLoading && (!user || role !== 'manager')) {
      navigate(roleToSlug(role));
    }
  }, [user, role, authLoading, navigate]);

  // Fetch agents for filter
  useEffect(() => {
    const fetchAgents = async () => {
      const { data } = await supabase
        .from('user_roles')
        .select('user_id')
        .eq('role', 'agent');

      if (data && data.length > 0) {
        const agentIds = data.map(r => r.user_id);
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', agentIds);

        setAgents(profiles?.map(p => ({ id: p.id, full_name: p.full_name })) || []);
      }
    };
    fetchAgents();
  }, []);

  // Fetch deposits via server-side RPC — handles joins, search, pagination in SQL
  const fetchDeposits = useCallback(async () => {
    setLoading(true);
    try {
      const { data: result, error } = await (supabase.rpc as any)('get_deposits_paginated', {
        p_status: statusFilter,
        p_agent_id: agentFilter !== 'all' ? agentFilter : null,
        p_min_amount: minAmount ? Number(minAmount) : null,
        p_max_amount: maxAmount ? Number(maxAmount) : null,
        p_start_date: startDate ? startOfDay(startDate).toISOString() : null,
        p_end_date: endDate ? endOfDay(endDate).toISOString() : null,
        p_search: debouncedSearch || null,
        p_page: page,
        p_page_size: PAGE_SIZE,
      });

      if (error) throw error;

      const parsed = typeof result === 'string' ? JSON.parse(result) : result;
      setTotalCount(parsed.total || 0);
      setDeposits((parsed.data || []) as DepositRequest[]);
    } catch (error) {
      console.error('Error fetching deposits:', error);
      toast.error('Failed to load deposits');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, agentFilter, minAmount, maxAmount, startDate, endDate, page, debouncedSearch]);

  // Debounce search input — 500ms delay to avoid excessive RPC calls at scale
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setPage(1);
    }, 500);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [searchQuery]);

  useEffect(() => {
    fetchDeposits();
  }, [fetchDeposits]);

  // Update URL params when filters change
  useEffect(() => {
    const params = new URLSearchParams();
    if (statusFilter !== 'all') params.set('status', statusFilter);
    if (agentFilter !== 'all') params.set('agent', agentFilter);
    if (minAmount) params.set('minAmount', minAmount);
    if (maxAmount) params.set('maxAmount', maxAmount);
    if (startDate) params.set('startDate', startDate.toISOString());
    if (endDate) params.set('endDate', endDate.toISOString());
    if (searchQuery) params.set('q', searchQuery);
    if (page > 1) params.set('page', String(page));
    setSearchParams(params, { replace: true });
  }, [statusFilter, agentFilter, minAmount, maxAmount, startDate, endDate, page, searchQuery, setSearchParams]);

  const clearFilters = () => {
    setStatusFilter('all');
    setAgentFilter('all');
    setMinAmount('');
    setMaxAmount('');
    setStartDate(undefined);
    setEndDate(undefined);
    setSearchQuery('');
    setPage(1);
  };

  const hasActiveFilters =
    statusFilter !== 'all' ||
    agentFilter !== 'all' ||
    minAmount ||
    maxAmount ||
    startDate ||
    endDate ||
    searchQuery;

  const openApproveDialog = (deposit: DepositRequest) => {
    setApproveDialog({ open: true, deposit });
    setApproveTid('');
  };

  const handleApprove = async () => {
    const deposit = approveDialog.deposit;
    if (!deposit) return;
    setApproveDialog({ open: false, deposit: null });
    setProcessingIds(prev => new Set(prev).add(deposit.id));
    try {
      const { error } = await supabase.functions.invoke('approve-deposit', {
        body: {
          deposit_request_id: deposit.id,
          action: 'approve',
          transaction_id: approveTid.trim().toUpperCase(),
        },
      });

      if (error) {
        const { extractFromErrorObject } = await import('@/lib/extractEdgeFunctionError');
        const msg = await extractFromErrorObject(error, 'Failed to approve deposit');
        throw new Error(msg);
      }
      toast.success(`Approved ${formatUGX(deposit.amount)}`);
      setApproveTid('');
      fetchDeposits();
    } catch (error: any) {
      toast.error(error.message || 'Failed to approve');
    } finally {
      setProcessingIds(prev => {
        const next = new Set(prev);
        next.delete(deposit.id);
        return next;
      });
    }
  };

  const handleReject = async () => {
    const deposit = rejectDialog.deposit;
    if (!deposit && !rejectDialog.isBulk) return;

    if (rejectDialog.isBulk) {
      // Bulk reject
      await handleBulkReject();
      return;
    }

    if (!deposit) return;

    setProcessingIds(prev => new Set(prev).add(deposit.id));
    setRejectDialog({ open: false, deposit: null, isBulk: false });

    try {
      const { error } = await supabase.functions.invoke('approve-deposit', {
        body: {
          deposit_request_id: deposit.id,
          action: 'reject',
          rejection_reason: rejectionReason || 'Rejected by manager',
        },
      });

      if (error) {
        const { extractFromErrorObject } = await import('@/lib/extractEdgeFunctionError');
        const msg = await extractFromErrorObject(error, 'Failed to reject deposit');
        throw new Error(msg);
      }
      toast.success('Deposit rejected');
      setRejectionReason('');
      fetchDeposits();
    } catch (error: any) {
      toast.error(error.message || 'Failed to reject');
    } finally {
      setProcessingIds(prev => {
        const next = new Set(prev);
        next.delete(deposit.id);
        return next;
      });
    }
  };

  // Toggle selection for a single deposit
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Toggle all pending deposits
  const toggleSelectAll = () => {
    if (allPendingSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(pendingDeposits.map(d => d.id)));
    }
  };

  // Bulk approve handler — single batch call instead of sequential
  const handleBulkApprove = async () => {
    const selectedDeposits = pendingDeposits.filter(d => selectedIds.has(d.id));
    if (selectedDeposits.length === 0) return;

    setBulkProcessing(true);
    try {
      const { data, error } = await supabase.functions.invoke('approve-deposit', {
        body: {
          bulk_ids: selectedDeposits.map(d => d.id),
          action: 'approve',
        },
      });

      if (error) throw error;

      const results = data?.results || [];
      const successCount = results.filter((r: any) => r.status === 'approved').length;
      const failures = results.filter((r: any) => r.status === 'error');
      const failCount = failures.length;

      if (successCount > 0) {
        toast.success(`Approved ${successCount} deposit${successCount > 1 ? 's' : ''}`);
      }
      if (failCount > 0) {
        const reasons = failures
          .map((f: any) => f?.error || f?.reason)
          .filter(Boolean)
          .slice(0, 3)
          .join(' • ');
        toast.error(`Failed to approve ${failCount} deposit${failCount > 1 ? 's' : ''}`, {
          description: reasons || undefined,
        });
      }
    } catch (error: any) {
      toast.error(error.message || 'Bulk approve failed');
    } finally {
      setBulkProcessing(false);
      setSelectedIds(new Set());
      fetchDeposits();
    }
  };

  // Bulk reject handler — single batch call
  const handleBulkReject = async () => {
    const selectedDeposits = pendingDeposits.filter(d => selectedIds.has(d.id));
    if (selectedDeposits.length === 0) return;

    setBulkProcessing(true);
    setRejectDialog({ open: false, deposit: null, isBulk: false });

    try {
      const { data, error } = await supabase.functions.invoke('approve-deposit', {
        body: {
          bulk_ids: selectedDeposits.map(d => d.id),
          action: 'reject',
          rejection_reason: rejectionReason || 'Bulk rejected by manager',
        },
      });

      if (error) throw error;

      const results = data?.results || [];
      const successCount = results.filter((r: any) => r.status === 'rejected').length;
      const failures = results.filter((r: any) => r.status === 'error');
      const failCount = failures.length;

      if (successCount > 0) {
        toast.success(`Rejected ${successCount} deposit${successCount > 1 ? 's' : ''}`);
      }
      if (failCount > 0) {
        const reasons = failures
          .map((f: any) => f?.error || f?.reason)
          .filter(Boolean)
          .slice(0, 3)
          .join(' • ');
        toast.error(`Failed to reject ${failCount} deposit${failCount > 1 ? 's' : ''}`, {
          description: reasons || undefined,
        });
      }
    } catch (error: any) {
      toast.error(error.message || 'Bulk reject failed');
    } finally {
      setBulkProcessing(false);
      setSelectedIds(new Set());
      setRejectionReason('');
      fetchDeposits();
    }
  };

  const handleExport = () => {
    const headers = ['User', 'Phone', 'Amount (UGX)', 'Status', 'Agent', 'Created', 'Processed By'];
    const rows = deposits.map(d => [
      d.user_name || '',
      d.user_phone || '',
      d.amount,
      d.status,
      d.agent_name || '',
      formatDateForExport(d.created_at),
      d.processed_by_name || 'N/A',
    ]);
    exportToCSV({ headers, rows }, 'deposits_export');
    toast.success('Exported to CSV');
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge variant="outline" className="bg-warning/10 text-warning border-warning/30">Pending</Badge>;
      case 'approved':
        return <Badge variant="outline" className="bg-success/10 text-success border-success/30">Approved</Badge>;
      case 'rejected':
        return <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/30">Rejected</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  if (authLoading) {
    return (
      <ScreenLoader />
    );
  }

  if (!user || role !== 'manager') return null;

  return (
    <div className="min-h-screen bg-background pb-24 sm:pb-6">
      {/* Header */}
      <header className="sticky top-0 z-50 wa-header shadow-sm pt-safe">
        <div className="px-4 py-3">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => navigate('/manager-access?tab=deposits')}
              className="text-white/90 hover:text-white hover:bg-white/10"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="flex-1">
              <h1 className="text-lg font-semibold text-white">Deposits Management</h1>
              <p className="text-xs text-white/70">{totalCount} total requests</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={fetchDeposits}
              className="text-white/90 hover:text-white hover:bg-white/10"
            >
              <RefreshCw className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </header>

      <main className="px-4 py-4 space-y-4">
        <Tabs defaultValue="deposits" className="w-full">
          <TabsList className="grid w-full grid-cols-2 h-11">
            <TabsTrigger value="deposits" className="flex items-center gap-2">
              <Wallet className="h-4 w-4" />
              Deposits
            </TabsTrigger>
            <TabsTrigger value="audit" className="flex items-center gap-2">
              <ClipboardList className="h-4 w-4" />
              Audit Log
            </TabsTrigger>
          </TabsList>
          
          <TabsContent value="deposits" className="mt-4 space-y-4">
        {/* Search and Filter Bar — sticky on mobile so it stays reachable while scrolling */}
        <div className="flex gap-2 sticky top-[56px] z-40 -mx-4 px-4 py-2 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/70 border-b border-border/50 sm:static sm:mx-0 sm:px-0 sm:py-0 sm:bg-transparent sm:border-0 sm:backdrop-blur-none">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name or phone..."
              value={searchQuery}
              onChange={e => {
                setSearchQuery(e.target.value);
                setPage(1);
              }}
              className="pl-10 h-11"
            />
          </div>
          <Button
            variant={showFilters ? 'default' : 'outline'}
            size="icon"
            onClick={() => setShowFilters(!showFilters)}
            className={cn('h-11 w-11 relative', hasActiveFilters && !showFilters && 'border-primary text-primary')}
          >
            <Filter className="h-4 w-4" />
            {hasActiveFilters && (
              <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-primary border-2 border-background" />
            )}
          </Button>
          <Button variant="outline" size="icon" onClick={handleExport} className="h-11 w-11">
            <Download className="h-4 w-4" />
          </Button>
        </div>

        {/* Bulk Actions Bar */}
        {selectedPendingCount > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-3 bg-primary/10 rounded-lg border border-primary/20"
          >
            <div className="flex items-center gap-2">
              <CheckCheck className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">
                {selectedPendingCount} deposit{selectedPendingCount > 1 ? 's' : ''} selected
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 sm:flex">
              <Button
                size="sm"
                onClick={handleBulkApprove}
                disabled={bulkProcessing}
                className="h-10"
              >
                {bulkProcessing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Check className="h-4 w-4 sm:mr-1" />
                    <span className="hidden sm:inline">Approve All</span>
                    <span className="sm:hidden">Approve</span>
                  </>
                )}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setRejectDialog({ open: true, deposit: null, isBulk: true })}
                disabled={bulkProcessing}
                className="h-10"
              >
                <X className="h-4 w-4 sm:mr-1" />
                <span className="hidden sm:inline">Reject All</span>
                <span className="sm:hidden">Reject</span>
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSelectedIds(new Set())}
                disabled={bulkProcessing}
                className="h-10"
              >
                Clear
              </Button>
            </div>
          </motion.div>
        )}

        {/* Filter Panel */}
        <AnimatePresence>
          {showFilters && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
            >
              <Card>
                <CardContent className="p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">Filters</span>
                    <div className="flex gap-2">
                      {hasActiveFilters && (
                        <Button variant="ghost" size="sm" onClick={clearFilters}>
                          Clear all
                        </Button>
                      )}
                      <Button variant="outline" size="sm" onClick={() => setShowFilters(false)} className="sm:hidden">
                        Done
                      </Button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    {/* Status Filter */}
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Status</label>
                      <Select value={statusFilter} onValueChange={v => { setStatusFilter(v); setPage(1); }}>
                        <SelectTrigger>
                          <SelectValue placeholder="All statuses" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All statuses</SelectItem>
                          <SelectItem value="pending">Pending</SelectItem>
                          <SelectItem value="approved">Approved</SelectItem>
                          <SelectItem value="rejected">Rejected</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Agent Filter */}
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Agent</label>
                      <Select value={agentFilter} onValueChange={v => { setAgentFilter(v); setPage(1); }}>
                        <SelectTrigger>
                          <SelectValue placeholder="All agents" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All agents</SelectItem>
                          {agents.map(agent => (
                            <SelectItem key={agent.id} value={agent.id}>
                              {agent.full_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Min Amount */}
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Min Amount</label>
                      <Input
                        type="number"
                        placeholder="0"
                        value={minAmount}
                        onChange={e => { setMinAmount(e.target.value); setPage(1); }}
                      />
                    </div>

                    {/* Max Amount */}
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Max Amount</label>
                      <Input
                        type="number"
                        placeholder="Any"
                        value={maxAmount}
                        onChange={e => { setMaxAmount(e.target.value); setPage(1); }}
                      />
                    </div>
                  </div>

                  {/* Date Range */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">From Date</label>
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button variant="outline" className="w-full justify-start">
                            <CalendarIcon className="h-4 w-4 mr-2" />
                            {startDate ? format(startDate, 'MMM d, yyyy') : 'Pick date'}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="start">
                          <Calendar
                            mode="single"
                            selected={startDate}
                            onSelect={d => { setStartDate(d); setPage(1); }}
                            initialFocus
                          />
                        </PopoverContent>
                      </Popover>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">To Date</label>
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button variant="outline" className="w-full justify-start">
                            <CalendarIcon className="h-4 w-4 mr-2" />
                            {endDate ? format(endDate, 'MMM d, yyyy') : 'Pick date'}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="start">
                          <Calendar
                            mode="single"
                            selected={endDate}
                            onSelect={d => { setEndDate(d); setPage(1); }}
                            initialFocus
                          />
                        </PopoverContent>
                      </Popover>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Deposits List */}
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map(i => (
              <Skeleton key={i} className="h-32 w-full" />
            ))}
          </div>
        ) : deposits.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Wallet className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground">No deposit requests found</p>
              {hasActiveFilters && (
                <Button variant="link" onClick={clearFilters} className="mt-2">
                  Clear filters
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {/* Select All for Pending */}
            {pendingDeposits.length > 0 && (
              <div className="flex items-center gap-2 p-2 bg-muted/50 rounded-lg">
                <Checkbox
                  id="select-all"
                  checked={allPendingSelected}
                  onCheckedChange={toggleSelectAll}
                />
                <label htmlFor="select-all" className="text-sm text-muted-foreground cursor-pointer">
                  Select all pending ({pendingDeposits.length})
                </label>
              </div>
            )}
            <AnimatePresence mode="popLayout">
              {deposits.map((deposit, index) => (
                <motion.div
                  key={deposit.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ delay: index * 0.03 }}
                >
                  <Card className={cn(
                    selectedIds.has(deposit.id) && deposit.status === 'pending' && 'ring-2 ring-primary'
                  )}>
                    <CardContent className="p-4 space-y-4">
                      {/* Transaction ID — top priority */}
                      <div className="p-3 rounded-lg bg-warning/10 border-2 border-warning/40">
                        <p className="text-xs font-bold text-warning uppercase tracking-wider mb-1">Transaction ID — Verify First</p>
                        <p className="font-mono text-3xl font-black text-foreground break-all tracking-tight leading-tight">
                          {deposit.transaction_id || <span className="text-destructive text-base italic font-sans font-semibold">No Transaction ID provided</span>}
                        </p>
                      </div>

                      {/* Amount — large, high-contrast headline */}
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-0.5">Amount</p>
                          <p className="text-3xl font-black text-primary tabular-nums leading-tight break-all">
                            {formatUGX(deposit.amount)}
                          </p>
                        </div>
                        <div className="shrink-0">{getStatusBadge(deposit.status)}</div>
                      </div>

                      {/* User info + amount + status */}
                      <div className="flex items-start gap-3">
                          {deposit.status === 'pending' && (
                            <Checkbox
                              checked={selectedIds.has(deposit.id)}
                              onCheckedChange={() => toggleSelect(deposit.id)}
                              className="mt-1 h-5 w-5"
                            />
                          )}
                          <div className="flex-1 min-w-0 space-y-1.5">
                            <div className="flex items-center gap-2">
                              <User className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                              <span className="text-base font-semibold truncate">{deposit.user_name}</span>
                            </div>
                            {deposit.user_phone && (
                              <a
                                href={`tel:${deposit.user_phone}`}
                                className="flex items-center gap-2 text-base text-foreground/80 hover:text-primary"
                              >
                                <Phone className="h-4 w-4 flex-shrink-0" />
                                <span className="font-medium tabular-nums">{deposit.user_phone}</span>
                              </a>
                            )}
                          </div>
                          {deposit.provider && (
                            <Badge variant="outline" className={`text-xs font-bold shrink-0 ${deposit.provider === 'mtn' ? 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/30' : 'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30'}`}>
                              {deposit.provider.toUpperCase()}
                            </Badge>
                          )}
                      </div>

                      {/* Meta — clearer rows instead of dense inline text */}
                      <div className="space-y-1.5 text-sm text-muted-foreground border-t border-border/50 pt-3">
                        <div className="flex items-center gap-2">
                          <CalendarIcon className="h-4 w-4 shrink-0" />
                          <span className="font-medium text-foreground/80">{format(new Date(deposit.created_at), 'MMM d, yyyy • h:mm a')}</span>
                        </div>
                        {deposit.agent_name && (
                          <p>Agent: <strong className="text-foreground/90">{deposit.agent_name}</strong></p>
                        )}
                        {deposit.processed_by_name && (
                          <p>Processed by: <strong className="text-foreground/90">{deposit.processed_by_name}</strong></p>
                        )}
                      </div>

                      {deposit.rejection_reason && (
                        <div className="p-2.5 rounded-md bg-destructive/10 border border-destructive/30">
                          <p className="text-xs font-bold uppercase tracking-wider text-destructive mb-0.5">Rejection reason</p>
                          <p className="text-sm text-destructive">{deposit.rejection_reason}</p>
                        </div>
                      )}

                      {deposit.status === 'pending' && !selectedIds.has(deposit.id) && (
                        <div className="flex gap-2 pt-2 border-t">
                        <Button
                          size="lg"
                          className="flex-1 h-12 text-base font-semibold"
                          onClick={() => openApproveDialog(deposit)}
                          disabled={processingIds.has(deposit.id) || bulkProcessing}
                        >
                            {processingIds.has(deposit.id) ? (
                              <Loader2 className="h-5 w-5 animate-spin" />
                            ) : (
                              <>
                                <Check className="h-5 w-5 mr-1.5" />
                                Approve
                              </>
                            )}
                          </Button>
                          <Button
                            size="lg"
                            variant="destructive"
                            className="flex-1 h-12 text-base font-semibold"
                            onClick={() => setRejectDialog({ open: true, deposit, isBulk: false })}
                            disabled={processingIds.has(deposit.id) || bulkProcessing}
                          >
                            <X className="h-5 w-5 mr-1.5" />
                            Reject
                          </Button>
                        </div>
                      )}
                      {deposit.status === 'pending' && selectedIds.has(deposit.id) && (
                        <p className="text-sm font-medium text-primary text-center py-1">
                          Selected for bulk action
                        </p>
                      )}
                    </CardContent>
                  </Card>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}

        {/* Pagination — sticky bottom bar on mobile for easy thumb reach */}
        {totalPages > 1 && (
          <div className="fixed bottom-0 inset-x-0 z-40 flex items-center justify-between gap-2 px-4 py-3 bg-background/95 backdrop-blur border-t border-border pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:static sm:p-0 sm:pt-4 sm:bg-transparent sm:border-0 sm:backdrop-blur-none">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1 || loading}
              className="h-11 flex-1 sm:flex-none"
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              Previous
            </Button>
            <span className="text-sm text-muted-foreground font-medium whitespace-nowrap">
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages || loading}
              className="h-11 flex-1 sm:flex-none"
            >
              Next
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        )}
          </TabsContent>
          
          <TabsContent value="audit" className="mt-4">
            <AuditLogViewer tableName="deposit_requests" />
          </TabsContent>
        </Tabs>
      </main>

      {/* Approve TID Dialog */}
      <AlertDialog open={approveDialog.open} onOpenChange={open => { if (!open) setApproveDialog({ open: false, deposit: null }); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Approval</AlertDialogTitle>
            <AlertDialogDescription>
              Enter the Transaction ID to approve {approveDialog.deposit && formatUGX(approveDialog.deposit.amount)}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            placeholder="Enter Transaction ID"
            value={approveTid}
            onChange={e => setApproveTid(e.target.value)}
            className="font-mono uppercase"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleApprove} disabled={!approveTid.trim()}>
              Approve
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reject Dialog */}
      <AlertDialog open={rejectDialog.open} onOpenChange={open => setRejectDialog({ open, deposit: null, isBulk: false })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {rejectDialog.isBulk 
                ? `Reject ${selectedPendingCount} Deposit${selectedPendingCount > 1 ? 's' : ''}` 
                : 'Reject Deposit Request'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {rejectDialog.isBulk 
                ? `Are you sure you want to reject ${selectedPendingCount} selected deposit${selectedPendingCount > 1 ? 's' : ''}?`
                : `Reject deposit of ${rejectDialog.deposit && formatUGX(rejectDialog.deposit.amount)}?`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            placeholder="Reason for rejection (optional)"
            value={rejectionReason}
            onChange={e => setRejectionReason(e.target.value)}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleReject} className="bg-destructive hover:bg-destructive/90">
              Reject
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
