import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Landmark, Loader2, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { requisitionApprovalError } from '@/lib/requisitionApprovalError';
import { APPROVAL_TOAST_OPTIONS, REQUISITION_APPROVED_MESSAGE } from './approvalToast';

/**
 * Staff loans and facilitation waiting for a decision or for payment (CFO 15 Nov 2026). This is where they are
 * approved, declined and paid; the reminder pop-ups only bring people here.
 *
 * Who may act is decided by the database guards (staff_loan_chain_guard, pso_facilitation_guard) and the prompt
 * tables; this screen shows the action buttons to the named approver of the current step and shows everyone else
 * whom it is waiting on. Paying goes only through `staff_loan_disburse` / `pso_facilitation_disburse`, which credit
 * the wallet and post the ledger in one transaction; this screen never writes a wallet or the ledger.
 */

type Kind = 'staff_loan' | 'facilitation';
type Step = 'hr' | 'ceo' | 'cfo' | 'approval' | 'disbursement';

interface Row {
  id: string;
  requisition_code: string;
  request_kind: Kind;
  stage: string;
  amount: number;
  loan_months: number | null;
  loan_monthly_rate: number | null;
  reason: string | null;
  title: string | null;
  requester_id: string | null;
  requester_name: string | null;
  wallet_credit_status: string | null;
  created_at: string;
}
interface PromptRow { requisition_id: string; kind: string; approver_id: string }
export interface ApprovalItem {
  row: Row;
  step: Step;
  borrower: string;
  approverId: string | null;
  approverName: string | null;
}

const STEP_LABEL: Record<Step, string> = {
  hr: 'HR approval',
  ceo: 'CEO approval',
  cfo: 'Waiting to be paid',
  approval: 'Approval',
  disbursement: 'Waiting to be paid',
};
const isPayStep = (s: Step) => s === 'cfo' || s === 'disbursement';

function stepOf(r: Row): Step | null {
  const paid = (r.wallet_credit_status ?? '') === 'credited';
  if (r.request_kind === 'staff_loan') {
    if (r.stage === 'hr') return 'hr';
    if (r.stage === 'ceo') return 'ceo';
    if (r.stage === 'approved' && !paid) return 'cfo';
    return null;
  }
  if (r.stage === 'coo') return 'approval';
  if (r.stage === 'approved' && !paid) return 'disbursement';
  return null;
}

export const STAFF_APPROVALS_KEY = ['staff-approvals-queue'] as const;

async function loadQueue(): Promise<ApprovalItem[]> {
  const { data: reqs, error } = await supabase
    .from('staff_requisitions')
    .select('id, requisition_code, request_kind, stage, amount, loan_months, loan_monthly_rate, reason, title, requester_id, requester_name, wallet_credit_status, created_at')
    .in('request_kind', ['staff_loan', 'facilitation'])
    .in('stage', ['hr', 'ceo', 'coo', 'approved'])
    .order('created_at', { ascending: true });
  if (error) throw error;
  const rows = ((reqs ?? []) as unknown as Row[]).filter((r) => stepOf(r) !== null);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [loanP, facP] = await Promise.all([
    supabase.from('staff_loan_prompts' as never).select('requisition_id, kind, approver_id').in('requisition_id', ids).neq('state', 'resolved'),
    supabase.from('pso_facilitation_prompts' as never).select('requisition_id, kind, approver_id').in('requisition_id', ids).neq('state', 'resolved'),
  ]);
  const prompts = [...((loanP.data ?? []) as unknown as PromptRow[]), ...((facP.data ?? []) as unknown as PromptRow[])];
  const people = [...new Set([...prompts.map((p) => p.approver_id), ...rows.map((r) => r.requester_id)].filter(Boolean))] as string[];
  const names = new Map<string, string>();
  if (people.length) {
    const { data: profs } = await supabase.from('profiles').select('id, full_name').in('id', people);
    for (const p of (profs ?? []) as { id: string; full_name: string | null }[]) if (p.full_name) names.set(p.id, p.full_name);
  }
  return rows.map((row) => {
    const step = stepOf(row)!;
    const prompt = prompts.find((p) => p.requisition_id === row.id && p.kind === step);
    return {
      row,
      step,
      borrower: (row.requester_id && names.get(row.requester_id)) || row.requester_name || 'Staff member',
      approverId: prompt?.approver_id ?? null,
      approverName: prompt ? names.get(prompt.approver_id) ?? null : null,
    };
  });
}

export function useStaffApprovalsQueue() {
  return useQuery({ queryKey: STAFF_APPROVALS_KEY, queryFn: loadQueue, staleTime: 30_000 });
}

function fmtDay(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });
}

export function StaffApprovalsQueue({ hideWhenEmpty = false }: { hideWhenEmpty?: boolean }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { data, isLoading, error } = useStaffApprovalsQueue();
  const [declining, setDeclining] = useState<ApprovalItem | null>(null);
  const [reason, setReason] = useState('');
  const [paying, setPaying] = useState<ApprovalItem | null>(null);
  const [workingId, setWorkingId] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: STAFF_APPROVALS_KEY });

  const approve = async (it: ApprovalItem) => {
    const next = it.step === 'hr' ? 'ceo' : 'approved';
    setWorkingId(it.row.id);
    const { error: e } = await supabase.from('staff_requisitions').update({ stage: next }).eq('id', it.row.id);
    setWorkingId(null);
    if (e) { toast.error(requisitionApprovalError(e.message, it.step === 'ceo' ? 'CEO' : null)); return; }
    toast.success(REQUISITION_APPROVED_MESSAGE, {
      ...APPROVAL_TOAST_OPTIONS,
      description: it.step === 'hr' ? 'Forwarded to the CEO for final approval.'
        : it.row.request_kind === 'staff_loan' ? 'Loan request approved.' : 'Facilitation request approved.',
    });
    void refresh();
  };

  const decline = async () => {
    const it = declining;
    if (!it) return;
    if (reason.trim().length < 10) { toast.error('Give a reason (at least 10 characters)'); return; }
    setWorkingId(it.row.id);
    const { error: e } = await supabase.from('staff_requisitions')
      .update({ stage: 'rejected', rejection_reason: reason.trim() }).eq('id', it.row.id);
    setWorkingId(null);
    if (e) { toast.error(e.message); return; }
    toast.success(it.row.request_kind === 'staff_loan' ? 'Loan request declined' : 'Facilitation declined');
    setDeclining(null);
    setReason('');
    void refresh();
  };

  const pay = async () => {
    const it = paying;
    if (!it) return;
    setWorkingId(it.row.id);
    const fn = it.row.request_kind === 'staff_loan' ? 'staff_loan_disburse' : 'pso_facilitation_disburse';
    const { error: e } = await supabase.rpc(fn as never, { _requisition_id: it.row.id } as never);
    setWorkingId(null);
    if (e) { toast.error(e.message); return; }
    toast.success(it.row.request_kind === 'staff_loan' ? 'Loan paid to the wallet' : 'Facilitation paid to the wallet');
    setPaying(null);
    void refresh();
  };

  const items = data ?? [];
  if (hideWhenEmpty && !isLoading && items.length === 0) return null;

  return (
    <Card className="space-y-3 rounded-2xl p-4">
      <div>
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Landmark className="h-4 w-4 text-primary" /> Staff loans and facilitation
        </p>
        <p className="text-sm text-muted-foreground">Waiting for approval or payment. Only the person each one is waiting on can act.</p>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">Could not load staff loans and facilitation.</p>}
      {!isLoading && !error && items.length === 0 && <p className="text-sm text-muted-foreground">Nothing is waiting.</p>}

      <ul className="space-y-3">
        {items.map((it) => {
          const r = it.row;
          const mine = !!user?.id && it.approverId === user.id;
          const isLoan = r.request_kind === 'staff_loan';
          const months = Number(r.loan_months ?? 0);
          const busy = workingId === r.id;
          return (
            <li key={r.id} className="space-y-2 rounded-xl border p-3" data-testid="staff-approval-item">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {isLoan ? <Landmark className="h-4 w-4 text-muted-foreground" /> : <ShieldAlert className="h-4 w-4 text-muted-foreground" />}
                  <p className="font-semibold">{it.borrower}</p>
                  <span className="text-xs text-muted-foreground">{r.requisition_code} • {fmtDay(r.created_at)}</span>
                </div>
                <p className="text-base font-bold text-primary">{formatUGX(Number(r.amount))}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant="outline">{isLoan ? 'Staff loan' : 'Facilitation'}</Badge>
                <Badge variant={isPayStep(it.step) ? 'default' : 'secondary'}>{STEP_LABEL[it.step]}</Badge>
                {isLoan && months > 0 && <span className="text-muted-foreground">{months} {months === 1 ? 'month' : 'months'}</span>}
              </div>
              {(r.title || r.reason) && (
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">{[r.title, r.reason].filter(Boolean).join(' — ')}</p>
              )}
              {mine ? (
                <div className="flex flex-wrap gap-2 pt-1">
                  {isPayStep(it.step) ? (
                    <Button size="sm" onClick={() => setPaying(it)} disabled={busy}>Pay {formatUGX(Number(r.amount))}</Button>
                  ) : (
                    <>
                      <Button size="sm" onClick={() => void approve(it)} disabled={busy}>
                        {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Approve
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => { setDeclining(it); setReason(''); }} disabled={busy}>Decline</Button>
                    </>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Waiting on {it.approverName ?? 'the approver'}.</p>
              )}
            </li>
          );
        })}
      </ul>

      <Dialog open={!!declining} onOpenChange={(o) => { if (!o) setDeclining(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Decline {declining?.row.requisition_code}</DialogTitle>
            <DialogDescription>{declining?.borrower} will see this reason.</DialogDescription>
          </DialogHeader>
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this declined? (at least 10 characters)" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeclining(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void decline()} disabled={workingId !== null}>Confirm decline</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!paying} onOpenChange={(o) => { if (!o) setPaying(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Pay {paying?.row.requisition_code}</DialogTitle>
            <DialogDescription>
              {paying && <>{formatUGX(Number(paying.row.amount))} will be credited to {paying.borrower}&apos;s Welile wallet now.</>}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPaying(null)}>Cancel</Button>
            <Button onClick={() => void pay()} disabled={workingId !== null}>
              {workingId !== null && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Pay {paying ? formatUGX(Number(paying.row.amount)) : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default StaffApprovalsQueue;
