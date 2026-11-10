import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { DEMOTE_REASONS, demoteNoteValid, type DemoteReason } from '@/lib/fundersBoard';

const DEFAULT_REASON: DemoteReason = 'FB_NOT_QUALIFIED';

/**
 * E59: reason sheet for "Demote N". Reason chips from DEMOTE_REASONS (default
 * "Doesn't qualify"), optional note; "Other" needs a 10+ character note
 * (demoteNoteValid). The server decides what is demoted or skipped.
 */
export function FunderV3DemoteSheet({
  open,
  count,
  busy,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  count: number;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: DemoteReason, note: string) => void;
}) {
  const [reason, setReason] = useState<DemoteReason>(DEFAULT_REASON);
  const [note, setNote] = useState('');

  // A fresh sheet every time it opens.
  useEffect(() => {
    if (open) {
      setReason(DEFAULT_REASON);
      setNote('');
    }
  }, [open]);

  const valid = demoteNoteValid(reason, note);
  const needsNote = reason === 'OTHER';

  return (
    <Sheet open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <SheetContent side="bottom" className="mx-auto max-h-[88dvh] w-full max-w-[560px] overflow-y-auto rounded-t-3xl pb-[calc(env(safe-area-inset-bottom,0px)+20px)]" data-testid="fv3-demote-sheet">
        <SheetHeader className="text-left">
          <SheetTitle>
            Demote {count} {count === 1 ? 'house' : 'houses'}
          </SheetTitle>
          <SheetDescription>They leave the funders board and go to the COO's demoted list with this reason.</SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          <div role="radiogroup" aria-label="Reason" className="flex flex-wrap gap-2">
            {DEMOTE_REASONS.map((option) => {
              const active = option.code === reason;
              return (
                <button
                  key={option.code}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-reason={option.code}
                  onClick={() => setReason(option.code)}
                  className={cn(
                    'min-h-11 rounded-full px-4 text-sm font-semibold ring-1 transition-colors',
                    active ? 'bg-foreground text-background ring-foreground' : 'bg-card text-foreground ring-border hover:bg-muted',
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          <label className="block space-y-1.5">
            <span className="text-sm font-semibold">
              Note {needsNote ? <span className="font-normal text-muted-foreground">(at least 10 characters)</span> : <span className="font-normal text-muted-foreground">(optional)</span>}
            </span>
            <Textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              maxLength={500}
              data-testid="fv3-demote-note"
              placeholder={needsNote ? 'Say why these houses are coming off the board' : 'Anything the COO should know'}
              aria-invalid={!valid}
            />
            {needsNote && !valid ? <span className="block text-xs text-destructive">Write at least 10 characters for "Other".</span> : null}
          </label>

          <div className="flex gap-2 pt-1">
            <Button type="button" variant="outline" className="h-12 flex-1 rounded-xl" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="h-12 flex-[2] rounded-xl font-semibold"
              disabled={!valid || busy || count === 0}
              data-testid="fv3-demote-confirm"
              onClick={() => onConfirm(reason, note)}
            >
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
              Demote {count}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default FunderV3DemoteSheet;
