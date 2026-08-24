import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CheckCircle2, Copy, ExternalLink, Loader2, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import { supabase } from '@/integrations/supabase/client';

export interface LandlordPaymentCompletion {
  payoutId: string;
  amount: number;
  landlordName: string;
  tenantName: string | null;
  landlordPhone: string | null;
  receiptUrl: string | null;
  receiptNumber: string | null;
  smsSent: boolean;
}

function maskPhone(phone: string | null) {
  if (!phone) return 'no phone on file';
  const digits = phone.replace(/[^0-9+]/g, '');
  if (digits.length < 6) return digits;
  return `${digits.slice(0, digits.length - 5).replace(/\d(?=\d{3})/g, '•')}${digits.slice(-3)}`;
}

/**
 * Internal completion screen shown right after a landlord disbursement is
 * confirmed: proves the receipt exists, that the SMS went out, and lets staff
 * copy the link or resend the SMS (resend is idempotent server-side).
 */
export function LandlordPaymentCompletedDialog({
  completion,
  onClose,
}: {
  completion: LandlordPaymentCompletion | null;
  onClose: () => void;
}) {
  const [resending, setResending] = useState(false);
  if (!completion) return null;

  const handleCopy = async () => {
    if (!completion.receiptUrl) return;
    try {
      await navigator.clipboard.writeText(completion.receiptUrl);
      toast.success('Receipt link copied');
    } catch {
      toast.error('Could not copy the link');
    }
  };

  const handleResend = async () => {
    setResending(true);
    try {
      const { data, error } = await supabase.functions.invoke('landlord-rent-receipt', {
        body: { payout_id: completion.payoutId, resend: true },
      });
      if (error) throw error;
      if ((data as any)?.sms_sent) toast.success('Receipt SMS resent');
      else toast.error((data as any)?.sms_error ?? 'SMS could not be delivered');
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to resend the SMS');
    } finally {
      setResending(false);
    }
  };

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            Landlord Payment Completed
          </DialogTitle>
          <DialogDescription>
            {formatUGX(completion.amount)} was successfully paid to {completion.landlordName}
            {completion.tenantName ? ` for tenant ${completion.tenantName}` : ''}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 rounded-lg border border-border/60 bg-muted/30 p-3 text-sm">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            <span>
              Receipt generated{completion.receiptNumber ? ` — ${completion.receiptNumber}` : ''}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <MessageSquare className={`h-4 w-4 ${completion.smsSent ? 'text-emerald-600' : 'text-muted-foreground'}`} />
            <span>
              {completion.smsSent
                ? `SMS sent to ${maskPhone(completion.landlordPhone)}`
                : 'SMS not confirmed — you can resend below'}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            disabled={!completion.receiptUrl}
            onClick={() => completion.receiptUrl && window.open(completion.receiptUrl, '_blank')}
          >
            <ExternalLink className="mr-2 h-4 w-4" /> View Receipt
          </Button>
          <Button variant="outline" disabled={!completion.receiptUrl} onClick={handleCopy}>
            <Copy className="mr-2 h-4 w-4" /> Copy Link
          </Button>
          <Button variant="outline" onClick={handleResend} disabled={resending}>
            {resending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <MessageSquare className="mr-2 h-4 w-4" />}
            Resend SMS
          </Button>
          <Button onClick={onClose}>Return to Disbursements</Button>
        </div>

        <DialogFooter />
      </DialogContent>
    </Dialog>
  );
}
