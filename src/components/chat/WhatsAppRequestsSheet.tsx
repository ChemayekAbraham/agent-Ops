import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { MessageCircle } from 'lucide-react';

interface WhatsAppRequestsSheetProps {
  trigger?: React.ReactNode;
}

// whatsapp_requests table removed - stub sheet
export function WhatsAppRequestsSheet({ trigger }: WhatsAppRequestsSheetProps) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        {trigger || (
          <Button variant="ghost" size="icon">
            <MessageCircle className="h-5 w-5" />
          </Button>
        )}
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>WhatsApp Requests</SheetTitle>
        </SheetHeader>
        <div className="py-12 text-center text-muted-foreground">
          <MessageCircle className="h-12 w-12 mx-auto mb-3 opacity-50" />
          <p>WhatsApp requests feature is currently unavailable.</p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
