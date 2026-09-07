import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Card, CardContent } from '@/components/ui/card';
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
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
  CheckCircle2, XCircle, Loader2, Clock, User, Info,
  Users, ChevronRight, Target, AlertTriangle, Zap, Layers,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { disburseAgentAdvanceRequest } from '@/lib/disburseAgentAdvance';
import { Checkbox } from '@/components/ui/checkbox';
import { AgentLocationBadge } from '@/components/ops/AgentLocationBadge';
import {
  useAgentDuplicateMap,
  DuplicateAccountBadge,
  DuplicateAccountAlert,
} from '@/components/ops/DuplicateAccountAlert';
import {
  RejectAsDuplicateDialog,
  useAgentDuplicateFlags,
} from '@/components/ops/RejectAsDuplicateDialog';
import {
  AgentAdvanceEvaluationDialog,
  type PotentialInfo,
  scoreColor,
  tierLabel,
} from '@/components/agent/AgentAdvanceEvaluationDialog';

// Agent advances now have a single operational approval desk: Agent Ops.
// Once Agent Ops approves, the request goes straight to the CFO for final
// evaluation and disbursement — there are no tenant/landlord/COO stages.
type ApprovalStage = 'agent_ops';

interface AdvanceRequestsQueueProps {
  stage: ApprovalStage;
}

const STAGE_CONFIG: Record<ApprovalStage, { filterStatus: string; nextStatus: string; reviewerCol: string; reviewedAtCol: string; notesCol: string; title: string }> = {
  agent_ops: { filterStatus: 'pending', nextStatus: 'agent_ops_approved', reviewerCol: 'reviewed_by_agent_ops', reviewedAtCol: 'agent_ops_reviewed_at', notesCol: 'agent_ops_notes', title: 'Agent Advance Requests' },
};

const num = (v: any) => Number(v ?? 0);

/** Shared hook: builds a map of agent_id -> potential info from the scoring RPC. */
export function useAgentPotentialMap() {
  return useQuery({
    queryKey: ['agent-potential-map'],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_agent_advance_potential', {
        _search: null,
        _limit: 500,
        _offset: 0,
      });
      if (error) throw error;
      const map: Record<string, PotentialInfo> = {};
      for (const r of (data ?? []) as any[]) {
        map[r.agent_id] = {
          potential_score: num(r.potential_score),
          suggested_amount: num(r.suggested_amount),
          current_limit: num(r.current_limit),
          direct_subagents: num(r.direct_subagents),
          active_subagents: num(r.active_subagents),
          grand_subagents: num(r.grand_subagents),
          rent_collected: num(r.rent_collected),
          collections_count: num(r.collections_count),
          house_listings: num(r.house_listings),
          rent_requests: num(r.rent_requests),
          advances_count: num(r.advances_count),
          outstanding_total: num(r.outstanding_total),
          repayment_rate: r.repayment_rate == null ? null : Number(r.repayment_rate),
          network_score: num(r.network_score),
          collections_score: num(r.collections_score),
          repayment_score: num(r.repayment_score),
          listings_score: num(r.listings_score),
          requests_score: num(r.requests_score),
        };
      }
      return map;
    },
  });
}

export function AdvanceRequestsQueue({ stage }: AdvanceRequestsQueueProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const config = STAGE_CONFIG[stage];
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<any | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; amount: number; original: number } | null>(null);

  // ---- Bulk review state ---------------------------------------------------
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<null | 'approve_to_cfo' | 'reject'>(null);
  const [bulkNotes, setBulkNotes] = useState('');
  const [bulkAckFlagged, setBulkAckFlagged] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [bulkFailures, setBulkFailures] = useState<Record<string, string>>({});

  const { data: requests = [], isLoading } = useQuery({
    queryKey: ['advance-requests-queue', stage],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_advance_requests_privileged')
        .select('*')
        .eq('status', config.filterStatus)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data || [];
    },
  });

  const { data: potentialMap = {} } = useAgentPotentialMap();

  // Fraud signal: does this agent have another account (same name / NIN / momo)?
  const { data: duplicateMap = {} } = useAgentDuplicateMap(
    (requests as any[]).map((r) => r.agent_id).filter(Boolean),
  );

  const { data: duplicateFlagMap = {} } = useAgentDuplicateFlags(
    (requests as any[]).map((r) => r.agent_id).filter(Boolean),
  );
  const [dupRejectReq, setDupRejectReq] = useState<any | null>(null);

  const approveMutation = useMutation({
    mutationFn: async ({ id, approve, principal }: { id: string; approve: boolean; principal?: number }) => {
      if (!user?.id) throw new Error('Not authenticated');
      const updateData: any = {};
      if (approve) {
        updateData.status = config.nextStatus;
        updateData[config.reviewerCol] = user.id;
        updateData[config.reviewedAtCol] = new Date().toISOString();
        if (notes[id]) updateData[config.notesCol] = notes[id];
        if (typeof principal === 'number' && Number.isFinite(principal) && principal > 0) {
          updateData.principal = principal;
        }
      } else {
        updateData.status = 'rejected';
        updateData.rejection_reason = notes[id] || 'Rejected at ' + stage.replace('_', ' ') + ' stage';
        updateData[config.reviewerCol] = user.id;
        updateData[config.reviewedAtCol] = new Date().toISOString();
      }
      const { data, error } = await supabase
        .from('agent_advance_requests')
        .update(updateData)
        .eq('id', id)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        throw new Error('Approval blocked — your role may not have permission, or the request has already moved to a later stage.');
      }
      return { disbursed: false };
    },
    onSuccess: (result: any, { approve }) => {
      toast.success(
        !approve
          ? 'Request rejected'
          : result?.disbursed
            ? 'Advance approved & disbursed to agent wallet'
            : 'Request approved — sent to CFO',
      );
      setSelected(null);
      setConfirm(null);
      queryClient.invalidateQueries({ queryKey: ['advance-requests-queue'] });
      queryClient.invalidateQueries({ queryKey: ['advance-requests-reviewed'] });
      queryClient.invalidateQueries({ queryKey: ['cfo-advance-requests'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const getEditedAmount = (req: any): number => {
    const raw = amounts[req.id];
    if (raw === undefined || raw === '') return num(req.principal);
    const parsed = Number(String(raw).replace(/[^0-9.]/g, ''));
    return Number.isFinite(parsed) ? parsed : num(req.principal);
  };

  // ---- Bulk helpers --------------------------------------------------------
  const isFlagged = (req: any) => {
    const p = req.agent_id ? potentialMap[req.agent_id] : undefined;
    if (!p) return false;
    const amt = getEditedAmount(req);
    return amt > p.suggested_amount || (p.current_limit > 0 && amt > p.current_limit);
  };

  const toggleOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allSelected = requests.length > 0 && selectedIds.size === requests.length;
  const someSelected = selectedIds.size > 0 && !allSelected;
  const toggleAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(requests.map((r: any) => r.id)));
  };

  const selectedRequests = useMemo(
    () => requests.filter((r: any) => selectedIds.has(r.id)),
    [requests, selectedIds],
  );
  const selectedTotal = selectedRequests.reduce((s: number, r: any) => s + getEditedAmount(r), 0);
  const hasFlaggedInSelection = selectedRequests.some(isFlagged);

  async function processOne(req: any, action: 'approve_to_cfo' | 'reject'): Promise<void> {
    if (!user?.id) throw new Error('Not authenticated');
    const amt = getEditedAmount(req);
    const note = bulkNotes.trim() || null;
    const updateData: any = {};
    if (action === 'approve_to_cfo') {
      updateData.status = config.nextStatus;
      updateData[config.reviewerCol] = user.id;
      updateData[config.reviewedAtCol] = new Date().toISOString();
      if (note) updateData[config.notesCol] = note;
      if (amt > 0 && amt !== num(req.principal)) updateData.principal = amt;
    } else {
      updateData.status = 'rejected';
      updateData.rejection_reason = note || 'Bulk-rejected at agent ops stage';
      updateData[config.reviewerCol] = user.id;
      updateData[config.reviewedAtCol] = new Date().toISOString();
    }
    const { data, error } = await supabase
      .from('agent_advance_requests')
      .update(updateData)
      .eq('id', req.id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Blocked — status changed or permission denied');
  }

  async function runBulk() {
    if (!bulkAction || selectedRequests.length === 0) return;
    setBulkRunning(true);
    setBulkFailures({});
    setBulkProgress({ done: 0, total: selectedRequests.length });
    let ok = 0;
    const failures: Record<string, string> = {};
    for (let i = 0; i < selectedRequests.length; i++) {
      const req = selectedRequests[i];
      try {
        await processOne(req, bulkAction);
        ok += 1;
      } catch (err: any) {
        failures[req.id] = err?.message || 'Failed';
      }
      setBulkProgress({ done: i + 1, total: selectedRequests.length });
    }
    const failedCount = Object.keys(failures).length;
    setBulkFailures(failures);
    if (failedCount === 0) {
      toast.success(`${ok} request${ok === 1 ? '' : 's'} processed`);
      setSelectedIds(new Set());
      setBulkAction(null);
      setBulkNotes('');
      setBulkAckFlagged(false);
    } else {
      toast.warning(`${ok} succeeded · ${failedCount} failed — see highlighted rows`);
      // Keep only failed rows selected so the operator can retry.
      setSelectedIds(new Set(Object.keys(failures)));
      setBulkAction(null);
    }
    setBulkRunning(false);
    setBulkProgress(null);
    queryClient.invalidateQueries({ queryKey: ['advance-requests-queue'] });
    queryClient.invalidateQueries({ queryKey: ['advance-requests-reviewed'] });
    queryClient.invalidateQueries({ queryKey: ['cfo-advance-requests'] });
  }

  if (isLoading) {
    return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  if (requests.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <Clock className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No advance requests pending at this stage</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold">{config.title}</h3>
        <Badge variant="secondary" className="text-xs">{requests.length} to review</Badge>
      </div>
      <p className="text-[11px] text-muted-foreground -mt-1">
        Tap a request to open the full evaluation — suggested vs requested, limit and performance.
      </p>

      {requests.length > 0 && (
        <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2">
          <label className="flex items-center gap-2 cursor-pointer select-none text-xs">
            <Checkbox
              checked={allSelected ? true : someSelected ? 'indeterminate' : false}
              onCheckedChange={toggleAll}
            />
            <span className="font-semibold">
              {selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Select all for group review'}
            </span>
          </label>
          {selectedIds.size > 0 && (
            <button
              type="button"
              onClick={() => { setSelectedIds(new Set()); setBulkFailures({}); }}
              className="text-[11px] text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {requests.map((req: any) => {
        const requested = num(req.principal);
        const isSel = selectedIds.has(req.id);
        const failureMsg = bulkFailures[req.id];
        return (
          <div key={req.id} className="relative">
            <button
              type="button"
              onClick={() => setSelected(req)}
              className="w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-xl"
            >
              <Card className={cn(
                'overflow-hidden hover:border-primary/40 hover:shadow-sm active:scale-[0.99] transition-all',
                isSel && 'border-primary ring-1 ring-primary/40',
                failureMsg && 'border-red-500 ring-1 ring-red-400',
              )}>
                <CardContent className="p-3">
                  <div className="flex items-center gap-3">
                    <span
                      onClick={(e) => { e.stopPropagation(); e.preventDefault(); toggleOne(req.id); }}
                      className="flex items-center justify-center h-5 w-5 shrink-0"
                    >
                      <Checkbox
                        checked={isSel}
                        onCheckedChange={() => toggleOne(req.id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </span>
                    <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <User className="h-4 w-4 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate flex items-center gap-1.5">
                        <span className="truncate">{req.agent_full_name || 'Agent'}</span>
                        {(req.request_kind ?? 'new') === 'topup' && (
                          <Badge variant="outline" className="shrink-0 text-[9px] px-1.5 py-0 h-4 uppercase tracking-wider bg-violet-100 text-violet-800 border-violet-300 dark:bg-violet-950/30 dark:text-violet-400">
                            Top-up +{Number(req.extend_days ?? 0)}d
                          </Badge>
                        )}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-primary">{formatUGX(requested)}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  </div>

                  {failureMsg && (
                    <div className="mt-2 flex items-start gap-1.5 rounded-md bg-red-50 dark:bg-red-950/30 px-2 py-1 text-[10px] text-red-700 dark:text-red-400">
                      <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                      <span className="truncate">Last run: {failureMsg}</span>
                    </div>
                  )}
                </CardContent>
              </Card>
            </button>
          </div>
        );
      })}

      <AgentAdvanceEvaluationDialog
        req={selected}
        agentName={selected?.agent_full_name}
        potential={selected?.agent_id ? potentialMap[selected.agent_id] : undefined}
        onClose={() => setSelected(null)}
        footer={selected ? (
          <>
            <DuplicateAccountAlert
              dups={selected.agent_id ? duplicateMap[selected.agent_id] : undefined}
              flag={selected.agent_id ? duplicateFlagMap[selected.agent_id] : undefined}
              className="mb-3"
            />
            <div>
              <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1 block">
                Approved amount (UGX)
              </Label>
              <Input
                type="number"
                inputMode="numeric"
                min={1000}
                step={1000}
                value={amounts[selected.id] ?? String(num(selected.principal))}
                onChange={(e) => setAmounts((prev) => ({ ...prev, [selected.id]: e.target.value }))}
                className="text-sm font-semibold"
              />
              {getEditedAmount(selected) !== num(selected.principal) && (
                <p className="mt-1 text-[10px] text-amber-600 font-medium">
                  Adjusted from requested {formatUGX(num(selected.principal))} → {formatUGX(getEditedAmount(selected))}
                </p>
              )}
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1">
                Decision note / rejection reason
              </p>
              <Textarea
                placeholder="Add a note. If rejecting, this reason is shown to the agent."
                value={notes[selected.id] || ''}
                onChange={(e) => setNotes((prev) => ({ ...prev, [selected.id]: e.target.value }))}
                rows={2}
                className="text-sm"
              />
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => {
                  const amt = getEditedAmount(selected);
                  if (amt < 1000) {
                    toast.error('Approved amount must be at least UGX 1,000');
                    return;
                  }
                  setConfirm({ id: selected.id, amount: amt, original: num(selected.principal) });
                }}
                disabled={approveMutation.isPending}
                className="flex-1 gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                {approveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Approve
              </Button>
              <Button
                onClick={() => approveMutation.mutate({ id: selected.id, approve: false })}
                disabled={approveMutation.isPending}
                variant="destructive"
                className="flex-1 gap-1.5"
              >
                <XCircle className="h-4 w-4" /> Reject
              </Button>
            </div>
            <Button
              variant="outline"
              className="w-full gap-1.5 border-red-400 text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
              onClick={() => setDupRejectReq(selected)}
            >
              <AlertTriangle className="h-4 w-4" /> Reject as duplicate account & block
            </Button>
          </>
        ) : null}
      />

      <RejectAsDuplicateDialog
        requestId={dupRejectReq?.id ?? null}
        agentName={dupRejectReq?.agent_full_name}
        dups={dupRejectReq?.agent_id ? duplicateMap[dupRejectReq.agent_id] : undefined}
        onOpenChange={(open) => { if (!open) setDupRejectReq(null); }}
        onDone={() => { setDupRejectReq(null); setSelected(null); }}
      />

      <AlertDialog open={!!confirm} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <AlertDialogTitle className="text-center">Confirm advance approval</AlertDialogTitle>
            <AlertDialogDescription className="text-center">
              By default this sends the request to CFO for final disbursement. You can skip
              the CFO step and disburse to the agent&apos;s wallet immediately below.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {confirm && (
            <div className="my-2 rounded-xl border bg-muted/40 p-4 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Agent requested</span>
                <span className="font-semibold">{formatUGX(confirm.original)}</span>
              </div>
              <div className="flex items-center justify-between text-base">
                <span className="font-semibold">Approving</span>
                <span className="font-bold text-emerald-600">{formatUGX(confirm.amount)}</span>
              </div>
              {confirm.amount !== confirm.original && (
                <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>
                    Adjusted by {formatUGX(Math.abs(confirm.amount - confirm.original))}{' '}
                    {confirm.amount > confirm.original ? 'above' : 'below'} the agent's request.
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="rounded-xl border bg-muted/40 p-3">
            <p className="text-[11px] text-muted-foreground">
              CFO approval is mandatory. Approving here sends the request to the CFO queue —
              no money moves until the CFO approves and disburses it.
            </p>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={approveMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={approveMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (!confirm) return;
                approveMutation.mutate({
                  id: confirm.id,
                  approve: true,
                  principal: confirm.amount,
                });
              }}
              className="text-white bg-emerald-600 hover:bg-emerald-700"
            >
              {approveMutation.isPending ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-1.5" /> Approving…</>
              ) : (
                <>Confirm approval</>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>

        </AlertDialogContent>
      </AlertDialog>

      {/* Sticky bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="sticky bottom-2 z-30 mt-3">
          <div className="mx-auto max-w-3xl rounded-2xl border bg-background/95 backdrop-blur shadow-lg p-3 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 mr-auto">
              <Layers className="h-4 w-4 text-primary" />
              <div className="text-xs">
                <p className="font-bold">{selectedIds.size} selected · {formatUGX(selectedTotal)}</p>
                {hasFlaggedInSelection && (
                  <p className="text-[10px] text-amber-600 font-medium">Some rows are above suggested / limit</p>
                )}
              </div>
            </div>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => { setBulkAction('reject'); setBulkAckFlagged(false); }}
              className="gap-1.5"
            >
              <XCircle className="h-3.5 w-3.5" /> Reject
            </Button>
            <Button
              size="sm"
              onClick={() => { setBulkAction('approve_to_cfo'); setBulkAckFlagged(false); }}
              className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              <CheckCircle2 className="h-3.5 w-3.5" /> Approve → CFO
            </Button>
          </div>
        </div>
      )}

      {/* Bulk confirm dialog */}
      <AlertDialog
        open={!!bulkAction}
        onOpenChange={(open) => {
          if (!open && !bulkRunning) {
            setBulkAction(null);
            setBulkAckFlagged(false);
          }
        }}
      >
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {bulkAction === 'reject'
                ? `Reject ${selectedRequests.length} advance request${selectedRequests.length === 1 ? '' : 's'}`
                : `Send ${selectedRequests.length} advance${selectedRequests.length === 1 ? '' : 's'} to CFO`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {bulkAction === 'reject'
                ? 'Each agent will see the rejection reason below.'
                : 'Each request will move to the CFO queue with the note below (if any). CFO approval is mandatory before any money moves.'}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="max-h-56 overflow-y-auto rounded-lg border bg-muted/30 p-2 space-y-1">
            {selectedRequests.map((r: any) => {
              const amt = getEditedAmount(r);
              const flagged = isFlagged(r);
              return (
                <div key={r.id} className="flex items-center justify-between text-[11px] py-1 px-1.5 rounded">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold truncate">{r.agent_full_name || 'Agent'}</p>
                    <p className="text-[10px] text-muted-foreground truncate">{r.agent_phone || ''}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-bold">{formatUGX(amt)}</p>
                    {flagged && (
                      <p className="text-[10px] text-amber-600 inline-flex items-center gap-1">
                        <AlertTriangle className="h-2.5 w-2.5" /> Above suggested/limit
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {bulkAction !== 'reject' && (
            <div className="flex items-center justify-between text-xs mt-1 px-1">
              <span className="text-muted-foreground">Combined total</span>
              <span className="font-bold">{formatUGX(selectedTotal)}</span>
            </div>
          )}

          <div className="space-y-2">
            <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              {bulkAction === 'reject' ? 'Rejection reason (shown to agents)' : 'Shared decision note (optional)'}
            </Label>
            <Textarea
              value={bulkNotes}
              onChange={(e) => setBulkNotes(e.target.value)}
              rows={2}
              placeholder={bulkAction === 'reject' ? 'Reason applied to every rejected request…' : 'Applied to every approved request…'}
              disabled={bulkRunning}
            />
          </div>


          {hasFlaggedInSelection && bulkAction !== 'reject' && (
            <label className="flex items-start gap-2 cursor-pointer select-none text-[11px] mt-1">
              <Checkbox
                checked={bulkAckFlagged}
                onCheckedChange={(v) => setBulkAckFlagged(!!v)}
                className="mt-0.5"
                disabled={bulkRunning}
              />
              <span>I've reviewed the flagged rows (above suggested or over current limit).</span>
            </label>
          )}

          {bulkRunning && bulkProgress && (
            <div className="rounded-md bg-muted p-2 text-[11px] flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Processing {bulkProgress.done} of {bulkProgress.total}…
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkRunning}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={
                bulkRunning ||
                (bulkAction === 'reject' && bulkNotes.trim().length < 3) ||
                (hasFlaggedInSelection && bulkAction !== 'reject' && !bulkAckFlagged)
              }
              onClick={(e) => { e.preventDefault(); runBulk(); }}
              className={cn(
                'text-white',
                bulkAction === 'reject' && 'bg-red-600 hover:bg-red-700',
                bulkAction === 'approve_to_cfo' && 'bg-emerald-600 hover:bg-emerald-700',
              )}
            >
              {bulkRunning ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-1.5" /> Working…</>
              ) : bulkAction === 'reject' ? (
                <>Reject {selectedRequests.length}</>
              ) : (
                <>Approve {selectedRequests.length}</>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
