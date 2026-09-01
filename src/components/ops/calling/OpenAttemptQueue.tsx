import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Clock, PhoneOff, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { OPEN_ATTEMPT_LIMIT, QUICK_OUTCOMES, ccErrorText, type CcCallingHub } from '@/hooks/useCcCallingHub';

function openFor(iso: string) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m open`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m open`;
}

/**
 * The surface a caller returns to in order to record what they did.
 * Unreached outcomes are one tap. Engaged / callback open the form.
 */
export function OpenAttemptQueue({
  hub,
  onOpenForm,
}: {
  hub: CcCallingHub;
  onOpenForm: (attempt: { id: string; cycle_row_id: string; name: string }) => void;
}) {
  const { openAttempts, openCount, wipBlocked, recordQuick, voidAttempt } = hub;

  return (
    <Card className="rounded-2xl border-border/60 p-3 sm:p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-bold">
          <Clock className="h-4 w-4 text-amber-600" />
          Open attempts
        </h3>
        <Badge variant={wipBlocked ? 'destructive' : 'secondary'}>
          {openCount}/{OPEN_ATTEMPT_LIMIT} open
        </Badge>
      </div>

      {wipBlocked && (
        <p className="mb-2 rounded-lg bg-destructive/10 px-2 py-1.5 text-xs font-semibold text-destructive">
          Record the outcome of your open calls before revealing another number.
        </p>
      )}

      {!openAttempts.length ? (
        <p className="text-xs text-muted-foreground">No open attempts. Reveal a number to start one.</p>
      ) : (
        <ul className="space-y-2">
          {openAttempts.map((a) => (
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
                  releases it from the WIP count. Offering the outcome buttons
                  here would invite a call record against a dead cycle.
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
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
