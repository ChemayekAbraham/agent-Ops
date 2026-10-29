import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  Banknote,
  CheckCircle2,
  Clock,
  RefreshCw,
  Search,
  Building2,
  ExternalLink,
  History,
  Loader2,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

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

// Statuses written by the old browser flow, before disbursement moved to the server.
// Nothing proves money moved for these, so they are listed apart and never re-disbursed here.
const OLD_LOGIC_STATUSES = ['approved', 'funded', 'disbursed'];

function isMissingServerFunction(err: any): boolean {
  const code = String(err?.code ?? '');
  const msg = String(err?.message ?? '');
  return code === 'PGRST202' || code === '42883' || /could not find the function/i.test(msg);
}

export function CFOWelileHomesDisbursementDesk() {
  const qc = useQueryClient();
  const [filterTab, setFilterTab] = useState<'pending_cfo' | 'old_logic' | 'all'>('pending_cfo');
  const [search, setSearch] = useState('');

  // Fetch Welile Homes float requests that have reached the CFO stage.
  // Only Welile Homes requests: Merchant float requests are handled on the Merchant panel.
  const { data: floatRequests = [], isLoading, refetch } = useQuery({
    queryKey: ['cfo-welile-homes-float-requests'],
    queryFn: async (): Promise<FloatRequest[]> => {
      const { data, error } = await supabase
        .from('float_requests')
        .select('id, agent_id, requested_amount, reason, expected_recipient_phone, status, created_at, approved_at, approved_by')
        .ilike('reason', '%welile%homes%')
        .in('status', ['coo_approved', ...OLD_LOGIC_STATUSES])
        .order('created_at', { ascending: false })
        .limit(200);

      if (error) throw error;
      const welileRows = data ?? [];

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

  const [allocatingReq, setAllocatingReq] = useState<FloatRequest | null>(null);

  const openAllocationModal = (req: FloatRequest) => {
    setAllocatingReq(req);
  };

  // Action: CFO disbursement. One server function sends the float, records the ledger
  // entry and marks the request approved in a single step; if any part fails, nothing changes.
  // The browser never writes the request status.
  const disburseMutation = useMutation({
    mutationFn: async ({ req }: { req: FloatRequest }) => {
      const { data, error } = await (supabase.rpc as any)('wh_cfo_disburse_float', {
        p_request_id: req.id,
      });
      if (error) {
        if (isMissingServerFunction(error)) {
          throw new Error('Server disbursement is not installed yet. Nothing was sent.');
        }
        throw error;
      }
      return data;
    },
    onSuccess: () => {
      toast.success('Float disbursed and recorded on the ledger');
      setAllocatingReq(null);
      qc.invalidateQueries({ queryKey: ['cfo-welile-homes-float-requests'] });
    },
    onError: (err: any) => {
      toast.error('Disbursement failed: ' + (err.message || 'Unknown error'));
    },
  });

  const handleConfirmAllocation = () => {
    if (!allocatingReq) return;
    disburseMutation.mutate({ req: allocatingReq });
  };

  const pendingCount = floatRequests.filter((r) => r.status === 'coo_approved').length;
  const disbursedCount = floatRequests.filter((r) => OLD_LOGIC_STATUSES.includes(r.status)).length;
  const totalPendingAmount = floatRequests
    .filter((r) => r.status === 'coo_approved')
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

    if (filterTab === 'pending_cfo') {
      return r.status === 'coo_approved';
    }
    if (filterTab === 'old_logic') {
      return OLD_LOGIC_STATUSES.includes(r.status);
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
              <Banknote className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base font-bold text-foreground">
                  Welile Homes Float Disbursements
                </h2>
                <Badge className="bg-primary text-primary-foreground text-[10px]">
                  CFO Treasury Stage
                </Badge>
                {pendingCount > 0 && (
                  <Badge variant="destructive" className="text-[10px] animate-pulse">
                    {pendingCount} Due for Disbursement
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Authorize and disburse company operational float for COO-approved Welile Homes requests.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
            <Button asChild variant="outline" size="sm" className="gap-1.5 text-xs font-semibold">
              <Link to="/cfo/welile-homes">
                <ExternalLink className="h-3.5 w-3.5" />
                Open Day Report
              </Link>
            </Button>
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

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-3 pt-3 mt-3 border-t border-border/50">
          <div className="p-3 rounded-xl bg-background/60 border border-border/40">
            <span className="text-[11px] text-muted-foreground block font-medium">Pending CFO Disbursement</span>
            <span className="text-lg font-bold text-amber-600 dark:text-amber-400 tabular-nums">
              {pendingCount}
            </span>
            <span className="text-[10px] text-muted-foreground block">Approved by COO</span>
          </div>

          <div className="p-3 rounded-xl bg-background/60 border border-border/40">
            <span className="text-[11px] text-muted-foreground block font-medium">Disbursement Volume Due</span>
            <span className="text-lg font-bold text-foreground tabular-nums">
              {formatUGX(totalPendingAmount)}
            </span>
            <span className="text-[10px] text-muted-foreground block">Treasury cashflow impact</span>
          </div>

          <div className="p-3 rounded-xl bg-background/60 border border-border/40">
            <span className="text-[11px] text-muted-foreground block font-medium">Old Logic Approvals</span>
            <span className="text-lg font-bold text-muted-foreground tabular-nums">
              {disbursedCount}
            </span>
            <span className="text-[10px] text-muted-foreground block">Marked approved before server disbursement</span>
          </div>
        </div>
      </div>

      {/* Tabs & Search */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
          <button
            type="button"
            onClick={() => setFilterTab('pending_cfo')}
            className={cn(
              'px-3 py-1.5 rounded-full text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer shrink-0',
              filterTab === 'pending_cfo'
                ? 'bg-amber-600 text-white font-bold shadow-xs'
                : 'bg-muted text-muted-foreground hover:text-foreground border border-border/40'
            )}
          >
            <Clock className="h-3.5 w-3.5" />
            Due for Disbursement ({pendingCount})
          </button>

          <button
            type="button"
            onClick={() => setFilterTab('old_logic')}
            className={cn(
              'px-3 py-1.5 rounded-full text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer shrink-0',
              filterTab === 'old_logic'
                ? 'bg-slate-600 text-white font-bold shadow-xs'
                : 'bg-muted text-muted-foreground hover:text-foreground border border-border/40'
            )}
          >
            <History className="h-3.5 w-3.5" />
            Old Logic ({disbursedCount})
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
            All Welile Homes Float ({floatRequests.length})
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
              {filterTab === 'pending_cfo'
                ? 'No requests awaiting CFO disbursement'
                : filterTab === 'old_logic'
                ? 'No Old Logic approvals'
                : 'No requests found'}
            </p>
            <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
              {filterTab === 'old_logic'
                ? 'Requests marked approved by the earlier browser flow appear here for review.'
                : 'Requests approved by the COO will appear here ready for treasury float allocation.'}
            </p>
          </Card>
        ) : null}
        {!isLoading && filtered.length > 0 && filterTab === 'old_logic' && (
          <Card className="rounded-2xl p-3 border-slate-500/30 bg-slate-500/5 text-[11px] text-muted-foreground">
            These were marked approved by the earlier flow, which did not confirm that money was sent.
            They are kept as they are for CFO review and cannot be disbursed again from here.
          </Card>
        )}
        {!isLoading && filtered.length > 0 && (
          filtered.map((req) => {
            const isPendingCfo = req.status === 'coo_approved';
            const isDisbursed = OLD_LOGIC_STATUSES.includes(req.status);

            return (
              <Card
                key={req.id}
                className={cn(
                  'rounded-2xl border p-4 sm:p-5 transition-all shadow-2xs',
                  isPendingCfo ? 'border-amber-500/40 bg-card hover:border-amber-500/60' : 'border-border/70 bg-card'
                )}
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3.5">
                  <div className="flex items-start sm:items-center gap-3.5 min-w-0">
                    <div
                      className={cn(
                        'p-2.5 rounded-xl shrink-0',
                        isPendingCfo
                          ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                          : isDisbursed
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

                        {isPendingCfo && (
                          <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30 text-[10px]">
                            Stage 4: Ready for CFO Disbursement
                          </Badge>
                        )}
                        {isDisbursed && (
                          <Badge variant="outline" className="bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/30 text-[10px]">
                            Old Logic · {req.status}
                          </Badge>
                        )}
                      </div>

                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                        {req.reason || 'Welile Homes landlord float requisition'}
                      </p>

                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground mt-2 flex-wrap">
                        <span className="font-bold text-foreground">
                          Amount: {formatUGX(req.requested_amount)}
                        </span>
                        <span>•</span>
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium">✓ Agent Ops</span>
                        <span>•</span>
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium">✓ Tenant Ops</span>
                        <span>•</span>
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium">✓ COO Approved</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 self-end sm:self-center shrink-0 flex-wrap">
                    {isPendingCfo && (
                      <Button
                        size="sm"
                        onClick={() => openAllocationModal(req)}
                        disabled={disburseMutation.isPending}
                        className="gap-1.5 text-xs h-9 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold shadow-xs cursor-pointer"
                      >
                        <Banknote className="h-4 w-4" />
                        <span>Allocate Float</span>
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            );
          })
        )}
      </div>

      {/* CFO Float Allocation Modal */}
      <Dialog open={!!allocatingReq} onOpenChange={(open) => { if (!open) setAllocatingReq(null); }}>
        <DialogContent className="max-w-md rounded-2xl p-5 space-y-4">
          <DialogHeader>
            <DialogTitle className="text-base font-bold flex items-center gap-2">
              <Banknote className="h-5 w-5 text-primary" />
              Allocate & Disburse Float
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Authorize company treasury float payout for {allocatingReq?.agent_name} ({allocatingReq?.agent_phone || 'No phone'}).
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-xs">
            <div className="p-3 rounded-xl bg-muted/40 border border-border/50 space-y-1.5">
              <div className="flex justify-between items-center text-[11px]">
                <span className="text-muted-foreground">Requested Amount:</span>
                <span className="font-bold text-foreground tabular-nums">
                  {allocatingReq ? formatUGX(allocatingReq.requested_amount) : '0'}
                </span>
              </div>
              <div className="flex justify-between items-center text-[11px]">
                <span className="text-muted-foreground">Agent:</span>
                <span className="font-medium text-foreground">{allocatingReq?.agent_name}</span>
              </div>
              {allocatingReq?.reason && (
                <div className="pt-1.5 border-t border-border/40 text-[10.5px]">
                  <span className="text-muted-foreground block mb-0.5">Submission Note:</span>
                  <p className="text-foreground">{allocatingReq.reason}</p>
                </div>
              )}
            </div>

            <p className="text-[10.5px] text-muted-foreground leading-relaxed">
              The full requested amount is credited to the agent's float in one server step,
              with the same ledger entries the Merchant panel uses. If the payment fails, nothing is recorded
              and the request stays here.
            </p>
          </div>

          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAllocatingReq(null)}
              disabled={disburseMutation.isPending}
              className="h-8 text-xs cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleConfirmAllocation}
              disabled={disburseMutation.isPending}
              className="h-8 text-xs bg-primary text-primary-foreground font-semibold gap-1.5 cursor-pointer shadow-xs"
            >
              {disburseMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Banknote className="h-3.5 w-3.5" />
              )}
              <span>Confirm & Disburse Float</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

