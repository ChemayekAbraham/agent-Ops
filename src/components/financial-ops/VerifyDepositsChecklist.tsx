import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  CheckCircle2,
  Circle,
  ChevronDown,
  ListChecks,
  RotateCcw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { hapticTap } from '@/lib/haptics';

type ChecklistTab = 'user' | 'field' | 'rejected';

interface Step {
  id: string;
  title: string;
  detail: string;
}

const PLAYBOOK: Record<ChecklistTab, { heading: string; steps: Step[] }> = {
  user: {
    heading: 'How to clear a user deposit',
    steps: [
      {
        id: 'auto',
        title: 'Skim the Auto-match list',
        detail: 'These are already linked — just scan for anything odd.',
      },
      {
        id: 'review',
        title: 'Open Needs review',
        detail: 'Match each Gmail receipt to the right user, or cancel it as a duplicate.',
      },
      {
        id: 'tid',
        title: 'Paste any pending TID',
        detail: 'If a sender messages a TID, paste it into Verify by Transaction ID.',
      },
      {
        id: 'check',
        title: 'Spot-check Recently verified',
        detail: 'Make sure the amount and the wallet you credited match.',
      },
    ],
  },
  field: {
    heading: 'How to clear a field deposit',
    steps: [
      {
        id: 'open',
        title: 'Open the oldest batch first',
        detail: 'Agents are waiting — work top-down so nothing ages out.',
      },
      {
        id: 'match',
        title: 'Match the agent receipt',
        detail: 'The screenshot/MoMo SMS amount must equal the batch total.',
      },
      {
        id: 'approve',
        title: 'Approve or reject with a reason',
        detail: 'Approve credits the float. Reject needs a short note for the agent.',
      },
    ],
  },
  rejected: {
    heading: 'How to re-review a rejection',
    steps: [
      {
        id: 'why',
        title: 'Read the rejection reason',
        detail: 'Confirm the original issue is now resolved.',
      },
      {
        id: 'evidence',
        title: 'Check the new evidence',
        detail: 'Look at the latest receipt, TID or note attached to the item.',
      },
      {
        id: 'decide',
        title: 'Approve or close it out',
        detail: 'Approve to credit the wallet, or close so it stops appearing here.',
      },
    ],
  },
};

const STORAGE_PREFIX = 'finops:verify-deposits-checklist';

/**
 * A small, friendly checklist that sits at the top of the Verify Deposits
 * page. The goal is purely orientation — operators with little training
 * should be able to read three short steps and know what to do next.
 *
 * Ticks are remembered per-tab in localStorage so the operator can pause
 * mid-shift without losing their place, and the panel auto-collapses once
 * every step is checked to stay out of the way.
 */
export function VerifyDepositsChecklist({ tab }: { tab: ChecklistTab }) {
  const playbook = PLAYBOOK[tab];
  const storageKey = `${STORAGE_PREFIX}:${tab}`;

  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = window.localStorage.getItem(storageKey);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  const [open, setOpen] = useState(true);

  // Re-hydrate ticks when the operator switches tabs so each playbook
  // keeps its own progress.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      setChecked(raw ? JSON.parse(raw) : {});
    } catch {
      setChecked({});
    }
  }, [storageKey]);

  // Persist ticks on every change.
  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(checked));
    } catch {
      /* storage may be unavailable */
    }
  }, [checked, storageKey]);

  const completed = useMemo(
    () => playbook.steps.filter((s) => checked[s.id]).length,
    [playbook.steps, checked],
  );
  const total = playbook.steps.length;
  const allDone = completed === total;

  // Auto-collapse once finished so it doesn't crowd the queue.
  useEffect(() => {
    if (allDone) setOpen(false);
  }, [allDone]);

  const toggle = (id: string) => {
    hapticTap();
    setChecked((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const reset = () => {
    hapticTap();
    setChecked({});
    setOpen(true);
  };

  return (
    <div className="rounded-2xl border border-primary/15 bg-gradient-to-br from-primary/[0.06] via-primary/[0.03] to-transparent shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => {
          hapticTap();
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        aria-controls={`checklist-${tab}-panel`}
        className="w-full flex items-center justify-between gap-3 px-3.5 py-3 min-h-[56px] text-left active:bg-primary/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className={cn(
              'h-9 w-9 rounded-xl flex items-center justify-center shrink-0 transition-colors',
              allDone
                ? 'bg-success/15 text-success'
                : 'bg-primary/15 text-primary',
            )}
          >
            {allDone ? (
              <CheckCircle2 className="h-5 w-5" />
            ) : (
              <ListChecks className="h-5 w-5" />
            )}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold tracking-tight leading-tight truncate">
              {allDone ? 'All steps done — nice work' : playbook.heading}
            </p>
            <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">
              {allDone
                ? 'Tap to review the steps again'
                : 'A quick checklist so you never miss a step'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge
            variant="outline"
            className={cn(
              'h-6 px-2 text-[11px] font-semibold tabular-nums',
              allDone
                ? 'bg-success/10 text-success border-success/30'
                : 'bg-background',
            )}
          >
            {completed}/{total}
          </Badge>
          <motion.span
            animate={{ rotate: open ? 180 : 0 }}
            transition={{ duration: 0.2 }}
            className="h-7 w-7 rounded-lg bg-background/80 border border-border/60 flex items-center justify-center"
          >
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          </motion.span>
        </div>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={`checklist-${tab}-panel`}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3">
              {/* Slim progress bar — a visual cue for operators who scan
                  faster than they read. */}
              <div className="h-1.5 w-full rounded-full bg-muted/60 overflow-hidden mb-2.5">
                <motion.div
                  className={cn(
                    'h-full rounded-full',
                    allDone ? 'bg-success' : 'bg-primary',
                  )}
                  initial={false}
                  animate={{ width: `${(completed / total) * 100}%` }}
                  transition={{ duration: 0.25 }}
                />
              </div>

              <ol className="space-y-1.5">
                {playbook.steps.map((step, index) => {
                  const isDone = !!checked[step.id];
                  return (
                    <li key={step.id}>
                      <button
                        type="button"
                        onClick={() => toggle(step.id)}
                        aria-pressed={isDone}
                        className={cn(
                          'w-full flex items-start gap-3 rounded-xl border p-3 text-left transition-all min-h-[56px] active:scale-[0.99]',
                          isDone
                            ? 'bg-success/[0.06] border-success/25'
                            : 'bg-background border-border/60 hover:border-primary/30 hover:bg-primary/[0.03]',
                        )}
                        style={{ WebkitTapHighlightColor: 'transparent' }}
                      >
                        <div className="shrink-0 mt-0.5">
                          {isDone ? (
                            <CheckCircle2 className="h-5 w-5 text-success" />
                          ) : (
                            <Circle className="h-5 w-5 text-muted-foreground/60" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span
                              className={cn(
                                'h-5 w-5 rounded-md text-[11px] font-bold flex items-center justify-center tabular-nums',
                                isDone
                                  ? 'bg-success/15 text-success'
                                  : 'bg-muted text-muted-foreground',
                              )}
                            >
                              {index + 1}
                            </span>
                            <p
                              className={cn(
                                'text-sm font-semibold tracking-tight leading-tight',
                                isDone &&
                                  'line-through text-muted-foreground',
                              )}
                            >
                              {step.title}
                            </p>
                          </div>
                          <p className="text-[12px] text-muted-foreground leading-snug mt-1 pl-7">
                            {step.detail}
                          </p>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ol>

              {completed > 0 && (
                <div className="flex justify-end mt-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={reset}
                    className="h-7 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Reset checklist
                  </Button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}