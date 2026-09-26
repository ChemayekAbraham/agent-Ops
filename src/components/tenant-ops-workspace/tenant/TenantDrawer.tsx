import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import Tenant360 from './Tenant360';

/** Opens Tenant360 in a drawer so a row action never navigates away from the list. */
export function TenantDrawer({
  rentRequestId,
  onOpenChange,
}: {
  rentRequestId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={!!rentRequestId} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Tenant</SheetTitle>
        </SheetHeader>
        <div className="mt-4">{rentRequestId && <Tenant360 rentRequestId={rentRequestId} />}</div>
      </SheetContent>
    </Sheet>
  );
}
