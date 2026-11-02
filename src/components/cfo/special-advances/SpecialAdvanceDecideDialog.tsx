import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  describeSpecialAdvanceError,
  type CorrectionDecision,
} from '@/lib/specialAdvances';
import {
  useDecideSpecialAdvanceCorrection,
  useDecideProvisionReview,
  useDecideSpecialAdvanceWriteOff,
} from '@/hooks/useSpecialAdvances';
import { SpecialAdvanceStepUpDialog } from './SpecialAdvanceStepUpDialog';

interface SpecialAdvanceDecideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: {
    type: 'correction' | 'provision_review' | 'write_off';
    id: string;
    reference: string;
    decision: CorrectionDecision;
  } | null;
  onSuccess?: () => void;
}

export function SpecialAdvanceDecideDialog({
  open,
  onOpenChange,
  target,
  onSuccess,
}: SpecialAdvanceDecideDialogProps) {
  const decideCorrection = useDecideSpecialAdvanceCorrection();
  const decideProvision = useDecideProvisionReview();
  const decideWriteOff = useDecideSpecialAdvanceWriteOff();

  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);

  if (!target) return null;

  const isReject = target.decision === 'reject';
  const isWithdraw = target.decision === 'withdraw';
  const noteTrimmed = note.trim();
  const noteValid = !isReject || (noteTrimmed.length >= 5 && noteTrimmed.length <= 1000);
  const canSubmit = noteValid && !submitting;

  const executeDecision = async () => {
    if (target.type === 'correction') {
      await decideCorrection.mutateAsync({
        correctionId: target.id,
        decision: target.decision,
        note: noteTrimmed || null,
      });
    } else if (target.type === 'provision_review') {
      await decideProvision.mutateAsync({
        reviewId: target.id,
        decision: target.decision,
        note: noteTrimmed || null,
      });
    } else if (target.type === 'write_off') {
      await decideWriteOff.mutateAsync({
        writeOffId: target.id,
        decision: target.decision,
        note: noteTrimmed || null,
      });
    }

    const actionText = target.decision === 'approve' ? 'approved' : target.decision === 'reject' ? 'rejected' : 'withdrawn';
    toast.success(`${target.reference} ${actionText}`);
    onOpenChange(false);
    setNote('');
    onSuccess?.();
  };

  const handleConfirm = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    try {
      await executeDecision();
    } catch (err) {
      const msg = (err as Error)?.message || '';
      if (msg.includes('MFA_REQUIRED')) {
        setStepUpOpen(true);
      } else {
        setError(describeSpecialAdvanceError(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const title = target.decision === 'approve'
    ? `Approve ${target.reference}`
    : target.decision === 'reject'
    ? `Reject ${target.reference}`
    : `Withdraw ${target.reference}`;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md sm:rounded-2xl space-y-4">
          <DialogHeader>
            <DialogTitle className="text-base font-bold">{title}</DialogTitle>
            <DialogDescription className="text-xs">
              {target.decision === 'approve' && 'Confirm this second-CFO approval. The action will post immediately to the ledger.'}
              {target.decision === 'reject' && 'A decision note explaining the reason for rejection (min 5 characters) is required.'}
              {target.decision === 'withdraw' && 'Are you sure you want to withdraw this request? No ledger postings will occur.'}
            </DialogDescription>
          </DialogHeader>

          {(isReject || target.decision === 'approve') && (
            <div className="space-y-1.5 text-xs">
              <div className="flex justify-between">
                <Label htmlFor="decide-note" className="text-xs font-medium">
                  {isReject ? 'Decision note (required to reject)' : 'Approval note (optional)'}
                  {isReject && <span className="text-destructive"> *</span>}
                </Label>
                {isReject && (
                  <span className={`text-[10px] ${noteTrimmed.length < 5 ? 'text-muted-foreground' : 'text-emerald-600 font-medium'}`}>
                    {noteTrimmed.length}/5 min characters
                  </span>
                )}
              </div>
              <Textarea
                id="decide-note"
                rows={3}
                placeholder={isReject ? 'Explain why this request is being rejected...' : 'Optional comment for the audit log...'}
                maxLength={1000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={submitting}
              />
            </div>
          )}

          {error && <p role="alert" className="text-xs font-medium text-destructive">{error}</p>}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              id="decide-confirm-submit"
              size="sm"
              variant={target.decision === 'reject' || target.decision === 'withdraw' ? 'outline' : 'default'}
              disabled={!canSubmit || submitting}
              onClick={() => void handleConfirm()}
            >
              {submitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {target.decision === 'approve' ? 'Approve & post' : target.decision === 'reject' ? 'Reject request' : 'Withdraw request'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SpecialAdvanceStepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onSuccess={async () => {
          await executeDecision();
        }}
      />
    </>
  );
}

export default SpecialAdvanceDecideDialog;
