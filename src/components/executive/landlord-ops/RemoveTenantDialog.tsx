import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, UserX, AlertTriangle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { FieldError, FormErrorBanner, reasonError, parseRpcError } from '@/components/shared/FormFeedback';

interface RemoveTenantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  houseId: string;
  houseTitle: string;
  onComplete?: () => void;
}

export function RemoveTenantDialog({ open, onOpenChange, houseId, houseTitle, onComplete }: RemoveTenantDialogProps) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reasonTouched, setReasonTouched] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setReason(''); setConfirming(false);
      setReasonTouched(false); setSubmitAttempted(false); setFormError(null);
    }
  }, [open]);

  const reasonErr = reasonError(reason);
  const reasonErrText = (reasonTouched || submitAttempted) ? reasonErr : null;
  const canSubmit = !reasonErr && !busy;

  const handleSubmit = async () => {
    setSubmitAttempted(true);
    setFormError(null);
    if (!canSubmit) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc('landlord_ops_remove_tenant_from_house', {
        p_house_id: houseId,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      toast({ title: 'Tenant removed', description: `${houseTitle} is now marked vacant.` });
      onComplete?.();
      onOpenChange(false);
    } catch (e: any) {
      const msg = parseRpcError(e);
      setFormError(msg);
      toast({ title: 'Failed', description: msg, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserX className="h-5 w-5 text-destructive" />
            Remove tenant from house
          </DialogTitle>
          <DialogDescription>
            Use this when the tenant has absconded or moved out of <span className="font-medium">{houseTitle}</span>.
            The house will be marked available again.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <FormErrorBanner message={formError} />
          <div className="space-y-1.5">
            <Label>Reason (min 10 characters)</Label>
            <Textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              onBlur={() => setReasonTouched(true)}
              maxLength={500}
              aria-invalid={!!reasonErrText}
              placeholder="e.g. Tenant absconded after missing 14 days of rent"
              rows={3}
              disabled={busy}
            />
            <p className="text-[11px] text-muted-foreground">{reason.trim().length}/10</p>
            <FieldError message={reasonErrText} />
          </div>
        </div>

        {confirming && (
          <div className="rounded-md border-2 border-destructive/50 bg-destructive/10 p-3 text-sm space-y-1">
            <p className="font-semibold flex items-center gap-1.5 text-destructive">
              <AlertTriangle className="h-4 w-4" /> Confirm removal?
            </p>
            <p className="text-xs">
              <span className="font-medium">{houseTitle}</span> will be marked vacant immediately.
              This action is logged with your reason.
            </p>
          </div>
        )}

        <DialogFooter>
          {confirming ? (
            <>
              <Button variant="outline" onClick={() => setConfirming(false)} disabled={busy}>Go back</Button>
              <Button variant="destructive" onClick={handleSubmit} disabled={!canSubmit}>
                {busy && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                Yes, remove tenant
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setSubmitAttempted(true);
                  setReasonTouched(true);
                  if (canSubmit) setConfirming(true);
                }}
                disabled={busy}
              >
                Review removal
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
