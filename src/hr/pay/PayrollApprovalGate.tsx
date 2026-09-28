import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Banknote } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/creditFeeCalculations';

/**
 * Blocking payroll prompt — for the named approver only. Modelled on
 * StaffLoanApprovalGate.
 *
 * FAIL OPEN: the modal renders only when `hr_pay_pending_prompt()` succeeds AND
 * returns a row. Any error, timeout or offline state leaves the app usable. No
 * role check is performed; the rpc alone decides who is prompted.
 *
 * It deliberately takes no payroll action itself. Approving a run and releasing
 * money happen on the run page, where the register, the dry run and the RELEASE
 * confirmation are. The prompt only brings the person there, and steps aside
 * while they work.
 */

const POLL_MS = 5 * 60 * 1000;
const SNOOZE_MS = 2 * 60 * 60 * 1000;
const WORKING_MS = 30 * 60 * 1000;

interface Prompt {
  prompt_id: string;
  kind: 'approve' | 'release' | 'lock';
  run_id: string;
  period_code: string;
  run_type: string;
  employees: number;
  total_net: number;
  unpaid_count: number;
  unpaid_net: number;
  snooze_count: number;
  raised_at: string;
}

const HEADINGS: Record<Prompt['kind'], string> = {
  approve: 'Payroll needs your approval',
  release: 'Payroll approved — ready for payment',
  lock: 'Payroll paid — ready to lock',
};

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

export function PayrollApprovalGate() {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [working, setWorking] = useState(false);
  const suppressedUntilRef = useRef(0);
  const location = useLocation();
  const navigate = useNavigate();

  const load = useCallback(async () => {
    if (Date.now() < suppressedUntilRef.current) return;
    try {
      const { data, error } = await supabase.rpc('hr_pay_pending_prompt' as never);
      if (error) { setPrompt(null); return; }
      const raw = data as unknown;
      const row = (Array.isArray(raw) ? raw[0] : raw) as Prompt | undefined | null;
      setPrompt(row ?? null);
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

  // Re-check on every navigation, so the prompt appears promptly and clears
  // promptly once the run has moved on.
  useEffect(() => {
    void load();
  }, [location.pathname, load]);

  const openRun = () => {
    if (!prompt) return;
    suppressedUntilRef.current = Date.now() + WORKING_MS;
    const target = `/hr/pay/runs/${prompt.run_id}`;
    setPrompt(null);
    navigate(target);
  };

  const later = async () => {
    if (!prompt) return;
    setWorking(true);
    const { error } = await supabase.rpc('hr_pay_prompt_snooze' as never, {
      _prompt_id: prompt.prompt_id,
    } as never);
    setWorking(false);
    if (error) { toast.error(error.message); return; }
    suppressedUntilRef.current = Date.now() + SNOOZE_MS;
    setPrompt(null);
  };

  if (!prompt) return null;
  if (location.pathname === `/hr/pay/runs/${prompt.run_id}`) return null;

  const totalNet = Number(prompt.total_net);
  const unpaidNet = Number(prompt.unpaid_net);
  const unpaidCount = Number(prompt.unpaid_count);
  const partlyPaid = prompt.kind === 'release' && unpaidNet < totalNet;
  const label = `Payroll ${prompt.period_code}${prompt.run_type !== 'regular' ? ` · ${prompt.run_type}` : ''}`;

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
            <Banknote className="h-5 w-5 text-primary" /> {HEADINGS[prompt.kind]}
          </DialogTitle>
          <DialogDescription>
            {label} • raised {fmtDate(prompt.raised_at)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold">
              {prompt.kind === 'release' ? 'Still to pay' : 'Total net pay'}
            </p>
            <p className="text-lg font-bold text-primary">
              {formatUGX(prompt.kind === 'release' ? unpaidNet : totalNet)}
            </p>
          </div>

          {prompt.snooze_count > 0 && (
            <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700">
              Deferred {prompt.snooze_count} {prompt.snooze_count === 1 ? 'time' : 'times'} already
            </Badge>
          )}

          <div className="grid grid-cols-3 gap-2 rounded-xl border p-3 text-center text-xs">
            <div>
              <p className="text-muted-foreground">Employees</p>
              <p className="mt-1 font-semibold">{Number(prompt.employees)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Total net pay</p>
              <p className="mt-1 font-semibold">{formatUGX(totalNet)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">
                {prompt.kind === 'release' ? 'People still to pay' : 'Waiting on'}
              </p>
              <p className="mt-1 font-semibold">
                {prompt.kind === 'release' ? unpaidCount : 'You'}
              </p>
            </div>
          </div>

          <p className="text-sm text-muted-foreground">
            {prompt.kind === 'approve' &&
              'Review the register and approve or return it on the run page.'}
            {prompt.kind === 'release' &&
              (partlyPaid
                ? 'Part of this run has already been paid. On the run page, tick the next batch, dry-run, then release.'
                : 'Nobody on this run has been paid yet. On the run page, tick who to pay in this batch, dry-run, then release.')}
            {prompt.kind === 'lock' &&
              'Everyone has been paid. Lock the run so the pay period can close.'}
          </p>

          <div className="flex flex-wrap gap-2 pt-1">
            <Button onClick={openRun} disabled={working}>
              Open the run
            </Button>
            <Button variant="outline" onClick={() => void later()} disabled={working}>
              {working && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Later
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default PayrollApprovalGate;
