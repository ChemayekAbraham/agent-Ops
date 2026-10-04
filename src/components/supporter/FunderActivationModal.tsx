import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CheckCircle2, ArrowDownLeft, Clock } from 'lucide-react';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDepositClick: () => void;
  onSnooze: () => void;
}

/**
 * Shown to self-registered Funders the moment Partner Ops / COO approves
 * them AND while their wallet is still empty. Auto-suppresses once they
 * deposit (balance > 0) or when they hit "Remind me in 1 hour".
 */
export function FunderActivationModal({ open, onOpenChange, onDepositClick, onSnooze }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-sm text-center"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader className="items-center sm:text-center">
          <div
            aria-hidden
            className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 animate-scale-in"
          >
            <CheckCircle2 className="h-10 w-10 text-primary" strokeWidth={2.25} />
          </div>
          <DialogTitle className="text-xl font-bold">
            Your account is fully activated
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground pt-1">
            You're all set. Add money to your wallet to start backing tenants and earning returns.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 pt-2">
          <Button onClick={onDepositClick} className="w-full gap-2" size="lg">
            <ArrowDownLeft className="h-4 w-4" />
            Deposit now
          </Button>
          <Button onClick={onSnooze} variant="ghost" className="w-full gap-2 text-muted-foreground">
            <Clock className="h-4 w-4" />
            Remind me in 1 hour
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default FunderActivationModal;