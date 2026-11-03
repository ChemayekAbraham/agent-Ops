import { useState, useRef, useEffect } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import {
  CORRECTION_KIND_LABEL,
  CORRECTION_REASON_MIN,
  CORRECTION_REASON_MAX,
  buildCorrectionRequest,
  describeSpecialAdvanceError,
  newIdempotencyKey,
  type CorrectionKind,
  type SpecialAdvanceStatement,
} from '@/lib/specialAdvances';
import {
  uploadSpecialAdvanceProof,
  useRequestSpecialAdvanceCorrection,
} from '@/hooks/useSpecialAdvances';
import { SpecialAdvanceProofInput } from './SpecialAdvanceProofInput';
import { SpecialAdvanceStepUpDialog } from './SpecialAdvanceStepUpDialog';

interface SpecialAdvanceCorrectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  advance: SpecialAdvanceStatement;
  kind: CorrectionKind;
  repaymentId?: string | null;
  repaymentAmount?: number;
  repaymentReference?: string;
  onSuccess?: () => void;
}

export function SpecialAdvanceCorrectionDialog({
  open,
  onOpenChange,
  advance,
  kind,
  repaymentId,
  repaymentAmount,
  repaymentReference,
  onSuccess,
}: SpecialAdvanceCorrectionDialogProps) {
  const requestCorrection = useRequestSpecialAdvanceCorrection();
  const [reason, setReason] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);

  const idempotencyKey = useRef(newIdempotencyKey());

  useEffect(() => {
    if (open) {
      setReason('');
      setFile(null);
      setUploadedPath(null);
      setError(null);
      idempotencyKey.current = newIdempotencyKey();
    }
  }, [open]);

  // When reason changes, reset the idempotency key for a new intent
  const handleReasonChange = (val: string) => {
    setReason(val);
    idempotencyKey.current = newIdempotencyKey();
  };

  const handleFileChange = (newFile: File | null) => {
    setFile(newFile);
    setUploadedPath(null);
    idempotencyKey.current = newIdempotencyKey();
  };

  const trimmedReason = reason.trim();
  const reasonLen = trimmedReason.length;
  const reasonValid = reasonLen >= CORRECTION_REASON_MIN && reasonLen <= CORRECTION_REASON_MAX;
  const canSubmit = reasonValid && (!!file || !!uploadedPath) && !submitting;

  const executeRequest = async (proofPathToUse: string) => {
    const payload = buildCorrectionRequest({
      kind,
      repaymentId: kind === 'repayment_reversal' ? repaymentId : null,
      reason: trimmedReason,
      proofPath: proofPathToUse,
      idempotencyKey: idempotencyKey.current,
    });

    const res = await requestCorrection.mutateAsync({
      advanceId: advance.id,
      request: payload,
    });

    toast.success(`Correction request ${res.reference} submitted for second CFO review`);
    onOpenChange(false);
    onSuccess?.();
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    let path = uploadedPath;
    try {
      if (!path && file) {
        path = await uploadSpecialAdvanceProof(advance.id, file);
        setUploadedPath(path);
      }
      if (!path) throw new Error('Proof file is required');

      await executeRequest(path);
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

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md sm:rounded-2xl space-y-4">
          <DialogHeader>
            <DialogTitle className="text-base font-bold">
              {CORRECTION_KIND_LABEL[kind]}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {kind === 'repayment_reversal' ? (
                <>
                  Request reversal of repayment {repaymentReference ? `(${repaymentReference})` : ''} of{' '}
                  <strong className="text-foreground">{repaymentAmount ? formatUGX(repaymentAmount) : ''}</strong> on{' '}
                  {advance.reference}.
                </>
              ) : (
                <>
                  Request reversal of external payout of{' '}
                  <strong className="text-foreground">{formatUGX(advance.principal)}</strong> on {advance.reference}.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-xl bg-amber-500/10 border border-amber-500/20 p-3 text-xs text-amber-700 dark:text-amber-400 space-y-1">
            <div className="flex items-center gap-1.5 font-semibold">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>Two-CFO Maker-Checker Control</span>
            </div>
            <p>
              This request posts nothing to the ledger until approved by a different enabled CFO. Historical records
              are never edited or deleted.
            </p>
          </div>

          <div className="space-y-3 text-xs">
            <div className="space-y-1.5">
              <div className="flex justify-between">
                <Label htmlFor="correction-reason" className="text-xs font-medium">
                  Reason for correction <span className="text-destructive">*</span>
                </Label>
                <span className={`text-[10px] ${reasonLen < CORRECTION_REASON_MIN ? 'text-muted-foreground' : 'text-emerald-600 dark:text-emerald-400 font-medium'}`}>
                  {reasonLen}/{CORRECTION_REASON_MIN} min characters ({CORRECTION_REASON_MAX} max)
                </span>
              </div>
              <Textarea
                id="correction-reason"
                rows={3}
                placeholder="Explain the error requiring this correction in detail..."
                maxLength={CORRECTION_REASON_MAX}
                value={reason}
                onChange={(e) => handleReasonChange(e.target.value)}
                disabled={submitting}
              />
            </div>

            <SpecialAdvanceProofInput
              id="correction-proof"
              label="Archived proof of error or reversal request"
              file={file}
              onFileChange={handleFileChange}
              disabled={submitting}
              required
            />

            {error && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {error}
              </p>
            )}
          </div>

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
              id="correction-submit"
              size="sm"
              disabled={!canSubmit || submitting}
              onClick={() => void handleSubmit()}
            >
              {submitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Submit for review
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SpecialAdvanceStepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onSuccess={async () => {
          if (uploadedPath) {
            await executeRequest(uploadedPath);
          }
        }}
      />
    </>
  );
}

export default SpecialAdvanceCorrectionDialog;
