import { Check, Loader2, Wallet, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import type { DepositSubmitResult } from '@/components/payments/DepositFlow';
import type { CoSupportFloatWatchState, CoSupportInviteCopy, CoSupportPreview } from '@/lib/coSupport';

export type CoSupportDeposit = DepositSubmitResult & { submittedAt: number };
const ugx = (amount: number) => `UGX ${amount.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

export function CoSupportFloatSheet({ open, onOpenChange, state, deposit, preview, copy, onRetry, error }: {
  open: boolean; onOpenChange: (open: boolean) => void; state: CoSupportFloatWatchState;
  deposit: CoSupportDeposit; preview: CoSupportPreview | null; copy: CoSupportInviteCopy; onRetry: () => void; error?: string | null;
}) {
  const arrived = state === 'arrived';
  const rejected = state === 'rejected';
  const title = arrived ? copy.arrivedTitle : rejected ? copy.rejectedTitle : state === 'slow' ? copy.slowTitle : copy.waitingTitle;
  const detail = arrived ? copy.arrivedDetail(deposit.amount) : rejected ? copy.rejectedDetail : state === 'slow' ? copy.slowDetail : copy.waitingDetail(deposit.provider);
  return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent side="bottom" className="co-support-sheet mx-auto flex max-h-[90svh] max-w-md flex-col items-center gap-4 overflow-y-auto rounded-t-3xl bg-card px-5 pb-7 pt-0 text-center" overlayClassName="bg-foreground/45 backdrop-blur-none">
      <div className="relative mt-3 flex h-[72px] w-[72px] shrink-0 items-center justify-center">
        {state === 'waiting' ? <Loader2 className="absolute inset-0 h-full w-full animate-spin text-primary motion-reduce:animate-none" aria-hidden /> : null}
        {arrived ? <span className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-success/10"><span className="flex h-12 w-12 items-center justify-center rounded-full bg-success text-success-foreground"><Check className="h-7 w-7" aria-hidden /></span></span> : rejected ? <X className="h-8 w-8 text-destructive" aria-hidden /> : <Wallet className="h-7 w-7 text-primary" aria-hidden />}
      </div>
      <div className="space-y-1.5"><SheetTitle className="text-xl font-bold">{title}</SheetTitle><SheetDescription className="mx-auto max-w-[300px] text-sm leading-relaxed">{detail}</SheetDescription></div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <dl className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 border-y py-3.5 text-left text-[13px]">
        {arrived ? <><dt className="text-muted-foreground">{copy.arrivedFreeLabel}</dt><dd className="co-support-amount text-right font-mono font-bold">{ugx(preview?.float_available ?? 0)}</dd></> : <><dt className="text-muted-foreground">{copy.successCard.putInLabel}</dt><dd className="co-support-amount text-right font-mono font-bold">{ugx(deposit.amount)}</dd><dt className="sr-only">{deposit.transactionId}</dt><dd className="col-span-2 break-all text-right font-mono">{deposit.transactionId}</dd></>}
      </dl>
      {!arrived && !rejected ? <p className="text-xs leading-relaxed text-muted-foreground">{copy.waitingNote}</p> : null}
      {arrived ? <Button className="h-12 w-full rounded-2xl text-[15px]" onClick={() => onOpenChange(false)}>{copy.arrivedAction}</Button> : rejected ? <Button className="h-12 w-full rounded-2xl" onClick={onRetry}>{copy.blockAction ?? copy.depositTitle}</Button> : <Button variant="outline" size="icon" className="h-12 w-full rounded-2xl" onClick={() => onOpenChange(false)} aria-label={copy.waitingNote}><X className="h-5 w-5" aria-hidden /></Button>}
    </SheetContent>
  </Sheet>;
}