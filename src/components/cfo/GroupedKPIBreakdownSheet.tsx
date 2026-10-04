import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Separator } from '@/components/ui/separator';

export interface GroupedBreakdownGroup {
  label: string;
  emoji: string;
  items: { label: string; value: number; count?: number }[];
  total: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  total: number;
  groups: GroupedBreakdownGroup[];
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-UG', { style: 'currency', currency: 'UGX', maximumFractionDigits: 0 }).format(n);

export function GroupedKPIBreakdownSheet({ open, onOpenChange, title, total, groups }: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="rounded-t-2xl max-h-[70vh] overflow-y-auto">
        <SheetHeader className="pb-3">
          <SheetTitle className="text-base">{title}</SheetTitle>
        </SheetHeader>

        <div className="space-y-4">
          {groups.map((group, gi) => (
            <div key={gi}>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  {group.emoji} {group.label}
                </span>
                <span className="text-xs font-mono font-bold text-emerald-600">
                  {fmt(group.total)}
                </span>
              </div>
              <div className="space-y-1 pl-4">
                {group.items.map((item, ii) => (
                  <div key={ii} className="flex items-center justify-between py-1 text-sm">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                      <span className="text-muted-foreground truncate">{item.label}</span>
                      {item.count != null && (
                        <span className="text-muted-foreground text-xs shrink-0">({item.count})</span>
                      )}
                    </div>
                    <span className="font-mono font-medium shrink-0">{fmt(item.value)}</span>
                  </div>
                ))}
              </div>
              {gi < groups.length - 1 && <Separator className="mt-3" />}
            </div>
          ))}
        </div>

        <Separator className="my-3" />

        <div className="flex items-center justify-between px-1 pb-2">
          <span className="text-sm font-bold">Total</span>
          <span className="text-lg font-bold font-mono">{fmt(total)}</span>
        </div>
      </SheetContent>
    </Sheet>
  );
}
