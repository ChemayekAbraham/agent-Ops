import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { HandHeart, Sparkles, ChevronRight } from 'lucide-react';

export type SupportMode = 'self' | 'auto';

/**
 * Asks the agent how the partner wants to back tenants before the note is
 * captured. UI-only: the choice simply decides whether the ready-to-fund
 * tenant queue is shown for hand-picking.
 */
export function SupportModeChooserDialog({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (mode: SupportMode) => void;
}) {
  const options: {
    mode: SupportMode;
    title: string;
    sub: string;
    body: string;
    icon: typeof HandHeart;
    tone: string;
  }[] = [
    {
      mode: 'self',
      title: 'Self support tenant',
      sub: 'Partner supports the tenants directly',
      body: 'Pick the tenants from the ready-to-fund queue yourself, so the partner knows exactly which homes their money keeps.',
      icon: HandHeart,
      tone: 'border-primary/30 bg-primary/5',
    },
    {
      mode: 'auto',
      title: 'Auto support tenant',
      sub: 'Company handles supporting the tenant',
      body: 'Welile matches the partner to tenants as they come through — nothing to choose now, the desk does the placing.',
      icon: Sparkles,
      tone: 'border-emerald-500/30 bg-emerald-500/5',
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent stable className="max-w-md">
        <DialogHeader>
          <DialogTitle>How will this partner support tenants?</DialogTitle>
          <DialogDescription className="text-xs">
            Choose one — you can capture the promissory note straight after.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2.5">
          {options.map((o) => (
            <button
              key={o.mode}
              type="button"
              onClick={() => onSelect(o.mode)}
              className={`w-full text-left rounded-2xl border p-3 flex items-start gap-3 active:scale-[0.99] transition ${o.tone}`}
            >
              <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-background border border-border">
                <o.icon className="h-4 w-4 text-primary" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold leading-tight">{o.title}</span>
                <span className="block text-[11px] font-semibold text-muted-foreground">{o.sub}</span>
                <span className="mt-1 block text-[11px] text-muted-foreground leading-snug">{o.body}</span>
              </span>
              <ChevronRight className="mt-2 h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
