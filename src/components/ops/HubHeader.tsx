import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';

/**
 * Shared sticky hub header: "Back to Overview · <Section>" plus an optional
 * trailing slot (e.g. a section switcher). Presentation only.
 */
export function HubHeader({
  title,
  onBack,
  backLabel = 'Back to Overview',
  trailing,
}: {
  title?: string;
  onBack: () => void;
  backLabel?: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 mb-3 sticky top-0 z-30 -mx-4 px-4 py-2 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b border-border/60">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-2 text-sm font-semibold text-foreground hover:text-primary transition-colors min-h-[44px] touch-manipulation min-w-0"
      >
        <ArrowLeft className="h-4 w-4 shrink-0" />
        <span className="shrink-0">{backLabel}</span>
        {title && <span className="text-muted-foreground font-normal truncate hidden sm:inline">· {title}</span>}
      </button>
      {trailing}
    </div>
  );
}
