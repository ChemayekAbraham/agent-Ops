import { useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Download, Share2, CheckCircle, ArrowUpRight, ArrowDownLeft, MessageCircle } from 'lucide-react';
import { toast } from 'sonner';
// html-to-image loaded dynamically when needed
import { buildReceiptText, shareViaWhatsApp } from '@/lib/shareReceipt';

interface Transaction {
  id: string;
  sender_id: string;
  recipient_id: string;
  amount: number;
  description: string | null;
  created_at: string;
  sender_name?: string;
  recipient_name?: string;
}

interface TransactionReceiptProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transaction: Transaction | null;
  currentUserId: string;
}

export function TransactionReceipt({ 
  open, 
  onOpenChange, 
  transaction, 
  currentUserId 
}: TransactionReceiptProps) {
  const receiptRef = useRef<HTMLDivElement>(null);

  if (!transaction) return null;

  const isSent = transaction.sender_id === currentUserId;
  
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-UG', {
      style: 'currency',
      currency: 'UGX',
      minimumFractionDigits: 0,
    }).format(amount);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-UG', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatReceiptId = (id: string) => {
    return `WEL-${id.substring(0, 8).toUpperCase()}`;
  };

  const handleDownload = async () => {
    if (!receiptRef.current) return;

    try {
      const { toPng } = await import('html-to-image');
      const dataUrl = await toPng(receiptRef.current, {
        backgroundColor: '#ffffff',
        pixelRatio: 2,
      });
      
      const link = document.createElement('a');
      link.download = `welile-receipt-${formatReceiptId(transaction.id)}.png`;
      link.href = dataUrl;
      link.click();
      
      toast.success('Receipt downloaded successfully');
    } catch (error) {
      console.error('Failed to download receipt:', error);
      toast.error('Failed to download receipt');
    }
  };

  const handleShare = async () => {
    const shareText = `Welile Transaction Receipt\n${isSent ? 'Sent' : 'Received'}: ${formatCurrency(transaction.amount)}\n${isSent ? 'To' : 'From'}: ${isSent ? transaction.recipient_name : transaction.sender_name}\nDate: ${formatDate(transaction.created_at)}\nRef: ${formatReceiptId(transaction.id)}`;

    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Welile Transaction Receipt',
          text: shareText,
        });
        toast.success('Receipt shared successfully');
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          toast.error('Failed to share receipt');
        }
      }
    } else {
      await navigator.clipboard.writeText(shareText);
      toast.success('Receipt details copied to clipboard');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-center">Transaction Receipt</DialogTitle>
        </DialogHeader>

        {/* Receipt Card */}
        <div 
          ref={receiptRef} 
          className="bg-white text-black p-6 rounded-xl space-y-4"
        >
          {/* Header */}
          <div className="text-center space-y-2">
            <div className="flex justify-center">
              <div className={`p-3 rounded-full ${isSent ? 'bg-red-100' : 'bg-green-100'}`}>
                {isSent ? (
                  <ArrowUpRight className="h-8 w-8 text-red-600" />
                ) : (
                  <ArrowDownLeft className="h-8 w-8 text-green-600" />
                )}
              </div>
            </div>
            <h3 className="text-lg font-semibold text-gray-600">
              {isSent ? 'Money Sent' : 'Money Received'}
            </h3>
            <p className={`text-3xl font-bold ${isSent ? 'text-red-600' : 'text-green-600'}`}>
              {isSent ? '-' : '+'}{formatCurrency(transaction.amount)}
            </p>
          </div>

          {/* Status */}
          <div className="flex items-center justify-center gap-2 py-2 bg-green-50 rounded-lg">
            <CheckCircle className="h-5 w-5 text-green-600" />
            <span className="text-green-700 font-medium">Successful</span>
          </div>

          {/* Details */}
          <div className="space-y-3 pt-4 border-t border-dashed border-gray-300">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">{isSent ? 'Recipient' : 'Sender'}</span>
              <span className="font-medium">
                {isSent ? transaction.recipient_name : transaction.sender_name}
              </span>
            </div>
            
            {transaction.description && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Description</span>
                <span className="font-medium text-right max-w-[60%]">
                  {transaction.description}
                </span>
              </div>
            )}
            
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Date & Time</span>
              <span className="font-medium text-right">
                {formatDate(transaction.created_at)}
              </span>
            </div>
            
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Reference</span>
              <span className="font-mono font-medium">
                {formatReceiptId(transaction.id)}
              </span>
            </div>
          </div>

          {/* Footer */}
          <div className="pt-4 border-t border-dashed border-gray-300 text-center">
            <p className="text-xs text-gray-400">
              Powered by Welile
            </p>
            <p className="text-xs text-gray-400">
              Thank you for using our service
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 pt-2">
          <Button onClick={handleDownload} className="flex-1 gap-2">
            <Download className="h-4 w-4" />
            Download
          </Button>
          <Button onClick={handleShare} variant="outline" className="flex-1 gap-2">
            <Share2 className="h-4 w-4" />
            Share
          </Button>
        </div>
        <Button
          onClick={() => {
            const text = buildReceiptText({
              type: isSent ? 'sent' : 'received',
              amount: transaction.amount,
              recipientOrSender: isSent ? transaction.recipient_name : transaction.sender_name,
              reference: formatReceiptId(transaction.id),
              date: formatDate(transaction.created_at),
              description: transaction.description || undefined,
              status: 'Successful',
            });
            shareViaWhatsApp(text);
            toast.success('Opening WhatsApp...');
          }}
          variant="outline"
          className="w-full gap-2 border-emerald-500/30 text-emerald-600 hover:bg-emerald-500/10"
        >
          <MessageCircle className="h-4 w-4" />
          Share on WhatsApp
        </Button>
      </DialogContent>
    </Dialog>
  );
}
