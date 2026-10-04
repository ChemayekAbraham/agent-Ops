import { FileText, PhoneCall, Timer } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  deriveOutcome, formatCallStamp, formatTalkTime, OUTCOME_LABEL, type CallOutcome,
} from '@/lib/callCentre';
import { useCallHistoryFor } from '@/hooks/useCrmCallCentre';

const initials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '??';

const OUTCOME_TONE: Record<CallOutcome, string> = {
  answered: 'border-success/40 text-success',
  rejected: 'border-destructive/40 text-destructive',
  not_reachable: 'border-warning/40 text-warning',
  in_progress: 'border-primary/40 text-primary',
};

/**
 * Every call ever placed to one person, newest first, with whatever summary the
 * caller saved. This is the follow-up read: what was promised, by whom, when.
 */
export function CallSummaryHistorySheet({
  calleeId,
  name,
  phone,
  avatarUrl,
  open,
  onOpenChange,
  onCall,
}: {
  calleeId: string | null;
  name: string;
  phone: string;
  avatarUrl: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCall: () => void;
}) {
  const { data: history, isLoading } = useCallHistoryFor(open ? calleeId : null);

  const withSummary = history.filter((c) => !!c.summary?.trim()).length;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* See CallDrawer: capped at every width, so this stays a side drawer
          below the `sm:` breakpoint instead of going full-bleed. */}
      <SheetContent side="right" className="flex w-3/4 max-w-sm flex-col gap-0 p-0 sm:max-w-lg">
        <div className="shrink-0 border-b border-border/60 p-5">
          <div className="flex items-center gap-3">
            <Avatar className="h-12 w-12 shrink-0">
              <AvatarImage src={avatarUrl ?? undefined} alt="" />
              <AvatarFallback className="bg-primary/10 text-primary">{initials(name)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate text-base font-bold text-foreground">
                {name || 'Contact'}
              </SheetTitle>
              <SheetDescription className="truncate text-xs tabular-nums text-muted-foreground">
                {phone}
              </SheetDescription>
            </div>
            <Button type="button" size="sm" className="shrink-0 gap-1.5" onClick={onCall}>
              <PhoneCall className="h-3.5 w-3.5" />
              Call
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {history.length} call{history.length === 1 ? '' : 's'} · {withSummary} with a saved summary
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {isLoading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full rounded-lg" />)}
            </div>
          ) : history.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No calls recorded for this person yet.
            </p>
          ) : (
            <ol className="space-y-3">
              {history.map((call) => {
                const outcome = deriveOutcome(call);
                return (
                  <li
                    key={call.id}
                    className="rounded-lg border border-border/60 bg-background p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className={cn('text-[10px]', OUTCOME_TONE[outcome])}>
                        {OUTCOME_LABEL[outcome]}
                      </Badge>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {formatCallStamp(call.calledAt)}
                      </span>
                      {outcome === 'answered' && (
                        <span className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
                          <Timer className="h-3 w-3" aria-hidden />
                          {formatTalkTime(call.durationSeconds)}
                        </span>
                      )}
                      {call.staffName && (
                        <span className="ml-auto truncate text-[11px] text-muted-foreground">
                          by {call.staffName}
                        </span>
                      )}
                    </div>

                    {call.summary?.trim() ? (
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-snug text-foreground">
                        {call.summary}
                      </p>
                    ) : (
                      <p className="mt-2 flex items-center gap-1.5 text-xs italic text-muted-foreground">
                        <FileText className="h-3 w-3 shrink-0" aria-hidden />
                        No summary was saved for this call.
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
