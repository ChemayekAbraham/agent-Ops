import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Separator } from '@/components/ui/separator';

export interface BreakdownItem {
  label: string;
  value: number;
  icon?: React.ReactNode;
}

interface KPIBreakdownSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  total: number;
  items: BreakdownItem[];
  centered?: boolean;
  totalLabel?: string;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-UG', { style: 'currency', currency: 'UGX', maximumFractionDigits: 0 }).format(n);

export function KPIBreakdownSheet({
  open,
  onOpenChange,
  title,
  total,
  items,
  centered = false,
  totalLabel = 'Total',
}: KPIBreakdownSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="rounded-t-2xl max-h-[70vh] overflow-y-auto">
        <SheetHeader className="pb-3">
          <SheetTitle className="text-base">{title}</SheetTitle>
        </SheetHeader>

        {centered ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {items.map((item, i) => (
              <div
                key={i}
                className="flex flex-col items-center justify-center text-center p-4 rounded-xl border border-border bg-card/50"
              >
                {item.icon && <span className="mb-2">{item.icon}</span>}
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {item.label}
                </span>
                <span
                  className={`mt-1 text-base font-bold font-mono ${
                    item.value < 0 ? 'text-destructive' : 'text-foreground'
                  }`}
                >
                  {fmt(item.value)}
                </span>
              </div>
            ))}
            <div className="flex flex-col items-center justify-center text-center p-4 rounded-xl border border-primary/20 bg-primary/5">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {totalLabel}
              </span>
              <span
                className={`mt-1 text-base font-bold font-mono ${
                  total < 0 ? 'text-destructive' : 'text-foreground'
                }`}
              >
                {fmt(total)}
              </span>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {items.map((item, i) => (
                <div key={i} className="flex items-center justify-between py-2 px-1">
                  <div className="flex items-center gap-2.5">
                    {item.icon && <span className="shrink-0">{item.icon}</span>}
                    <span className="text-sm text-muted-foreground">{item.label}</span>
                  </div>
                  <span className={`text-sm font-mono font-medium ${item.value < 0 ? 'text-red-600' : ''}`}>
                    {fmt(item.value)}
                  </span>
                </div>
              ))}
            </div>

            <Separator className="my-3" />

            <div className="flex items-center justify-between px-1 pb-2">
              <span className="text-sm font-bold">{totalLabel}</span>
              <span className={`text-lg font-bold font-mono ${total < 0 ? 'text-red-600' : 'text-foreground'}`}>
                {fmt(total)}
              </span>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
