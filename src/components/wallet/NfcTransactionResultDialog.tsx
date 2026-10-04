import { motion } from '@/lib/motion-lite';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CheckCircle2, WalletMinimal, XCircle, RotateCcw } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';

export type NfcResultStatus = 'success' | 'insufficient' | 'failed';

export interface NfcResultPayload {
  status: NfcResultStatus;
  amount: number;
  recipientName?: string | null;
  requestId?: string | null;
  available?: number | null;
  errorMessage?: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  result: NfcResultPayload | null;
  onRetry?: () => void;
}

function friendlyError(msg?: string | null): string {
  if (!msg) return 'Something went wrong reading this card. Please try again.';
  const m = msg.toLowerCase();
  if (m.includes('signature')) return 'This card could not be verified. The signature does not match.';
  if (m.includes('blocked') || m.includes('revoked')) return 'This card has been blocked or revoked.';
  if (m.includes('not registered')) return 'This card is not registered with Welile.';
  if (m.includes('own card')) return 'You cannot charge your own card.';
  if (m.includes('incorrect pin')) return 'The PIN entered is incorrect.';
  if (m.includes('owner mismatch')) return 'Card details do not match the registered owner.';
  if (m.includes('nfc not supported')) return 'NFC is not supported on this device. Use Scan to Pay instead.';
  if (m.includes('payload incomplete')) return 'Card data is incomplete. Re-write the card from your Card Setup.';
  return msg;
}

export function NfcTransactionResultDialog({ open, onOpenChange, result, onRetry }: Props) {
  if (!result) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm border-border/50 glass-card overflow-hidden">
        {result.status === 'success' && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center text-center py-4"
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 280, damping: 18 }}
              className="w-20 h-20 rounded-full bg-emerald-500/15 flex items-center justify-center mb-4"
            >
              <CheckCircle2 className="h-12 w-12 text-emerald-500" strokeWidth={2.2} />
            </motion.div>
            <p className="text-xs uppercase tracking-widest text-muted-foreground font-semibold">Payment Requested</p>
            <p className="text-3xl font-black tracking-tight mt-1">{formatUGX(result.amount)}</p>
            {result.recipientName && (
              <p className="text-sm text-muted-foreground mt-1">
                from <span className="font-semibold text-foreground">{result.recipientName}</span>
              </p>
            )}
            <p className="text-xs text-muted-foreground/80 mt-3 max-w-[260px]">
              The cardholder will be notified to approve this charge. You'll see it in your wallet once approved.
            </p>
            {result.requestId && (
              <p className="text-[10px] font-mono text-muted-foreground/60 mt-2">REF · {result.requestId.slice(0, 8)}</p>
            )}
            <Button onClick={() => onOpenChange(false)} className="mt-5 w-full">Done</Button>
          </motion.div>
        )}

        {result.status === 'insufficient' && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center text-center py-4"
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 280, damping: 18 }}
              className="w-20 h-20 rounded-full bg-amber-500/15 flex items-center justify-center mb-4"
            >
              <WalletMinimal className="h-11 w-11 text-amber-500" strokeWidth={2} />
            </motion.div>
            <p className="text-base font-bold">Insufficient Balance on Card</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-[260px]">
              The cardholder doesn't have enough available balance for this charge.
            </p>
            <div className="mt-4 w-full rounded-xl bg-background/60 border border-border/50 p-3 space-y-1.5">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">You requested</span>
                <span className="font-bold tabular-nums">{formatUGX(result.amount)}</span>
              </div>
              {typeof result.available === 'number' && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Card available</span>
                  <span className="font-bold tabular-nums text-amber-600">{formatUGX(result.available)}</span>
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 mt-5 w-full">
              <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
              <Button
                onClick={() => { onOpenChange(false); onRetry?.(); }}
                className="gap-1.5"
              >
                <RotateCcw className="h-4 w-4" /> Try Smaller
              </Button>
            </div>
          </motion.div>
        )}

        {result.status === 'failed' && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center text-center py-4"
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 280, damping: 18 }}
              className="w-20 h-20 rounded-full bg-destructive/15 flex items-center justify-center mb-4"
            >
              <XCircle className="h-12 w-12 text-destructive" strokeWidth={2.2} />
            </motion.div>
            <p className="text-base font-bold">Transaction Failed</p>
            <p className="text-sm text-muted-foreground mt-2 max-w-[280px]">
              {friendlyError(result.errorMessage)}
            </p>
            <div className="grid grid-cols-2 gap-2 mt-5 w-full">
              <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
              <Button
                onClick={() => { onOpenChange(false); onRetry?.(); }}
                className="gap-1.5"
              >
                <RotateCcw className="h-4 w-4" /> Try Again
              </Button>
            </div>
          </motion.div>
        )}
      </DialogContent>
    </Dialog>
  );
}
