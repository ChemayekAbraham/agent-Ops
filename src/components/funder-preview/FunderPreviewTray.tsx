import { motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, Home, Plus, Sprout, Undo2, X } from 'lucide-react';
import { formatDynamic } from '@/lib/currencyFormat';
import type { FunderNewSelectionItem } from '@/components/funder-new/types';
import { FunderPreviewStepper } from './FunderPreviewStepper';

export interface FunderPreviewSuggestion {
  title: string;
  distanceLabel: string;
  amount: number;
  onAdd: () => void;
}

/**
 * Bottom tray shown while the plan has homes. It keeps the Supporter on the
 * list (picking never navigates away) and always shows the next step.
 */
export function FunderPreviewTray({
  items,
  suggestion,
  onUndoLast,
  onClear,
  onReview,
}: {
  items: FunderNewSelectionItem[];
  suggestion: FunderPreviewSuggestion | null;
  onUndoLast: () => void;
  onClear: () => void;
  onReview: () => void;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  if (items.length === 0) return null;
  const total = items.reduce((sum, item) => sum + item.amount, 0);
  const count = items.length;
  const last = items[items.length - 1];
  const thumbs = items.slice(-3);

  return (
    <motion.section
      aria-label="Your plan"
      className="fixed inset-x-0 bottom-0 z-[110] mx-auto max-w-3xl rounded-t-[28px] bg-card px-5 pb-[max(1.6rem,env(safe-area-inset-bottom))] pt-2.5 font-['Outfit'] shadow-[0_-10px_30px_-8px_hsl(var(--primary)/0.3)]"
      {...(reduceMotion
        ? {}
        : {
            initial: { y: '100%' },
            animate: { y: 0 },
            transition: { type: 'spring', stiffness: 380, damping: 34 },
          })}
    >
      <div aria-hidden className="mx-auto mb-3 h-[5px] w-10 rounded-full bg-border" />
      <div className="space-y-3.5">
        <div className="flex items-center gap-3">
          <div aria-hidden className="flex flex-none">
            {thumbs.map((item, index) =>
              item.imageUrl ? (
                <img
                  key={item.id}
                  src={item.imageUrl}
                  alt=""
                  className="h-12 w-12 rounded-[14px] border-2 border-card object-cover"
                  style={{ marginLeft: index ? -18 : 0 }}
                />
              ) : (
                <span
                  key={item.id}
                  className="flex h-12 w-12 items-center justify-center rounded-[14px] border-2 border-card bg-primary/10 text-primary"
                  style={{ marginLeft: index ? -18 : 0 }}
                >
                  <Home className="h-5 w-5" />
                </span>
              ),
            )}
          </div>
          <div className="min-w-0 flex-1" aria-live="polite" aria-atomic="true">
            <h2 className="text-[17px] font-bold">
              {count} {count === 1 ? 'home' : 'homes'} in your plan
            </h2>
            <p className="truncate text-sm text-muted-foreground">
              {formatDynamic(total)} · {count === 1 ? last.title : `latest: ${last.title}`}
            </p>
          </div>
          <button
            type="button"
            onClick={onUndoLast}
            aria-label={`Undo: remove ${last.title}`}
            className="flex h-11 w-11 flex-none items-center justify-center rounded-full border bg-background text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Undo2 className="h-5 w-5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear the whole plan"
            className="flex h-11 w-11 flex-none items-center justify-center rounded-full border bg-background text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        <FunderPreviewStepper current={0} />

        {suggestion ? (
          <div className="flex items-center gap-2.5 rounded-2xl bg-primary/10 p-3 text-primary">
            <Sprout className="h-[22px] w-[22px] flex-none" aria-hidden />
            <p className="text-[13px] font-medium leading-[18px]">
              A {suggestion.title.toLowerCase()} is {suggestion.distanceLabel} from your last pick ({formatDynamic(suggestion.amount)}).
              Add it to back two homes in one area.
            </p>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-2.5">
          {suggestion ? (
            <button
              type="button"
              onClick={suggestion.onAdd}
              className="flex h-[52px] items-center justify-center gap-1.5 rounded-2xl border-[1.5px] border-primary bg-card text-base font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus className="h-[18px] w-[18px]" aria-hidden />
              Add it
            </button>
          ) : null}
          <button
            type="button"
            onClick={onReview}
            className={`flex h-[52px] items-center justify-center gap-1.5 rounded-2xl bg-primary text-base font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${suggestion ? '' : 'col-span-2'}`}
          >
            Review plan
            <ArrowRight className="h-[18px] w-[18px]" aria-hidden />
          </button>
        </div>
      </div>
    </motion.section>
  );
}
