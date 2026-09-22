import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Landmark } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { staffLoanSchedule } from '@/lib/staffLoanSchedule';

/**
 * Blocking staff loan prompt — for the named approver only.
 *
 * FAIL OPEN: the modal renders only when `staff_loan_pending_prompt()` succeeds
 * AND returns a row. Any error, timeout or offline state leaves the app fully
 * usable. No role check is performed; the rpc alone decides who is prompted.
 *
 * The client never writes wallet_credit_status — only `staff_loan_disburse`
 * may mark a loan disbursed, because it posts the ledger entries in the same
 * transaction.
 */

const POLL_MS = 5 * 60 * 1000;
const SNOOZE_MS = 2 * 60 * 60 * 1000;

interface Prompt {
  prompt_id: string;
  kind: 'hr' | 'ceo' | 'cfo';
  requisition_id: string;
  requisition_code: string;
  borrower_name: string;
  amount: number;
  currency: string;
  months: number;
  monthly_rate: number;
  interest_method: 'flat' | 'compound';
  reason: string;
  snooze_count: number;
  submitted_at: string;
}

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

function fmtDay(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });
}

const HEADINGS: Record<Prompt['kind'], string> = {
  hr: 'Loan request needs your approval',
  ceo: 'Loan request needs final approval',
  cfo: 'Loan approved — ready for disbursement',
};

export function StaffLoanApprovalGate() {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [declining, setDeclining] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [working, setWorking] = useState(false);
  const suppressedUntilRef = useRef(0);

  const load = useCallback(async () => {
    if (Date.now() < suppressedUntilRef.current) return;
    try {
      const { data, error } = await supabase.rpc('staff_loan_pending_prompt' as never);
      if (error) { setPrompt(null); return; }
      const row = (Array.isArray(data) ? data[0] : data) as unknown as Prompt | undefined;
      if (!row) { setPrompt(null); return; }
      setPrompt(row);
    } catch {
      // Fail open — never block the product on a gate that cannot read itself.
      setPrompt(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    setDeclining(false);
    setRejectReason('');
  }, [prompt?.prompt_id]);

  const approve = async () => {
    if (!prompt) return;
    setWorking(true);
    const nextStage = prompt.kind === 'hr' ? 'ceo' : 'approved';
    const { error } = await supabase
      .from('staff_requisitions')
      .update({ stage: nextStage })
      .eq('id', prompt.requisition_id);
    setWorking(false);
    if (error) { toast.error(error.message); return; }
    toast.success('Loan request approved');
    setPrompt(null);
    void load();
  };

  const decline = async () => {
    if (!prompt) return;
    if (rejectReason.trim().length < 10) {
      toast.error('Give the borrower a reason (at least 10 characters)');
      return;
    }
    setWorking(true);
    const { error } = await supabase
      .from('staff_requisitions')
      .update({ stage: 'rejected', rejection_reason: rejectReason.trim() })
      .eq('id', prompt.requisition_id);
    setWorking(false);
    if (error) { toast.error(error.message); return; }
    toast.success('Loan request declined');
    setPrompt(null);
    void load();
  };

  const disburse = async () => {
    if (!prompt) return;
    setWorking(true);
    const { error } = await supabase.rpc('staff_loan_disburse' as never, {
      _requisition_id: prompt.requisition_id,
    } as never);
    setWorking(false);
    if (error) { toast.error(error.message); return; }
    toast.success('Loan disbursed');
    setPrompt(null);
    void load();
  };

  const later = async () => {
    if (!prompt) return;
    setWorking(true);
    const { error } = await supabase.rpc('staff_loan_prompt_snooze' as never, {
      _prompt_id: prompt.prompt_id,
    } as never);
    setWorking(false);
    if (error) { toast.error(error.message); return; }
    suppressedUntilRef.current = Date.now() + SNOOZE_MS;
    setPrompt(null);
  };

  if (!prompt) return null;

  const isDisbursement = prompt.kind === 'cfo';
  const amount = Number(prompt.amount);
  const schedule = staffLoanSchedule(
    amount,
    Number(prompt.months),
    Number(prompt.monthly_rate),
    prompt.interest_method === 'compound' ? 'compound' : 'flat',
  );

  return (
    <Dialog open onOpenChange={() => { /* cannot be dismissed */ }}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg [&>button]:hidden"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Landmark className="h-5 w-5 text-primary" /> {HEADINGS[prompt.kind]}
          </DialogTitle>
          <DialogDescription>
            {prompt.borrower_name} • {prompt.requisition_code} • submitted {fmtDate(prompt.submitted_at)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold">
              {Number(prompt.months)} {Number(prompt.months) === 1 ? 'month' : 'months'}
            </p>
            <p className="text-lg font-bold text-primary">{formatUGX(amount)}</p>
          </div>

          {prompt.snooze_count > 0 && (
            <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700">
              Deferred {prompt.snooze_count} {prompt.snooze_count === 1 ? 'time' : 'times'} already
            </Badge>
          )}

          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{prompt.reason}</p>

          <div className="grid grid-cols-3 gap-2 rounded-xl border p-3 text-center text-xs">
            <div>
              <p className="text-muted-foreground">Amount borrowed</p>
              <p className="mt-1 font-semibold">{formatUGX(amount)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Total interest</p>
              <p className="mt-1 font-semibold">{formatUGX(schedule.interest)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Total to repay</p>
              <p className="mt-1 font-semibold">{formatUGX(schedule.totalRepayable)}</p>
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 text-left">#</th>
                  <th className="px-2 py-1.5 text-left">Due on</th>
                  <th className="px-2 py-1.5 text-right">Instalment</th>
                </tr>
              </thead>
              <tbody>
                {schedule.instalments.map((i) => (
                  <tr key={i.seq} className="border-t">
                    <td className="px-2 py-1.5">{i.seq}</td>
                    <td className="px-2 py-1.5">{fmtDay(i.dueOn)}</td>
                    <td className="px-2 py-1.5 text-right font-medium">{formatUGX(i.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {declining && (
            <div className="space-y-2">
              <Textarea
                rows={3}
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Tell the borrower why this is declined (at least 10 characters)"
              />
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            {declining ? (
              <>
                <Button variant="outline" onClick={() => setDeclining(false)} disabled={working}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={() => void decline()} disabled={working}>
                  {working && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Confirm decline
                </Button>
              </>
            ) : (
              <>
                <Button onClick={() => void (isDisbursement ? disburse() : approve())} disabled={working}>
                  {working && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {isDisbursement ? 'Disburse' : 'Approve'}
                </Button>
                {!isDisbursement && (
                  <Button variant="destructive" onClick={() => setDeclining(true)} disabled={working}>
                    Decline
                  </Button>
                )}
                <Button variant="outline" onClick={() => void later()} disabled={working}>
                  Later
                </Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default StaffLoanApprovalGate;
