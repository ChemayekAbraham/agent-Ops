import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { AlertTriangle } from 'lucide-react';

interface Props {
  advance: any | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function CancelAdvanceDialog({ advance, open, onOpenChange, onSuccess }: Props) {
  const [mode, setMode] = useState<'write_off' | 'recoup_from_wallet'>('write_off');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const outstanding = Number(advance?.outstanding_balance || 0);
  const agentName = advance?.profiles?.full_name || 'agent';

  const handleSubmit = async () => {
    if (!advance) return;
    if (reason.trim().length < 10) {
      toast.error('Please enter a reason (min 10 characters).');
      return;
    }
    setSubmitting(true);
    try {
      const { data, error } = await supabase.rpc('cancel_agent_advance', {
        p_advance_id: advance.id,
        p_recoup: mode === 'recoup_from_wallet',
        p_reason: reason.trim(),
      });
      if (error) throw error;
      toast.success(
        mode === 'write_off'
          ? `Advance cancelled and written off (${formatUGX(outstanding)}).`
          : `Advance cancelled. Outstanding of ${formatUGX(outstanding)} kept for recoup via Record Payment.`
      );
      onOpenChange(false);
      setReason('');
      setMode('write_off');
      onSuccess?.();
    } catch (e: any) {
      toast.error(e.message || 'Cancellation failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!submitting) onOpenChange(o); }}>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            Cancel advance for {agentName}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Stops all daily deductions immediately. Outstanding is {formatUGX(outstanding)}.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-4">
          <RadioGroup value={mode} onValueChange={(v) => setMode(v as any)} className="space-y-2">
            <label className="flex items-start gap-3 rounded-lg border border-border p-3 cursor-pointer hover:border-primary/40">
              <RadioGroupItem value="write_off" id="write_off" className="mt-1" />
              <div className="flex-1">
                <Label htmlFor="write_off" className="font-semibold cursor-pointer">Write off (do not recoup)</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Outstanding balance is set to zero. Use this when the disbursed funds have already been returned to Welile.
                </p>
              </div>
            </label>
            <label className="flex items-start gap-3 rounded-lg border border-border p-3 cursor-pointer hover:border-primary/40">
              <RadioGroupItem value="recoup_from_wallet" id="recoup" className="mt-1" />
              <div className="flex-1">
                <Label htmlFor="recoup" className="font-semibold cursor-pointer">Cancel but keep recoup pending</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Daily deductions stop, but the outstanding of {formatUGX(outstanding)} remains on the ledger so CFO can recoup it from the agent's wallet via "Record Payment".
                </p>
              </div>
            </label>
          </RadioGroup>

          <div>
            <Label className="text-xs font-semibold">Reason (required, min 10 chars)</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Test disbursement returned by CFO on 14 Jul"
              className="mt-1 min-h-[70px]"
            />
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Keep advance</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={handleSubmit}
            disabled={submitting || reason.trim().length < 10}
          >
            {submitting ? 'Cancelling…' : 'Cancel advance'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}