import { X } from 'lucide-react';
import type { RenderedNudge } from '@/lib/agentNudges';

interface Props {
  nudge: RenderedNudge;
  ctaLabel?: string;
  onCta?: () => void;
  onClose: () => void;
}

/** Simple, calm nudge toast: plain card, text only, underlined text link for the action. */
export function AgentNudgeToast({ nudge, ctaLabel, onCta, onClose }: Props) {
  return (
    <div
      role="status"
      className="relative w-[calc(100vw-2rem)] max-w-[420px] rounded-lg border border-border bg-card p-3 pr-9 text-card-foreground shadow-md"
    >
      <p className="text-sm font-semibold leading-tight">{nudge.title}</p>
      <p className="mt-1 text-sm leading-snug text-muted-foreground">{nudge.body}</p>
      {ctaLabel && onCta && (
        <button
          type="button"
          onClick={onCta}
          className="mt-1.5 text-sm font-medium text-primary underline underline-offset-2 hover:text-primary/80"
        >
          {ctaLabel}
        </button>
      )}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export default AgentNudgeToast;
