import { useState, useRef, useEffect } from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import {
  CORRECTION_REASON_MIN,
  CORRECTION_REASON_MAX,
  buildWriteOffRequest,
  describeSpecialAdvanceError,
  newIdempotencyKey,
  type SpecialAdvanceStatement,
} from '@/lib/specialAdvances';
import {
  uploadSpecialAdvanceProof,
  hasAuthenticatorSession,
  useRequestSpecialAdvanceWriteOff,
} from '@/hooks/useSpecialAdvances';
import { SpecialAdvanceProofInput } from './SpecialAdvanceProofInput';
import { SpecialAdvanceStepUpDialog } from './SpecialAdvanceStepUpDialog';

interface SpecialAdvanceWriteOffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  advance: SpecialAdvanceStatement;
  onSuccess?: () => void;
}

export function SpecialAdvanceWriteOffDialog({
  open,
  onOpenChange,
  advance,
  onSuccess,
}: SpecialAdvanceWriteOffDialogProps) {
  const requestWriteOff = useRequestSpecialAdvanceWriteOff();
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
    const payload = buildWriteOffRequest({
      reason: trimmedReason,
      proofPath: proofPathToUse,
      idempotencyKey: idempotencyKey.current,
    });

    const res = await requestWriteOff.mutateAsync({
      advanceId: advance.id,
      request: payload,
    });

    toast.success(`Write-off request ${res.reference} submitted for second CFO review`);
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
        if (!(await hasAuthenticatorSession())) {
          setStepUpOpen(true);
          return;
        }
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
            <DialogTitle className="text-base font-bold flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-600" />
              Request Write-off
            </DialogTitle>
            <DialogDescription className="text-xs">
              Request write-off for {advance.reference} ({advance.borrower_name ?? 'Borrower'}).
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-xl border border-border bg-card p-3 space-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Gross outstanding:</span>
              <span className="font-semibold tabular-nums text-foreground">{formatUGX(advance.position.outstanding)}</span>
            </div>
            {advance.allowance_held !== undefined && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Allowance currently held:</span>
                <span className="font-semibold tabular-nums text-foreground">{formatUGX(advance.allowance_held)}</span>
              </div>
            )}
            <p className="pt-1 text-[11px] text-muted-foreground">
              The server will calculate the exact gross amount, allowance released and net loss. No amounts are entered manually.
            </p>
          </div>

          <div className="space-y-3 text-xs">
            <div className="space-y-1.5">
              <div className="flex justify-between">
                <Label htmlFor="writeoff-reason" className="text-xs font-medium">
                  Reason for write-off <span className="text-destructive">*</span>
                </Label>
                <span className={`text-[10px] ${reasonLen < CORRECTION_REASON_MIN ? 'text-muted-foreground' : 'text-emerald-600 font-medium'}`}>
                  {reasonLen}/{CORRECTION_REASON_MIN} min characters
                </span>
              </div>
              <Textarea
                id="writeoff-reason"
                rows={3}
                placeholder="Provide justification and details of recovery efforts made..."
                maxLength={CORRECTION_REASON_MAX}
                value={reason}
                onChange={(e) => handleReasonChange(e.target.value)}
                disabled={submitting}
              />
            </div>

            <SpecialAdvanceProofInput
              id="writeoff-proof"
              label="Archived evidence file"
              file={file}
              onFileChange={handleFileChange}
              disabled={submitting}
              required
              description="Evidence of default, correspondence or audit memo."
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
              id="writeoff-submit"
              size="sm"
              variant="destructive"
              disabled={!canSubmit || submitting}
              onClick={() => void handleSubmit()}
            >
              {submitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Submit write-off request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SpecialAdvanceStepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onSuccess={() => handleSubmit()}
      />
    </>
  );
}

export default SpecialAdvanceWriteOffDialog;
