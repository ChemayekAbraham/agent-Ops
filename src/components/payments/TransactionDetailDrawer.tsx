import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import StatusBadge from './StatusBadge';
import { Transaction } from './TransactionTable';
import { Download, AlertTriangle, Copy, ArrowUpRight, ArrowDownLeft, Headphones } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface TransactionDetailDrawerProps {
  transaction: Transaction | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDownload?: (transaction: Transaction) => void;
  onReportIssue?: (transaction: Transaction) => void;
}

export default function TransactionDetailDrawer({
  transaction,
  open,
  onOpenChange,
  onDownload,
  onReportIssue,
}: TransactionDetailDrawerProps) {
  if (!transaction) return null;

  const isIncoming = transaction.type === 'deposit' || transaction.type === 'refund';
  const TypeIcon = isIncoming ? ArrowDownLeft : ArrowUpRight;

  const handleCopyReference = async () => {
    await navigator.clipboard.writeText(transaction.reference);
    toast.success('Reference copied!');
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[85vh] rounded-t-2xl">
        <SheetHeader className="text-left pb-4">
          <SheetTitle>Transaction Details</SheetTitle>
        </SheetHeader>

        <div className="space-y-6 overflow-y-auto max-h-[calc(85vh-100px)]">
          {/* Status and amount header */}
          <div className="text-center py-6 bg-muted/30 rounded-2xl">
            <div className={cn(
              'w-12 h-12 mx-auto mb-3 rounded-full flex items-center justify-center',
              isIncoming ? 'bg-emerald-100 text-emerald-600' : 'bg-orange-100 text-orange-600'
            )}>
              <TypeIcon className="w-6 h-6" />
            </div>
            <p className="text-sm text-muted-foreground mb-1 capitalize">{transaction.type}</p>
            <p className={cn(
              'text-3xl font-bold',
              isIncoming && 'text-emerald-600'
            )}>
              {isIncoming ? '+' : '-'} {transaction.currency} {transaction.amount.toLocaleString()}
            </p>
            <div className="mt-3">
              <StatusBadge status={transaction.status} />
            </div>
          </div>

          {/* Transaction details */}
          <div className="space-y-4">
            <h4 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">
              Transaction Info
            </h4>
            
            <div className="space-y-3">
              <div className="flex justify-between py-2">
                <span className="text-muted-foreground">Method</span>
                <span className="font-medium">{transaction.method}</span>
              </div>
              <Separator />
              
              <div className="flex justify-between py-2">
                <span className="text-muted-foreground">Date</span>
                <span className="font-medium">{format(transaction.date, 'MMMM d, yyyy')}</span>
              </div>
              <Separator />
              
              <div className="flex justify-between py-2">
                <span className="text-muted-foreground">Time</span>
                <span className="font-medium">{format(transaction.date, 'HH:mm:ss')}</span>
              </div>
              <Separator />

              {transaction.recipient && (
                <>
                  <div className="flex justify-between py-2">
                    <span className="text-muted-foreground">Recipient</span>
                    <span className="font-medium">{transaction.recipient}</span>
                  </div>
                  <Separator />
                </>
              )}

              {transaction.description && (
                <>
                  <div className="flex justify-between py-2">
                    <span className="text-muted-foreground">Description</span>
                    <span className="font-medium text-right max-w-[200px]">{transaction.description}</span>
                  </div>
                  <Separator />
                </>
              )}

              <div className="flex justify-between py-2 items-center">
                <span className="text-muted-foreground">Reference</span>
                <button 
                  onClick={handleCopyReference}
                  className="flex items-center gap-2 font-mono text-sm hover:text-primary transition-colors"
                >
                  <span className="truncate max-w-[180px]">{transaction.reference}</span>
                  <Copy className="w-4 h-4 flex-shrink-0" />
                </button>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="space-y-3 pt-4">
            {transaction.status === 'success' && onDownload && (
              <Button 
                onClick={() => onDownload(transaction)} 
                className="w-full gap-2"
                size="lg"
              >
                <Download className="w-4 h-4" />
                Download Receipt
              </Button>
            )}
            
            <Button 
              onClick={() => onReportIssue?.(transaction)} 
              variant="outline" 
              className="w-full gap-2"
              size="lg"
            >
              <AlertTriangle className="w-4 h-4" />
              Report Issue
            </Button>

            <div className="flex justify-center pt-2">
              <button className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
                <Headphones className="w-4 h-4" />
                Contact Support
              </button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
