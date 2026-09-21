import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/creditFeeCalculations';

/**
 * Blocking facilitation approval prompt — for the named approver only.
 *
 * FAIL OPEN: the modal renders only when `pso_facilitation_pending_prompt()`
 * succeeds AND returns a row. Any error, timeout or offline state leaves the
 * app fully usable. No role check is performed; the rpc alone decides who is
 * prompted.
 */

const POLL_MS = 5 * 60 * 1000;
const SNOOZE_MS = 2 * 60 * 60 * 1000;

interface Prompt {
  prompt_id: string;
  requisition_id: string;
  requisition_code: string;
  officer_name: string;
  title: string;
  reason: string;
  amount: number;
  currency: string;
  snooze_count: number;
  submitted_at: string;
}

interface PlanLine {
  id: string;
  seq: number;
  purpose: string;
  location: string;
  amount: number;
}

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

export function FacilitationApprovalGate() {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [lines, setLines] = useState<PlanLine[]>([]);
  const [declining, setDeclining] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [working, setWorking] = useState(false);
  const suppressedUntilRef = useRef(0);

  const load = useCallback(async () => {
    if (Date.now() < suppressedUntilRef.current) return;
    try {
      const { data, error } = await supabase.rpc('pso_facilitation_pending_prompt');
      if (error) { setPrompt(null); return; }
      const row = (Array.isArray(data) ? data[0] : data) as unknown as Prompt | undefined;
      if (!row) { setPrompt(null); return; }
      setPrompt(row);
      const { data: planData } = await supabase
        .from('staff_facilitation_plan_lines')
        .select('id, seq, purpose, location, amount')
        .eq('requisition_id', row.requisition_id)
        .order('seq', { ascending: true });
      setLines((planData || []) as unknown as PlanLine[]);
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
    const { error } = await supabase
      .from('staff_requisitions')
      .update({ stage: 'approved' })
      .eq('id', prompt.requisition_id);
    setWorking(false);
    if (error) { toast.error(error.message); return; }
    toast.success('Facilitation approved');
    setPrompt(null);
    void load();
  };

  const decline = async () => {
    if (!prompt) return;
    if (rejectReason.trim().length < 10) {
      toast.error('Give the officer a reason (at least 10 characters)');
      return;
    }
    setWorking(true);
    const { error } = await supabase
      .from('staff_requisitions')
      .update({ stage: 'rejected', rejection_reason: rejectReason.trim() })
      .eq('id', prompt.requisition_id);
    setWorking(false);
    if (error) { toast.error(error.message); return; }
    toast.success('Facilitation declined');
    setPrompt(null);
    void load();
  };

  const later = async () => {
    if (!prompt) return;
    setWorking(true);
    const { error } = await supabase.rpc('pso_facilitation_prompt_snooze', { _prompt_id: prompt.prompt_id });
    setWorking(false);
    if (error) { toast.error(error.message); return; }
    suppressedUntilRef.current = Date.now() + SNOOZE_MS;
    setPrompt(null);
  };

  if (!prompt) return null;

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
            <ShieldAlert className="h-5 w-5 text-primary" /> Facilitation needs your decision
          </DialogTitle>
          <DialogDescription>
            {prompt.officer_name} • {prompt.requisition_code} • submitted {fmtDate(prompt.submitted_at)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold">{prompt.title}</p>
            <p className="text-lg font-bold text-primary">{formatUGX(Number(prompt.amount))}</p>
          </div>

          {prompt.snooze_count > 0 && (
            <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700">
              Deferred {prompt.snooze_count} {prompt.snooze_count === 1 ? 'time' : 'times'} already
            </Badge>
          )}

          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{prompt.reason}</p>

          <div className="overflow-hidden rounded-xl border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 text-left">Purpose / activity</th>
                  <th className="px-2 py-1.5 text-left">Location</th>
                  <th className="px-2 py-1.5 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} className="border-t">
                    <td className="px-2 py-1.5">{l.purpose}</td>
                    <td className="px-2 py-1.5">{l.location}</td>
                    <td className="px-2 py-1.5 text-right font-medium">{formatUGX(Number(l.amount))}</td>
                  </tr>
                ))}
                {lines.length === 0 && (
                  <tr><td colSpan={3} className="px-2 py-3 text-center text-muted-foreground">No plan rows.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {declining && (
            <div className="space-y-2">
              <Textarea
                rows={3}
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Tell the officer why this is declined (at least 10 characters)"
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
                <Button onClick={() => void approve()} disabled={working}>
                  {working && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Approve
                </Button>
                <Button variant="destructive" onClick={() => setDeclining(true)} disabled={working}>
                  Decline
                </Button>
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

export default FacilitationApprovalGate;
