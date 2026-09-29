import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { ArrowDown, ArrowUp, ChevronRight, Info } from 'lucide-react';

type HeroCardTone = 'success' | 'warning' | 'info' | 'primary' | 'destructive';

const TONE_STYLES: Record<HeroCardTone, { icon: string; trend: string; stroke: string }> = {
  success: { icon: 'bg-success text-success-foreground', trend: 'text-success', stroke: 'hsl(var(--success))' },
  warning: { icon: 'bg-warning text-warning-foreground', trend: 'text-destructive', stroke: 'hsl(var(--destructive))' },
  info: { icon: 'bg-info text-info-foreground', trend: 'text-success', stroke: 'hsl(var(--info))' },
  primary: { icon: 'bg-primary text-primary-foreground', trend: 'text-success', stroke: 'hsl(var(--primary))' },
  destructive: { icon: 'bg-destructive text-destructive-foreground', trend: 'text-destructive', stroke: 'hsl(var(--destructive))' },
};

/** A compact percentage gauge, not a historical cash-balance trend. */
export function PercentageCurve({ value, total, tone = 'success' }: { value: number; total: number; tone?: HeroCardTone }) {
  const gradientId = useId().replace(/:/g, '');
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return null;

  const share = Math.max(0, Math.min(1, value / total));
  // The endpoint represents the current share. A square-root display scale
  // keeps very small shares legible in a 32px-high gauge; the number beside it
  // remains the precise comparison, including shares greater than 100%.
  const endY = 25 - 19 * Math.sqrt(share);
  const startY = 29;
  const midY = (startY + endY) / 2;
  const curve = `M 1 ${startY} C 14 ${startY - 3}, 18 ${midY + 2}, 30 ${midY} S 47 ${midY + 2}, 56 ${midY - 1} S 69 ${endY + 3}, 79 ${endY}`;
  const stroke = TONE_STYLES[tone].stroke;

  return (
    <svg viewBox="0 0 80 32" preserveAspectRatio="none" className="h-8 w-20 shrink-0" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity={0.26} />
          <stop offset="100%" stopColor={stroke} stopOpacity={0.015} />
        </linearGradient>
      </defs>
      <path d={`${curve} L 79 32 L 1 32 Z`} fill={`url(#${gradientId})`} />
      <path d={curve} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Compact financial summary card.
 *
 * The card shows the icon chip, label, the primary amount and one line of
 * essential context. Tapping the card opens a modal with the same breakdown
 * rows and a reconciling total. No figure is derived here: every value is
 * passed in already computed.
 */
export function HeroCard({ icon, iconBg, tone, title, value, percentageLabel, percentageDirection, percentageValue, percentageTotal, items, footer, footerTone, onClick, className, action }: {
  icon: React.ReactNode;
  iconBg?: string;
  tone?: HeroCardTone;
  title: string;
  value: string;
  percentageLabel?: string;
  percentageDirection?: 'up' | 'down';
  percentageValue?: number;
  percentageTotal?: number;
  items: { dot: string; label: string; value: string; onSelect?: () => void }[];
  footer?: string;
  footerTone?: string;
  onClick?: () => void;
  /** Sizing hooks for the caller's layout (e.g. "flex-1" inside a column). */
  className?: string;
  /** Optional control rendered inside the card, below the tappable summary. */
  action?: React.ReactNode;
}) {

  const [open, setOpen] = useState(false);
  // Colour carries meaning through the icon tile, as in the reference design;
  // the amount stays foreground so the cards read as one set. A negative figure
  // is the one case that still needs to shout, so it keeps the destructive tone.
  const negative = value.trim().startsWith('-');
  const palette = TONE_STYLES[tone ?? 'primary'];
  const iconClass = iconBg ?? palette.icon;
  const showCurve = percentageValue !== undefined && percentageTotal !== undefined && percentageTotal > 0;

  return (
    <>
      <div className={`w-full min-w-0 flex flex-col rounded-xl border border-border/70 bg-card shadow-sm transition-shadow hover:shadow-md ${className ?? ''}`}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full min-w-0 text-left p-4 rounded-xl flex-1 flex flex-col focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >

          <div className="flex items-start justify-between gap-3">
            <div className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 shadow-sm ${iconClass}`}>{icon}</div>
            <span
              className="flex h-5 w-5 items-center justify-center rounded-full bg-muted/60 shrink-0"
              aria-hidden
            >
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            </span>
          </div>

          <p className="mt-3 text-[11px] font-semibold text-muted-foreground truncate">{title}</p>
          <p
            className={`mt-1.5 whitespace-nowrap text-[17px] leading-tight sm:text-xl xl:text-[16px] 2xl:text-xl font-bold tabular-nums tracking-normal ${negative ? 'text-destructive' : 'text-foreground'}`}
          >
            {value}
          </p>
          {(percentageLabel || showCurve) && (
            <div className="mt-auto pt-2 flex min-h-9 items-end justify-between gap-2">
              {percentageLabel ? (
                <p className={`min-w-0 flex items-center gap-1 text-[11px] font-medium ${percentageDirection ? palette.trend : 'text-muted-foreground'}`}>
                  {percentageDirection === 'up' ? <ArrowUp className="h-3 w-3 shrink-0" /> : null}
                  {percentageDirection === 'down' ? <ArrowDown className="h-3 w-3 shrink-0" /> : null}
                  <span>{percentageLabel}</span>
                </p>
              ) : <span />}
              {showCurve ? <PercentageCurve value={percentageValue} total={percentageTotal} tone={tone} /> : null}
            </div>
          )}
          {footer ? <p className="mt-2.5 text-[11px] text-muted-foreground line-clamp-2">{footer}</p> : null}
        </button>
        {action ? <div className="px-5 pb-5">{action}</div> : null}
      </div>


      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5 text-base">
              <span className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 ${iconClass}`}>{icon}</span>
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
