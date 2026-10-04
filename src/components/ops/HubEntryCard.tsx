import type { ElementType } from 'react';
import { ArrowRight } from 'lucide-react';

export interface HubEntryStat {
  label: string;
  value: string | number;
}

/**
 * Shared "Open hub" entry tile used by the Tenant Ops and Landlord Ops
 * dashboards. Presentation only — the caller owns the navigation.
 */
export function HubEntryCard({
  title,
  description,
  icon: Icon,
  stats,
  onClick,
}: {
  title: string;
  description: string;
  icon: ElementType;
  stats?: HubEntryStat[];
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Open ${title} hub`}
      className="group w-full cursor-pointer rounded-xl border bg-card p-3 sm:p-3.5 flex items-start gap-3 text-left min-h-[64px] touch-manipulation hover:border-primary/60 hover:shadow-md active:scale-[0.99] transition-all shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      <div className="p-2 rounded-lg bg-primary/10 shrink-0">
        <Icon className="h-5 w-5 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-bold text-sm text-foreground leading-tight break-words hyphens-none">{title}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug break-words hyphens-none">{description}</p>
        {stats && stats.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {stats.map((s) => (
              <span
                key={s.label}
                className="inline-flex items-baseline gap-1 whitespace-nowrap rounded-full border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground"
              >
                <span className="font-bold text-foreground">{s.value}</span>
                {s.label}
              </span>
            ))}
          </div>
        )}
      </div>
      <span className="shrink-0 hidden 2xl:inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-primary px-3 py-1.5 text-[11px] font-bold text-primary-foreground shadow-sm group-hover:bg-primary/90 transition-colors">
        Open hub
        <ArrowRight className="h-3.5 w-3.5" />
      </span>
      <ArrowRight className="h-5 w-5 text-primary shrink-0 2xl:hidden mt-1" />


    </button>
  );
}
