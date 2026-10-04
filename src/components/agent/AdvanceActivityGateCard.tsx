import { Lock, CheckCircle2, Circle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AgentAdvanceActivity } from '@/hooks/useAgentAdvanceActivity';

/**
 * Shown to an agent who has recorded no field work yet. Advances are only for
 * agents who have done at least one piece of real work, so this card explains
 * exactly which single action unlocks the advance request.
 */
export function AdvanceActivityGateCard({
  activity,
  className,
}: { activity: AgentAdvanceActivity; className?: string }) {
  const steps = [
    { label: 'Recruit a sub-agent', done: activity.subagents > 0 },
    { label: 'Raise a rent request for a tenant', done: activity.rent_requests > 0 },
    { label: 'Collect rent from a tenant', done: activity.collections > 0 },
    { label: 'Get a promissory note activated', done: activity.promissory_notes > 0 },
    { label: 'List a house that gets verified', done: activity.verified_houses > 0 },
  ];

  return (
    <div className={cn('rounded-2xl border-2 border-amber-500/40 bg-amber-500/5 p-4', className)}>
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-amber-500/15 p-2 shrink-0">
          <Lock className="h-5 w-5 text-amber-600" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold text-foreground">Advance requests are not open yet</p>
          <p className="text-xs text-muted-foreground mt-1 leading-snug">
            Advances go to agents who have done some work, even if small. Complete
            any <span className="font-bold text-foreground">one</span> of the actions
            below and this unlocks automatically.
          </p>
        </div>
      </div>

      <div className="mt-3 space-y-1.5">
        {steps.map((s) => (
          <div key={s.label} className="flex items-center gap-2">
            {s.done
              ? <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
              : <Circle className="h-4 w-4 text-muted-foreground/50 shrink-0" />}
            <p className={cn('text-xs', s.done ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
              {s.label}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
