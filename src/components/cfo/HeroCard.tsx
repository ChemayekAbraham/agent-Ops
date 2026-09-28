import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { ChevronRight, Info } from 'lucide-react';

/**
 * Compact financial summary card.
 *
 * The card shows the icon chip, label, the primary amount and one line of
 * essential context. Tapping the card opens a modal with the same breakdown
 * rows and a reconciling total. No figure is derived here: every value is
 * passed in already computed.
 */
export function HeroCard({ icon, iconBg, title, value, percentageLabel, items, footer, footerTone, onClick, className }: {
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  value: string;
  percentageLabel?: string;
  items: { dot: string; label: string; value: string; onSelect?: () => void }[];
  footer?: string;
  footerTone?: string;
  onClick?: () => void;
  /** Sizing hooks for the caller's layout (e.g. "flex-1" inside a column). */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // Colour carries meaning through the icon tile, as in the reference design;
  // the amount stays foreground so the cards read as one set. A negative figure
  // is the one case that still needs to shout, so it keeps the destructive tone.
  const negative = value.trim().startsWith('-');

  return (
    <>
      <div className={`w-full flex flex-col rounded-2xl border border-border/70 bg-card shadow-sm transition-shadow hover:shadow-md ${className ?? ''}`}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full text-left p-5 rounded-2xl flex-1 flex flex-col focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >

          <div className="flex items-start justify-between gap-3">
            <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${iconBg}`}>{icon}</div>
            <span
              className="flex h-5 w-5 items-center justify-center rounded-full bg-muted/60 shrink-0"
              aria-hidden
            >
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            </span>
          </div>

          <p className="mt-4 text-[11px] font-medium text-muted-foreground truncate">{title}</p>
          <p
            className={`mt-1.5 text-[20px] leading-none sm:text-[22px] xl:text-[19px] 2xl:text-[24px] font-bold tabular-nums tracking-tight ${negative ? 'text-destructive' : 'text-foreground'}`}
          >
            {value}
          </p>
          {percentageLabel ? <p className="mt-2 text-[11px] font-medium text-muted-foreground">{percentageLabel}</p> : null}
          {footer ? <p className="mt-2.5 text-[11px] text-muted-foreground line-clamp-2">{footer}</p> : null}
        </button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5 text-base">
              <span className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${iconBg}`}>{icon}</span>
              {title}
            </DialogTitle>
            {title !== 'Money We Have' && <DialogDescription className="text-xs">{footer}</DialogDescription>}
          </DialogHeader>

          <div className="rounded-xl border border-border bg-muted/30 px-4 py-3">
            <p className="text-[11px] font-medium text-muted-foreground">{title}</p>
            <p className={`mt-1 text-xl sm:text-2xl font-bold tabular-nums tracking-tight ${negative ? 'text-destructive' : 'text-foreground'}`}>
              {value}
            </p>
            {percentageLabel ? <p className="mt-1 text-[11px] font-medium text-muted-foreground">{percentageLabel}</p> : null}
          </div>

          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Where it comes from</p>
            {items.map((it) =>
              it.onSelect ? (
                <button
                  key={it.label}
                  type="button"
                  onClick={() => { setOpen(false); it.onSelect?.(); }}
                  className="w-full flex items-center justify-between gap-3 py-2 border-b border-border/60 text-xs text-left rounded-md px-1 hover:bg-muted/50 transition-colors"
                >
                  <span className="flex items-center gap-2 min-w-0 text-muted-foreground">
                    <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${it.dot}`} />
                    <span className="truncate">{it.label}</span>
                  </span>
                  <span className="flex items-center gap-1.5 shrink-0">
                    <span className="tabular-nums font-medium text-right text-foreground">{it.value}</span>
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  </span>
                </button>
              ) : (
                <div key={it.label} className="flex items-center justify-between gap-3 py-2 border-b border-border/60 text-xs">
                  <span className="flex items-center gap-2 min-w-0 text-muted-foreground">
                    <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${it.dot}`} />
                    <span className="truncate">{it.label}</span>
                  </span>
                  <span className="tabular-nums font-medium shrink-0 text-right text-foreground">{it.value}</span>
                </div>
              ),
            )}
            {title !== 'Money We Have' && (
              <div className="mt-2 flex items-center justify-between gap-3 rounded-lg bg-muted/50 px-3 py-2.5">
                <span className="text-xs font-semibold">Total {title}</span>
                <span className={`text-sm font-bold tabular-nums ${negative ? 'text-destructive' : 'text-foreground'}`}>{value}</span>
              </div>
            )}
          </div>

          {title !== 'Money We Have' && footer && (
            <div className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-[11px] font-medium ${footerTone}`}>
              <span className="truncate">{footer}</span>
              <Info className="h-3 w-3 shrink-0 opacity-70" />
            </div>
          )}

          {onClick && (
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-between"
              onClick={() => { setOpen(false); onClick(); }}
            >
              <span>View full breakdown</span>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
