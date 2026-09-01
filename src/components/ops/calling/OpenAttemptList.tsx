import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { MessageCircle, Phone, PhoneOff, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { QUICK_OUTCOMES, ccErrorText, type CcCallingHub } from '@/hooks/useCcCallingHub';
import { openFor, telHref, waHref } from './ccPhone';

export type OpenFormAttempt = { id: string; cycle_row_id: string; name: string };

/**
 * The single source of open-attempt behaviour. Rendered by the desktop
 * Open attempts panel and by the mobile record sheet — do not fork it.
 * `phones` is keyed by cycle_row_id, matching the reveal map in CallingHub.
 */
export function OpenAttemptList({
  hub,
  onOpenForm,
  phones = {},
  showDial = false,
}: {
  hub: CcCallingHub;
  onOpenForm: (attempt: OpenFormAttempt) => void;
  phones?: Record<string, string | null>;
  showDial?: boolean;
}) {
  const { openAttempts, recordQuick, voidAttempt } = hub;

  if (!openAttempts.length) {
    return <p className="text-xs text-muted-foreground">No open attempts. Reveal a number to start one.</p>;
  }

  return (
    <ul className="space-y-2">
      {openAttempts.map((a) => {
        const phone = phones[a.cycle_row_id] ?? null;
        return (
          <li key={a.id} className="rounded-xl border border-border/60 p-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-semibold">{a.name}</span>
                  {a.stale && (
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      Cycle closed
                    </Badge>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Attempt {a.attempt_no} · {openFor(a.revealed_at)}
                </div>
              </div>
              {/*
                A stale attempt sits on a cycle nobody is working any more, so
                there is no call outcome left to record — only the discard that
                releases it from the WIP count.
              */}
              {a.stale ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[11px]"
                    disabled={voidAttempt.isPending}
                    onClick={() =>
                      voidAttempt.mutate(
                        { attemptId: a.id, reason: 'Discarded by operator: cycle closed before the outcome was recorded' },
                        {
                          onSuccess: () => toast.success('Discarded'),
                          onError: (e) => toast.error(ccErrorText(e)),
                        },
                      )
                    }
                  >
                    <Trash2 className="mr-1 h-3 w-3" />
                    Discard
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-1.5">
                  {QUICK_OUTCOMES.map((o) => (
                    <Button
                      key={o.value}
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      disabled={recordQuick.isPending}
                      onClick={() =>
                        recordQuick.mutate(
                          { attemptId: a.id, outcome: o.value },
                          {
                            onSuccess: () => toast.success(`Recorded: ${o.label}`),
                            onError: (e) => toast.error(ccErrorText(e)),
                          },
                        )
                      }
                    >
                      <PhoneOff className="mr-1 h-3 w-3" />
                      {o.label}
                    </Button>
                  ))}
                  <Button
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => onOpenForm({ id: a.id, cycle_row_id: a.cycle_row_id, name: a.name })}
                  >
                    Engaged / callback
                  </Button>
                </div>
              )}
            </div>

            {showDial && phone && !a.stale && (
              <div className="mt-2 flex items-center gap-1.5">
                <Button asChild className="h-11 flex-1 text-sm font-bold">
                  <a href={telHref(phone)}>
                    <Phone className="mr-2 h-4 w-4" />
                    {phone}
                  </a>
                </Button>
                <Button asChild variant="outline" className="h-11 px-3">
                  <a href={waHref(phone)} target="_blank" rel="noreferrer" aria-label="WhatsApp">
                    <MessageCircle className="h-4 w-4" />
                  </a>
                </Button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
