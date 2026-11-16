import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  INTAKE_STEPS, intakeCounter, stepDone, type IntakeItem, type IntakeState, type IntakeStepKey,
} from '@/lib/intakeSteps';

/**
 * The top of every intake step: "Step N of 8 · X left" (or "N to fix"), an 8-part progress
 * bar (done / current / to do), the step names with ticks (tap one to jump there) and the
 * step's "What's needed" box.
 *
 * Not CSS-sticky: Android strips position:sticky inside role="dialog" (index.css). Place it
 * outside the scrolling area (a flex row above it) so it stays on top everywhere.
 */
export function IntakeStepHeader({
  state, current, onJump, toFix, items, only, className,
}: {
  state: IntakeState;
  current: IntakeStepKey;
  onJump: (key: IntakeStepKey) => void;
  /** Resubmit: the number of returned items still to redo; the counter reads "N to fix". */
  toFix?: number | null;
  /** The "What's needed" lines; defaults to the current step's items. */
  items?: IntakeItem[];
  /** Resubmit: only these steps can be jumped to (the returned items). */
  only?: IntakeStepKey[] | null;
  className?: string;
}) {
  const needed = items ?? state[current] ?? [];
  return (
    <div className={cn('border-b border-border bg-card px-3 pb-2 pt-2', className)} data-testid="intake-header">
      <div className="mx-auto flex max-w-xl flex-col gap-2">
        <p className="text-sm font-semibold" data-testid="intake-counter" aria-live="polite">{intakeCounter(state, current, toFix)}</p>
        <div className="flex gap-1" role="progressbar" aria-valuemin={0} aria-valuemax={INTAKE_STEPS.length}
          aria-valuenow={INTAKE_STEPS.filter((s) => stepDone(state, s.key)).length} aria-label="Steps done">
          {INTAKE_STEPS.map((s) => {
            const done = stepDone(state, s.key);
            const isCurrent = s.key === current;
            return (
              <span key={s.key} data-state={done ? 'done' : isCurrent ? 'current' : 'todo'}
                className={cn('h-1.5 flex-1 rounded-full', done ? 'bg-success' : isCurrent ? 'bg-primary' : 'bg-muted')} />
            );
          })}
        </div>
        <nav className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5" aria-label="Steps">
          {INTAKE_STEPS.map((s) => {
            const done = stepDone(state, s.key);
            const allowed = !only || only.includes(s.key);
            return (
              <button
                key={s.key}
                type="button"
                disabled={!allowed}
                aria-current={s.key === current ? 'step' : undefined}
                aria-label={`Step ${s.n}: ${s.name}${done ? ', done' : ''}`}
                onClick={() => onJump(s.key)}
                className={cn(
                  'flex min-h-9 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs font-medium disabled:opacity-40',
                  s.key === current ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground',
                )}
              >
                {done ? <Check className="h-3 w-3 text-success" aria-hidden /> : <span aria-hidden>{s.n}</span>}
                {s.short}
              </button>
            );
          })}
        </nav>
        {needed.length > 0 && (
          <div className="rounded-xl border border-border bg-background px-3 py-2" data-testid="intake-needed">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What’s needed</p>
            <ul className="mt-1 flex flex-col gap-0.5 text-sm">
              {needed.map((i) => (
                <li key={i.label} className={cn('flex items-center gap-1.5', i.done ? 'text-success' : 'text-foreground')} data-done={i.done ? 'yes' : 'no'}>
                  {i.done ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-muted-foreground/50" aria-hidden />}
                  {i.label}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
