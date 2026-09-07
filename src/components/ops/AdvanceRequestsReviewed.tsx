import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { CheckCircle2, XCircle, Loader2, User, Inbox, Clock, Wallet, Ban, X, Zap, ChevronDown, Eye } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AgentAdvanceEvaluationDialog } from '@/components/agent/AgentAdvanceEvaluationDialog';
import { disburseAgentAdvanceRequest } from '@/lib/disburseAgentAdvance';

const num = (v: any) => Number(v ?? 0);

const APPROVED_STATUSES = [
  'agent_ops_approved', 'cfo_approved', 'cfo_paid',
  'disbursed', 'active', 'repaying', 'completed', 'overdue',
];

const REJECTED_STATUSES = ['rejected', 'cfo_rejected'];

const STATUS_LABEL: Record<string, string> = {
  agent_ops_approved: 'Agent Ops approved · awaiting CFO',
  cfo_approved: 'CFO approved · ready to disburse',
  cfo_paid: 'Disbursed',
  disbursed: 'Disbursed',
  active: 'Active',
  repaying: 'Repaying',
  completed: 'Completed',
  overdue: 'Overdue',
};

// The approval route an advance travels before it is paid out. Agent Ops is the
// only operational desk; once it approves, the request goes straight to the CFO
// for final evaluation and disbursement.
const PIPELINE: { key: string; label: string }[] = [
  { key: 'pending', label: 'Submitted' },
  { key: 'agent_ops_approved', label: 'Agent Ops' },
  { key: 'cfo_approved', label: 'CFO' },
  { key: 'disbursed', label: 'Paid out' },
];

// Statuses that mean the money has already left the building.
const PAID_STATUSES = ['cfo_paid', 'disbursed', 'active', 'repaying', 'completed', 'overdue'];

/** Index of the current stage within PIPELINE (post-payout statuses collapse to the last step). */
function stageIndex(status: string): number {
  if (PAID_STATUSES.includes(status)) return PIPELINE.length - 1;
  const i = PIPELINE.findIndex((s) => s.key === status);
  return i < 0 ? 0 : i;
}

function isPaidOut(req: any): boolean {
  return Boolean(req.cfo_paid_at) || PAID_STATUSES.includes(req.status);
}

/** The most recent moment this request moved forward — used to age how long it has been holding. */
function lastActivityAt(req: any): Date {
  const candidates = [
    req.cfo_paid_at, req.cfo_approved_at,
    req.agent_ops_reviewed_at, req.updated_at, req.created_at,
  ].filter(Boolean).map((v: string) => new Date(v).getTime());
  return new Date(candidates.length ? Math.max(...candidates) : Date.now());
}

/** Best-effort human note for an approved request (latest stage note). */
function approvalNote(req: any): string | null {
  return req.cfo_notes || req.agent_ops_notes || null;
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center">
      <Inbox className="h-7 w-7 text-muted-foreground mb-2" />
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function RequestRow({
  req, tone, onOpen, onCancel, onDisburse,
}: {
  req: any;
  tone: 'approved' | 'rejected';
  onOpen: (req: any) => void;
  onCancel?: (req: any) => void;
  onDisburse?: (req: any) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const rejectedByCfo = req.status === 'cfo_rejected';
  const note = tone === 'rejected' ? (req.rejection_reason || 'No reason recorded') : approvalNote(req);
  const paid = tone === 'approved' && isPaidOut(req);
  const idx = stageIndex(req.status);
  const holdingFor = formatDistanceToNowStrict(lastActivityAt(req));
  const holdDays = (Date.now() - lastActivityAt(req).getTime()) / 86_400_000;
  const holdTone = paid
    ? 'text-muted-foreground'
    : holdDays >= 5 ? 'text-rose-600' : holdDays >= 2 ? 'text-amber-600' : 'text-emerald-600';
  const canCancelRequest = tone === 'approved' && !paid && onCancel;
  const canDisburse = tone === 'approved' && !paid && onDisburse
    && (req.status === 'agent_ops_approved' || req.status === 'cfo_approved');

  return (
    <div className={cn(
      'rounded-xl border border-border bg-card transition-all overflow-hidden',
      expanded ? 'shadow-sm border-primary/30' : 'hover:border-primary/40'
    )}>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full text-left p-3 flex items-center gap-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0">
          <User className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate flex items-center gap-1.5">
            <span className="truncate">{req.agent_full_name || 'Agent'}</span>
            {paid && (
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" title="Paid out" />
            )}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm font-bold text-primary">{formatUGX(num(req.principal))}</p>
        </div>
        <ChevronDown className={cn(
          'h-4 w-4 text-muted-foreground shrink-0 transition-transform duration-200',
          expanded && 'rotate-180'
        )} />
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-0 border-t border-border/50 mt-1 space-y-2.5">
          <div className="pt-2 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Date requested</span>
            <span className="font-medium text-foreground">{format(new Date(req.created_at), 'MMM d, yyyy')} ({req.cycle_days}d cycle)</span>
          </div>

          {tone === 'approved' && (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge className="text-[9px] px-1.5 py-0 h-4 font-bold bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 border-0">
                  {STATUS_LABEL[req.status] || req.status}
                </Badge>
                <Badge className={cn(
                  'text-[9px] px-1.5 py-0 h-4 font-bold border-0 flex items-center gap-0.5',
                  paid ? 'bg-emerald-600 text-white' : 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
                )}>
                  <Wallet className="h-2.5 w-2.5" />{paid ? 'Paid out' : 'Not paid out'}
                </Badge>
                <span className={cn('text-[9px] font-semibold flex items-center gap-0.5', holdTone)}>
                  <Clock className="h-2.5 w-2.5" />{paid ? `Paid ${holdingFor} ago` : `Holding ${holdingFor}`}
                </span>
              </div>

              {/* Approval route — which desk it's on now */}
              <div className="flex items-center gap-1 pt-1">
                {PIPELINE.map((s, i) => (
                  <div key={s.key} className="flex-1 flex flex-col items-center gap-0.5 min-w-0">
                    <div className={cn(
                      'h-1.5 w-full rounded-full',
                      i < idx ? 'bg-emerald-500' : i === idx ? (paid ? 'bg-emerald-600' : 'bg-amber-500') : 'bg-muted',
                    )} />
                    <span className={cn(
                      'text-[7px] leading-none text-center truncate w-full',
                      i === idx ? 'font-bold text-foreground' : 'text-muted-foreground',
                    )}>{s.label}</span>
                  </div>
                ))}
              </div>
              <p className="text-[9px] text-muted-foreground">
                {paid
                  ? 'Fully disbursed to the agent wallet.'
                  : req.status === 'cfo_approved'
                    ? 'CFO approved — awaiting disbursement to the agent wallet.'
                    : 'Approved by Agent Ops — awaiting CFO evaluation & disbursement.'}
              </p>
            </>
          )}

          {note && (
            <div className={
              'rounded-lg p-2 text-[11px] leading-snug ' +
              (tone === 'rejected' ? 'bg-rose-50 text-rose-800 dark:bg-rose-950/20 dark:text-rose-300' : 'bg-muted/50 text-muted-foreground')
            }>
              <span className="font-semibold">
                {tone === 'rejected' ? (rejectedByCfo ? 'Rejected by CFO — Reason: ' : 'Rejected by Agent Ops — Reason: ') : 'Note: '}
              </span>{note}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2 pt-1 border-t border-border/40">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1.5"
              onClick={() => onOpen(req)}
            >
              <Eye className="h-3.5 w-3.5 text-primary" /> Evaluation
            </Button>
            {canDisburse && (
              <Button
                type="button"
                size="sm"
                className="h-7 gap-1 bg-amber-600 hover:bg-amber-700 text-white text-[11px]"
                onClick={() => onDisburse!(req)}
              >
                <Zap className="h-3 w-3" /> Disburse now
              </Button>
            )}
            {canCancelRequest && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-destructive border-destructive/30 hover:bg-destructive/10 text-[11px]"
                onClick={() => onCancel!(req)}
              >
                <Ban className="h-3 w-3" /> Cancel request
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function AdvanceRequestsReviewed() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [evalReq, setEvalReq] = useState<any | null>(null);
  const [cancelReq, setCancelReq] = useState<any | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [disburseReq, setDisburseReq] = useState<any | null>(null);
  const [disburseReason, setDisburseReason] = useState('');

  const disburseMutation = useMutation({
    mutationFn: async ({ req, reason }: { req: any; reason: string }) => {
      if (!user?.id) throw new Error('Not authenticated');
      if (req.status !== 'cfo_approved' && req.status !== 'cfo_paid') {
        throw new Error('CFO approval is mandatory — this request must be approved by the CFO before disbursement.');
      }
      await disburseAgentAdvanceRequest({
        req,
        actorId: user.id,
      });
    },
    onSuccess: () => {
      toast.success('Advance disbursed to agent wallet');
      setDisburseReq(null);
      setDisburseReason('');
      queryClient.invalidateQueries({ queryKey: ['advance-requests-reviewed'] });
      queryClient.invalidateQueries({ queryKey: ['advance-requests-queue'] });
      queryClient.invalidateQueries({ queryKey: ['cfo-advance-requests'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const openDisburse = (req: any) => {
    setDisburseReq(req);
    setDisburseReason('');
  };

  const cancelMutation = useMutation({
    mutationFn: async ({ req, reason }: { req: any; reason: string }) => {
      if (!user?.id) throw new Error('Not authenticated');
      const trimmed = reason.trim();
      if (trimmed.length < 10) throw new Error('Please provide a reason (min 10 chars).');
      // Cancel a request that hasn't been disbursed yet. RLS allows both
      // Agent Ops and CFO to update agent_advance_requests. Marked as
      // cfo_rejected so it lands in the rejected feed with the reason.
      const { data, error } = await supabase
        .from('agent_advance_requests')
        .update({
          status: 'cfo_rejected',
          rejection_reason: trimmed,
          cfo_notes: `Cancelled pre-disbursement: ${trimmed}`,
          cfo_approved_by: user.id,
          cfo_approved_at: new Date().toISOString(),
        })
        .eq('id', req.id)
        .in('status', ['pending', 'agent_ops_approved', 'cfo_approved'])
        .select('id')
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('Cannot cancel — the advance has already been disbursed or its status changed.');
    },
    onSuccess: () => {
      toast.success('Request cancelled — agent notified');
      setCancelReq(null);
      setCancelReason('');
      queryClient.invalidateQueries({ queryKey: ['advance-requests-reviewed'] });
      queryClient.invalidateQueries({ queryKey: ['advance-requests-queue'] });
      queryClient.invalidateQueries({ queryKey: ['cfo-advance-requests'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const openCancel = (req: any) => {
    setCancelReq(req);
    setCancelReason('');
  };

  const { data: approved = [], isLoading: loadingApproved } = useQuery({
    queryKey: ['advance-requests-reviewed', 'approved'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_advance_requests_privileged')
        .select('*')
        .in('status', APPROVED_STATUSES)
        .order('updated_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data || [];
    },
  });

  const { data: rejected = [], isLoading: loadingRejected } = useQuery({
    queryKey: ['advance-requests-reviewed', 'rejected'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_advance_requests_privileged')
        .select('*')
        .in('status', REJECTED_STATUSES)
        .order('updated_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data || [];
    },
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Approved */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" /> Approved
            </h3>
            <Badge variant="secondary" className="text-xs">{approved.length}</Badge>
          </div>
          {loadingApproved ? (
            <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : approved.length === 0 ? (
            <EmptyState label="No approved requests yet" />
          ) : (
            <div className="space-y-2">
              {approved.map((req: any) => (
                <RequestRow
                  key={req.id}
                  req={req}
                  tone="approved"
                  onOpen={setEvalReq}
                  onCancel={openCancel}
                  onDisburse={openDisburse}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Rejected */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold flex items-center gap-1.5">
              <XCircle className="h-4 w-4 text-rose-600" /> Rejected
            </h3>
            <Badge variant="secondary" className="text-xs">{rejected.length}</Badge>
          </div>
          {loadingRejected ? (
            <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : rejected.length === 0 ? (
            <EmptyState label="No rejected requests" />
          ) : (
            <div className="space-y-2">
              {rejected.map((req: any) => <RequestRow key={req.id} req={req} tone="rejected" onOpen={setEvalReq} />)}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Shared advance-eligibility evaluation popup */}
      <AgentAdvanceEvaluationDialog
        req={evalReq}
        agentName={evalReq?.agent_full_name}
        onClose={() => setEvalReq(null)}
      />

      {/* Cancel-request reason dialog */}
      <Dialog open={!!cancelReq} onOpenChange={(o) => { if (!o && !cancelMutation.isPending) { setCancelReq(null); setCancelReason(''); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Ban className="h-5 w-5 text-destructive" /> Cancel advance request
            </DialogTitle>
            <DialogDescription className="text-xs">
              {cancelReq ? (
                <>Cancel <span className="font-semibold text-foreground">{cancelReq.agent_full_name || 'this agent'}</span>&apos;s request for {formatUGX(num(cancelReq.principal))}. The agent will see the reason.</>
              ) : 'Provide a reason. The agent will see it.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Reason (min 10 chars)</Label>
            <Textarea
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              rows={4}
              placeholder="E.g. Duplicate of a pending advance, agent asked to withdraw, exposure too high…"
              className="text-sm"
            />
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => { setCancelReq(null); setCancelReason(''); }}
              disabled={cancelMutation.isPending}
            >
              <X className="h-4 w-4 mr-1" /> Keep request
            </Button>
            <Button
              variant="destructive"
              className="w-full sm:w-auto gap-2"
              disabled={cancelReason.trim().length < 10 || cancelMutation.isPending}
              onClick={() => cancelReq && cancelMutation.mutate({ req: cancelReq, reason: cancelReason })}
            >
              {cancelMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
              Confirm cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disburse-now confirm dialog */}
      <Dialog open={!!disburseReq} onOpenChange={(o) => { if (!o && !disburseMutation.isPending) { setDisburseReq(null); setDisburseReason(''); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Zap className="h-5 w-5 text-amber-600" /> Disburse advance now
            </DialogTitle>
            <DialogDescription className="text-xs">
              {disburseReq ? (
                <>Disburse <span className="font-semibold text-foreground">{formatUGX(num(disburseReq.principal))}</span> to{' '}
                  <span className="font-semibold text-foreground">{disburseReq.agent_full_name || 'this agent'}</span>&apos;s wallet.
                  Daily deductions start immediately. Only CFO-approved advances can be disbursed.
                </>
              ) : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => { setDisburseReq(null); setDisburseReason(''); }}
              disabled={disburseMutation.isPending}
            >
              <X className="h-4 w-4 mr-1" /> Cancel
            </Button>
            <Button
              className="w-full sm:w-auto gap-2 bg-amber-600 hover:bg-amber-700 text-white"
              disabled={
                disburseMutation.isPending ||
                (disburseReq ? !['cfo_approved', 'cfo_paid'].includes(disburseReq.status) : true)
              }
              onClick={() => disburseReq && disburseMutation.mutate({ req: disburseReq, reason: disburseReason })}
            >
              {disburseMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
              Disburse now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
