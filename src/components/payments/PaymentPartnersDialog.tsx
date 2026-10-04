import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import PaymentPartnersCard from './PaymentPartnersCard';
import savingsIllustration from '@/assets/savings-illustration.svg.asset.json';

interface PaymentPartnersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dashboardType: 'tenant' | 'supporter';
  title?: string;
}

export default function PaymentPartnersDialog({ 
  open, 
  onOpenChange, 
  dashboardType,
  title = 'Payment Partners'
}: PaymentPartnersDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto p-0 [&>button]:fixed [&>button]:right-4 [&>button]:top-4 [&>button]:z-[200] [&>button]:bg-background/90 [&>button]:shadow-md">
        <div className="flex items-center justify-center bg-muted/40 px-4 pt-6 pb-2">
          <img
            src={savingsIllustration.url}
            alt="Savings illustration"
            loading="lazy"
            className="h-32 w-auto sm:h-40"
          />
        </div>
        <DialogHeader className="p-4 pb-0">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[calc(90vh-80px)] p-4 pt-2">
          <PaymentPartnersCard 
            dashboardType={dashboardType}
            onPaymentSubmitted={() => onOpenChange(false)}
          />
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
