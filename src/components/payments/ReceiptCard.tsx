import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import StatusBadge, { TransactionStatus } from './StatusBadge';
import { Download, Share2, Copy, CheckCircle2, XCircle, AlertTriangle, RotateCcw, MessageCircle, Headphones } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { buildReceiptText, shareViaWhatsApp } from '@/lib/shareReceipt';

interface ReceiptCardProps {
  status: TransactionStatus;
  amount: number;
  currency: string;
  fees?: number;
  total?: number;
  recipient?: string;
  reference: string;
  method: string;
  date: Date;
  onDownload?: () => void;
  onShare?: () => void;
  onTryAgain?: () => void;
  onChangeMethod?: () => void;
  onContactSupport?: () => void;
  onClose?: () => void;
}

export default function ReceiptCard({
  status,
  amount,
  currency,
  fees = 0,
  total,
  recipient,
  reference,
  method,
  date,
  onDownload,
  onShare,
  onTryAgain,
  onChangeMethod,
  onContactSupport,
  onClose,
}: ReceiptCardProps) {
  const finalTotal = total ?? amount + fees;
  const isSuccess = status === 'success';
  const isFailed = status === 'failed' || status === 'cancelled';

  const handleCopyReference = async () => {
    await navigator.clipboard.writeText(reference);
    toast.success('Reference copied!');
  };

  const StatusIcon = isSuccess ? CheckCircle2 : isFailed ? XCircle : AlertTriangle;
  const statusColor = isSuccess ? 'text-emerald-500' : isFailed ? 'text-red-500' : 'text-amber-500';
  const statusBg = isSuccess ? 'bg-emerald-500/10' : isFailed ? 'bg-red-500/10' : 'bg-amber-500/10';

  return (
    <Card className="overflow-hidden">
      {/* Status header */}
      <div className={cn('p-6 text-center', statusBg)}>
        <StatusIcon className={cn('w-16 h-16 mx-auto mb-3', statusColor)} />
        <h3 className="text-xl font-bold mb-1">
          {isSuccess ? 'Payment Successful!' : isFailed ? 'Payment Failed' : 'Payment Pending'}
        </h3>
        <p className="text-sm text-muted-foreground">
          {isSuccess ? 'Your transaction has been completed' : 
           isFailed ? 'Something went wrong with your payment' :
           'Your payment is being processed'}
        </p>
      </div>

      <CardContent className="p-4 space-y-4">
        {/* Amount */}
        <div className="text-center py-4 bg-muted/30 rounded-xl">
          <p className="text-sm text-muted-foreground mb-1">Amount Paid</p>
          <p className="text-3xl font-bold">
            {currency} {finalTotal.toLocaleString()}
          </p>
        </div>

        {/* Details */}
        <div className="space-y-3">
          {recipient && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Recipient</span>
              <span className="font-medium">{recipient}</span>
            </div>
          )}
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Method</span>
            <span className="font-medium">{method}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Amount</span>
            <span>{currency} {amount.toLocaleString()}</span>
          </div>
          {fees > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Fees</span>
              <span>{currency} {fees.toLocaleString()}</span>
            </div>
          )}
          <Separator />
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Date & Time</span>
            <span>{format(date, 'MMM d, yyyy HH:mm')}</span>
          </div>
          <div className="flex justify-between text-sm items-center">
            <span className="text-muted-foreground">Status</span>
            <StatusBadge status={status} size="sm" />
          </div>
        </div>

        {/* Success actions */}
        {isSuccess && (
          <>
            <div className="grid grid-cols-2 gap-2 pt-2">
              <Button onClick={onDownload} variant="outline" className="gap-2">
                <Download className="w-4 h-4" />
                Download
              </Button>
              <Button onClick={onShare} variant="outline" className="gap-2">
                <Share2 className="w-4 h-4" />
                Share
              </Button>
            </div>
            <Button
              onClick={() => {
                const text = buildReceiptText({
                  type: 'payment',
                  amount: finalTotal,
                  currency,
                  recipientOrSender: recipient,
                  reference,
                  date: format(date, 'MMM d, yyyy HH:mm'),
                  method,
                  status: 'Successful',
                });
                shareViaWhatsApp(text);
                toast.success('Opening WhatsApp...');
              }}
              variant="outline"
              className="w-full gap-2 border-emerald-500/30 text-emerald-600 hover:bg-emerald-500/10"
            >
              <MessageCircle className="w-4 h-4" />
              Share on WhatsApp
            </Button>
          </>
        )}

        {/* Failed actions */}
        {isFailed && (
          <div className="space-y-2 pt-2">
            <div className="grid grid-cols-2 gap-2">
              <Button onClick={onTryAgain} className="gap-2">
                <RotateCcw className="w-4 h-4" />
                Try Again
              </Button>
              <Button onClick={onChangeMethod} variant="outline" className="gap-2">
                Change Method
              </Button>
            </div>
            <Button onClick={onContactSupport} variant="ghost" className="w-full gap-2">
              <Headphones className="w-4 h-4" />
              Contact Support
            </Button>
          </div>
        )}

        {/* Close/Back button */}
        {onClose && (
          <Button onClick={onClose} variant="ghost" className="w-full mt-2">
            Back to Dashboard
          </Button>
        )}

        {/* Support link */}
        <div className="flex justify-center gap-4 pt-2 text-xs text-muted-foreground">
          <button className="flex items-center gap-1 hover:text-foreground transition-colors">
            <Headphones className="w-3 h-3" />
            Support
          </button>
          <button className="flex items-center gap-1 hover:text-foreground transition-colors">
            <AlertTriangle className="w-3 h-3" />
            Report Issue
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
