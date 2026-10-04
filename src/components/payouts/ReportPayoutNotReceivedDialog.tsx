import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { AlertTriangle, Loader2, Send } from 'lucide-react';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  withdrawalId: string;
  amount: number;
  onReported?: () => void;
}

/**
 * Lets a user tell the merchant agent that a payout marked as "paid" never
 * actually reached them. The report lands on the merchant agent's payout
 * dashboard as a prominent alarm (and is visible to Financial Ops).
 */
export function ReportPayoutNotReceivedDialog({
  open, onOpenChange, withdrawalId, amount, onReported,
}: Props) {
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  const valid = message.trim().length >= 10;

  async function submit() {
    if (!valid || saving) return;
    setSaving(true);
    try {
      const { error } = await (supabase as any).rpc('report_payout_not_received', {
        p_withdrawal_id: withdrawalId,
        p_message: message.trim(),
      });
      if (error) throw error;
      toast.success('Report sent — the merchant agent has been alerted.');
      setMessage('');
      onOpenChange(false);
      onReported?.();
    } catch (e: any) {
      toast.error(e?.message || 'Could not send your report. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            I did not receive this money
          </DialogTitle>
          <DialogDescription>
            This payout of {formatUGX(amount)} is marked as paid. Tell the merchant agent what
            happened — they will see an urgent alert and must respond.
          </DialogDescription>
        </DialogHeader>

        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={5}
          maxLength={800}
          placeholder="Example: The payout was marked paid at 6:13pm but nothing arrived on my Equity account 1046…2361. Please confirm the transfer."
        />
        <p className="text-[11px] text-muted-foreground">
          {message.trim().length < 10
            ? 'Please write at least 10 characters.'
            : `${message.trim().length}/800 characters`}
        </p>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={submit} disabled={!valid || saving} className="gap-2">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send alert to merchant
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
