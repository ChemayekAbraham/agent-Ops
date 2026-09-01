import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { MessageCircle, Phone, PhoneOff } from 'lucide-react';
import { toast } from 'sonner';
import { QUICK_OUTCOMES, ccErrorText, type CcCallingHub } from '@/hooks/useCcCallingHub';
import { telHref, waHref } from './ccPhone';
import type { OpenFormAttempt } from './OpenAttemptList';

export type RevealTarget = {
  attemptId: string;
  cycleRowId: string;
  name: string;
  attemptNo: number | null;
  phone: string | null;
};

/**
 * Handset flow: reveal → dial from the sheet → leave the browser → return →
 * record, without navigating anywhere. Below lg only.
 */
export function CallRevealSheet({
  hub,
  target,
  onClose,
  onOpenForm,
}: {
  hub: CcCallingHub;
  target: RevealTarget | null;
  onClose: () => void;
  onOpenForm: (attempt: OpenFormAttempt) => void;
}) {
  const phone = target?.phone ?? null;

  return (
    <Sheet open={!!target} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="bottom"
        className="max-h-[85vh] overflow-y-auto rounded-t-2xl pb-[calc(1rem+env(safe-area-inset-bottom))]"
      >
        <SheetHeader className="text-left">
          <SheetTitle className="text-base">{target?.name ?? 'Call'}</SheetTitle>
          <p className="text-xs text-muted-foreground">
            Attempt {target?.attemptNo ?? 1} · dial, then come back and record the outcome
          </p>
        </SheetHeader>

        <div className="mt-3 space-y-3">
          {phone ? (
            <div className="space-y-2">
              <Button asChild className="h-14 w-full text-lg font-bold">
                <a href={telHref(phone)}>
                  <Phone className="mr-2 h-5 w-5" />
                  {phone}
                </a>
              </Button>
              <Button asChild variant="outline" className="h-11 w-full">
                <a href={waHref(phone)} target="_blank" rel="noreferrer">
                  <MessageCircle className="mr-2 h-4 w-4" />
                  WhatsApp
                </a>
              </Button>
            </div>
          ) : (
            <p className="rounded-lg bg-muted px-2 py-2 text-xs font-medium">
              No number is on file for this subject. Record the outcome so the attempt is not left open.
            </p>
          )}

          <div className="space-y-1.5">
            <p className="text-xs font-semibold">Record the outcome</p>
            <div className="grid grid-cols-2 gap-1.5">
              {QUICK_OUTCOMES.map((o) => (
                <Button
                  key={o.value}
                  variant="outline"
                  className="h-11 justify-start text-xs"
                  disabled={hub.recordQuick.isPending || !target}
                  onClick={() =>
                    hub.recordQuick.mutate(
                      { attemptId: target!.attemptId, outcome: o.value },
                      {
                        onSuccess: () => {
                          toast.success(`Recorded: ${o.label}`);
                          onClose();
                        },
                        onError: (e) => toast.error(ccErrorText(e)),
                      },
                    )
                  }
                >
                  <PhoneOff className="mr-2 h-4 w-4" />
                  {o.label}
                </Button>
              ))}
            </div>
            <Button
              className="h-11 w-full"
              disabled={!target}
              onClick={() => {
                if (!target) return;
                onOpenForm({ id: target.attemptId, cycle_row_id: target.cycleRowId, name: target.name });
                onClose();
              }}
            >
              Engaged / Callback booked
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
