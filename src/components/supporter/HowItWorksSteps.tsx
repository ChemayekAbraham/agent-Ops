import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, ListChecks, type LucideIcon } from 'lucide-react';
import { hapticTap } from '@/lib/haptics';

export interface HowItWorksStep {
  title: string;
  description: string;
  icon: LucideIcon;
}

/**
 * Collapsible "How it works" explainer. Renders as a single button that drops
 * down into a connected, numbered step flow (workflow-block style).
 */
export function HowItWorksSteps({
  steps,
  label = 'How it works',
  defaultOpen = false,
}: {
  steps: HowItWorksStep[];
  label?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-xl bg-primary/5 border border-primary/20 overflow-hidden">
      <button
        type="button"
        onClick={() => { hapticTap(); setOpen((o) => !o); }}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3.5 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        <span className="h-6 w-6 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
          <ListChecks className="h-3.5 w-3.5 text-primary" />
        </span>
        <span className="flex-1 text-xs font-bold text-foreground">{label}</span>
        <span className="text-[10px] font-semibold text-muted-foreground">
          {steps.length} steps
        </span>
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="steps"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <ol className="px-3.5 pb-3.5 pt-0.5 space-y-0">
              {steps.map((step, i) => {
                const Icon = step.icon;
                const isLast = i === steps.length - 1;
                return (
                  <motion.li
                    key={step.title}
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.04 * i, duration: 0.18 }}
                    className="relative flex gap-3 pb-3 last:pb-0"
                  >
                    {/* connector */}
                    {!isLast && (
                      <span
                        aria-hidden="true"
                        className="absolute left-[13px] top-7 bottom-0 w-px bg-primary/25"
                      />
                    )}
                    <span className="relative z-10 h-7 w-7 shrink-0 rounded-lg border border-primary/30 bg-background flex items-center justify-center">
                      <Icon className="h-3.5 w-3.5 text-primary" />
                    </span>
                    <div className="min-w-0 pt-0.5">
                      <p className="text-[11px] font-bold text-foreground leading-tight">
                        <span className="text-primary/70 mr-1">{i + 1}.</span>
                        {step.title}
                      </p>
                      <p className="text-[11px] text-muted-foreground leading-relaxed mt-0.5">
                        {step.description}
                      </p>
                    </div>
                  </motion.li>
                );
              })}
            </ol>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}