import { useState, type ReactNode } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';

/**
 * On a phone, the same filter controls open in a full-height sheet.
 * From 768px up they stay inline. Search stays outside this component.
 */
export function MobileFilterSheet({
  children,
  title = 'Filters',
  active = false,
}: {
  children: ReactNode;
  title?: string;
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="md:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button type="button" variant="outline" className="h-11 w-full justify-between text-sm">
              <span className="inline-flex items-center gap-2">
                <SlidersHorizontal className="h-4 w-4" />
                {title}
              </span>
              {active ? <Badge variant="secondary">Active</Badge> : <span className="text-xs font-normal text-muted-foreground">Tap to open</span>}
            </Button>
          </SheetTrigger>
          <SheetContent
            side="bottom"
            className="landlord-ops-filter-sheet flex h-[100dvh] max-h-[100dvh] flex-col overflow-y-auto rounded-none pb-[calc(env(safe-area-inset-bottom)+1rem)]"
          >
            <SheetHeader className="text-left">
              <SheetTitle>{title}</SheetTitle>
            </SheetHeader>
            <div className="mt-4 space-y-4">{children}</div>
          </SheetContent>
        </Sheet>
      </div>
      <div className="hidden space-y-3 md:block">{children}</div>
    </>
  );
}
