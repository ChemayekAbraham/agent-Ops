import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CalendarClock, ClipboardList } from 'lucide-react';
import { type CcCallingHub } from '@/hooks/useCcCallingHub';
import { OpenAttemptList, type OpenFormAttempt } from './OpenAttemptList';
import { FollowupsDuePanel } from './FollowupsDuePanel';

/**
 * Below lg only. The recording surface must be reachable at any scroll
 * position, so it lives in a fixed bar rather than a panel in the flow.
 * z-30 keeps it under the app's floating ticket / WhatsApp buttons' overlay
 * layer while the hub's bottom padding keeps them from covering each other.
 */
export function MobileCallBar({
  hub,
  phones,
  onOpenForm,
}: {
  hub: CcCallingHub;
  phones: Record<string, string | null>;
  onOpenForm: (attempt: OpenFormAttempt) => void;
}) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<'record' | 'followups'>('record');

  return (
    <>
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border/60 bg-background/95 px-3 pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-2 backdrop-blur lg:hidden">
        <button
          type="button"
          onClick={() => {
            setSection('record');
            setOpen(true);
          }}
          className="flex w-full items-center justify-between gap-2 rounded-xl border border-border/60 px-3 py-2 text-left"
        >
          <span className="min-w-0">
            <span className="flex items-center gap-2 text-sm font-bold">
              <ClipboardList className="h-4 w-4 text-primary" />
              Record outcomes
            </span>
            {hub.wipBlocked && (
              <span className="block truncate text-[11px] font-semibold text-destructive">
                Record the outcome of your open calls before revealing another number.
              </span>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {hub.followups.length > 0 && (
              <Badge variant="outline" className="text-[10px]">
                {hub.followups.length} due
              </Badge>
            )}
            <Badge variant={hub.wipBlocked ? 'destructive' : 'secondary'}>
              {hub.wipLimit == null ? `${hub.openCount} open` : `${hub.openCount} of ${hub.wipLimit} open`}
            </Badge>

          </span>
        </button>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[88vh] overflow-y-auto rounded-t-2xl pb-[calc(1rem+env(safe-area-inset-bottom))]"
        >
          <SheetHeader className="text-left">
            <SheetTitle className="text-base">Your calls</SheetTitle>
          </SheetHeader>

          <div className="mt-3 grid grid-cols-2 gap-1.5 rounded-xl bg-muted p-1">
            <Button
              size="sm"
              variant={section === 'record' ? 'default' : 'ghost'}
              className="h-9 text-xs"
              onClick={() => setSection('record')}
            >
              <ClipboardList className="mr-1.5 h-3.5 w-3.5" />
              Open attempts ({hub.openCount})
            </Button>
            <Button
              size="sm"
              variant={section === 'followups' ? 'default' : 'ghost'}
              className="h-9 text-xs"
              onClick={() => setSection('followups')}
            >
              <CalendarClock className="mr-1.5 h-3.5 w-3.5" />
              Follow-ups ({hub.followups.length})
            </Button>
          </div>

          <div className="mt-3">
            {section === 'record' ? (
              <OpenAttemptList
                hub={hub}
                phones={phones}
                showDial
                onOpenForm={(a) => {
                  onOpenForm(a);
                  setOpen(false);
                }}
              />
            ) : (
              <FollowupsDuePanel hub={hub} />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
