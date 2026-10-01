import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, FileText, ClipboardCheck } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { requisitionApprovalError } from '@/lib/requisitionApprovalError';
import {
  APPROVAL_TOAST_OPTIONS, REQUISITION_APPROVED_MESSAGE,
} from './approvalToast';

/**
 * Blocking requisition prompt — for the named approver only, at the COO, CEO
 * and CFO stages of an ordinary requisition.
 *
 * FAIL OPEN: the modal renders only when `staff_requisition_pending_prompt()`
 * succeeds AND returns a row. Any error, timeout or offline state leaves the
 * app fully usable. No role check is performed; the rpc alone decides who is
 * prompted.
 *
 * Accept and Decline call the single existing decision path
 * (`staff-requisition-decide`) with the same arguments as the review queue.
 * There is no second decision path and the gate never writes the stage itself.
 */

const POLL_MS = 5 * 60 * 1000;

type Stage = 'coo' | 'ceo' | 'cfo';

interface Prompt {
  prompt_id: string;
  stage: Stage;
  requisition_id: string;
  requisition_code: string;
  requester_name: string | null;
  department_key: string | null;
  title: string;
  reason: string;
  amount: number;
  approved_amount: number | null;
  currency: string | null;
  attachment_urls: string[] | null;
  raised_at: string;
  coo_approver_name: string | null;
  ceo_approver_name: string | null;
  snooze_count: number;
  total_pending: number;
}

const HEADINGS: Record<Stage, string> = {
  coo: 'Requisition needs COO approval',
  ceo: 'Requisition needs CEO approval',
  cfo: 'Requisition needs CFO approval and release',
};

function fmtDay(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });
}

export function StaffRequisitionApprovalGate() {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [declining, setDeclining] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [working, setWorking] = useState(false);
  const [viewingPath, setViewingPath] = useState<string | null>(null);
  const [openedAttachment, setOpenedAttachment] = useState(false);
  const suppressedUntilRef = useRef(0);
  const laterTimerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (Date.now() < suppressedUntilRef.current) return;
    try {
      const { data, error } = await supabase.rpc('staff_requisition_pending_prompt' as never);
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
    return () => {
      window.clearInterval(timer);
      if (laterTimerRef.current) window.clearTimeout(laterTimerRef.current);
    };
  }, [load]);

  useEffect(() => {
    setDeclining(false);
    setRejectReason('');
    setOpenedAttachment(false);
  }, [prompt?.prompt_id]);

  const attachments = prompt?.attachment_urls ?? [];
  const amount = Number(prompt?.approved_amount ?? prompt?.amount ?? 0);

  const viewAttachment = async (path: string) => {
    if (!prompt) return;
    setViewingPath(path);
    const { data, error } = await invokeEdgeFunction<{ url: string }>('staff-requisition-attachment-url', {
      body: { requisition_id: prompt.requisition_id, path },
      errorTitle: 'Could not open receipt',
    });
    setViewingPath(null);
    if (!error && data?.url) {
      setOpenedAttachment(true);
      window.open(data.url, '_blank');
    }
  };

  const decide = async (action: 'approve' | 'reject', comment: string) => {
    if (!prompt) return;
    setWorking(true);
    const { error } = await invokeEdgeFunction('staff-requisition-decide', {
      body: {
        requisition_id: prompt.requisition_id,
        action,
        comment,
        ...(action === 'approve' ? { amount } : {}),
      },
      errorTitle: 'Decision failed',
      silent: true,
    });
    setWorking(false);
    if (error) {
      toast.error(
        action === 'approve'
          ? requisitionApprovalError(error.message, prompt.stage.toUpperCase())
          : error.message,
      );
      return;
    }
    if (action === 'approve') {
      toast.success(REQUISITION_APPROVED_MESSAGE, APPROVAL_TOAST_OPTIONS);
    } else {
      toast.success('Requisition declined');
    }
    setPrompt(null);
    void load();
  };

  const decline = async () => {
    if (rejectReason.trim().length < 10) {
      toast.error('Give the requester a reason (at least 10 characters)');
      return;
    }
    await decide('reject', rejectReason.trim());
  };

  const later = async () => {
    if (!prompt) return;
    setWorking(true);
    const { data, error } = await supabase.rpc('staff_requisition_prompt_snooze' as never);
    setWorking(false);
    if (error) { toast.error(error.message); return; }
    const until = new Date(String(data)).getTime();
    const delay = Number.isFinite(until) ? Math.max(1000, until - Date.now() + 5000) : 30 * 60 * 1000;
    suppressedUntilRef.current = Date.now() + delay;
    if (laterTimerRef.current) window.clearTimeout(laterTimerRef.current);
    laterTimerRef.current = window.setTimeout(() => { void load(); }, delay + 500);
    setPrompt(null);
  };

  if (!prompt) return null;

  const needsReceipt = attachments.length > 0 && !openedAttachment;
  const earlier = [
    prompt.coo_approver_name ? `COO: ${prompt.coo_approver_name}` : null,
    prompt.ceo_approver_name ? `CEO: ${prompt.ceo_approver_name}` : null,
  ].filter(Boolean).join(' • ');

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
            <ClipboardCheck className="h-5 w-5 text-primary" /> {HEADINGS[prompt.stage]}
          </DialogTitle>
          <DialogDescription>
            {prompt.requester_name || 'Staff member'}
            {prompt.department_key ? ` • ${prompt.department_key}` : ''}
            {' • '}{prompt.requisition_code} • raised {fmtDay(prompt.raised_at)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {Number(prompt.total_pending) > 1 && (
            <p className="text-xs font-medium text-muted-foreground">
              1 of {Number(prompt.total_pending)}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold">{prompt.title}</p>
            <p className="text-lg font-bold text-primary">{formatUGX(amount)}</p>
          </div>

          {prompt.snooze_count > 0 && (
            <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700">
              Deferred {prompt.snooze_count} {prompt.snooze_count === 1 ? 'time' : 'times'}
            </Badge>
          )}

          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{prompt.reason}</p>

          {earlier && (
            <p className="text-xs text-muted-foreground">Already approved by — {earlier}</p>
          )}

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachments.map((path, i) => (
                <Button
                  key={path}
                  size="sm"
                  variant="outline"
                  onClick={() => void viewAttachment(path)}
                  disabled={viewingPath === path}
                >
                  {viewingPath === path
                    ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    : <FileText className="mr-2 h-3.5 w-3.5" />}
                  Receipt {i + 1}
                </Button>
              ))}
            </div>
          )}

          {declining && (
            <Textarea
              rows={3}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Tell the requester why this is declined (at least 10 characters)"
            />
          )}

          <div className="space-y-1 pt-1">
            <div className="flex flex-wrap gap-2">
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
                  <Button onClick={() => void decide('approve', '')} disabled={working || needsReceipt}>
                    {working && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Accept
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
            {!declining && needsReceipt && (
              <p className="text-xs text-muted-foreground">Open the receipt to enable Accept.</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default StaffRequisitionApprovalGate;
