import { useState, useRef, useEffect, forwardRef } from 'react';
import { X, Download, Printer, FileText, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { TENANT_AGREEMENT_TEXT, TENANT_AGREEMENT_VERSION } from './TenantAgreementContent';
import { useProfile } from '@/hooks/useProfile';
import { format } from 'date-fns';

interface TenantAgreementModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAccept: () => Promise<boolean>;
  isAccepting?: boolean;
  viewOnly?: boolean;
}

const TenantAgreementModal = forwardRef<HTMLDivElement, TenantAgreementModalProps>(({
  isOpen,
  onClose,
  onAccept,
  isAccepting = false,
  viewOnly = false
}, ref) => {
  const [hasScrolledToBottom, setHasScrolledToBottom] = useState(viewOnly);
  const [isAgreed, setIsAgreed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { profile } = useProfile();

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen && !viewOnly) {
      setHasScrolledToBottom(false);
      setIsAgreed(false);
    }
  }, [isOpen, viewOnly]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement;
    const isAtBottom = target.scrollHeight - target.scrollTop <= target.clientHeight + 50;
    if (isAtBottom && !hasScrolledToBottom) {
      setHasScrolledToBottom(true);
    }
  };

  const handleAccept = async () => {
    const success = await onAccept();
    if (success) {
      onClose();
    }
  };

  const getFormattedAgreement = () => {
    const today = format(new Date(), 'dd MMMM yyyy');
    const userName = profile?.full_name || 'Tenant';
    const userPhone = profile?.phone || '';
    
    return TENANT_AGREEMENT_TEXT
      .replace('[Full Name / Phone]', `${userName} / ${userPhone}`)
      .replace('[Auto-fill]', today);
  };

  const handleDownloadPDF = () => {
    // Create a simple text-based download
    const content = getFormattedAgreement();
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Welile_Tenant_Agreement_${TENANT_AGREEMENT_VERSION}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handlePrint = () => {
    const content = getFormattedAgreement();
    const printWindow = window.open('', '_blank');
    if (printWindow) {
      printWindow.document.write(`
        <html>
          <head>
            <title>Welile Tenant Agreement</title>
            <style>
              body { font-family: Arial, sans-serif; padding: 40px; line-height: 1.6; }
              pre { white-space: pre-wrap; font-family: inherit; }
            </style>
          </head>
          <body>
            <pre>${content}</pre>
          </body>
        </html>
      `);
      printWindow.document.close();
      printWindow.print();
    }
  };

  const canAccept = hasScrolledToBottom && isAgreed && !isAccepting;

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] animate-fade-in"
      />

      {/* Modal */}
      <div
        ref={ref}
        className="fixed inset-x-0 bottom-0 z-[101] max-h-[90vh] bg-card rounded-t-3xl shadow-2xl flex flex-col md:inset-x-auto md:left-1/2 md:-translate-x-1/2 md:bottom-auto md:top-1/2 md:-translate-y-1/2 md:max-w-lg md:rounded-2xl md:max-h-[85vh] animate-fade-in-up"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            <h2 className="font-bold text-lg">Welile Tenant Agreement</h2>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* Version badge */}
        <div className="px-4 py-2 bg-muted/50 border-b border-border shrink-0">
          <span className="text-xs text-muted-foreground">
            Version {TENANT_AGREEMENT_VERSION} • {format(new Date(), 'dd MMM yyyy')}
          </span>
        </div>

        {/* Agreement Content */}
        <ScrollArea className="flex-1 min-h-0">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="p-4 text-sm leading-relaxed whitespace-pre-wrap h-[300px] md:h-[350px] overflow-auto"
          >
            {getFormattedAgreement()}
          </div>
        </ScrollArea>

        {/* Scroll indicator */}
        {!viewOnly && !hasScrolledToBottom && (
          <div className="px-4 py-2 bg-amber-500/10 border-t border-amber-500/20 text-center shrink-0">
            <span className="text-xs text-amber-600 dark:text-amber-400">
              ↓ Scroll down to read the full agreement
            </span>
          </div>
        )}

        {/* Action buttons */}
        <div className="p-4 border-t border-border space-y-3 shrink-0">
          {/* Download and Print */}
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={handleDownloadPDF}
            >
              <Download className="h-4 w-4 mr-2" />
              Download
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={handlePrint}
            >
              <Printer className="h-4 w-4 mr-2" />
              Print
            </Button>
          </div>

          {/* Acceptance controls - only show if not view only */}
          {!viewOnly && (
            <>
              <div
                role="button"
                tabIndex={0}
                onClick={() => hasScrolledToBottom && setIsAgreed(!isAgreed)}
                onKeyDown={(e) => e.key === ' ' && hasScrolledToBottom && setIsAgreed(!isAgreed)}
                className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  hasScrolledToBottom
                    ? 'bg-background hover:bg-muted/50 border-border'
                    : 'bg-muted/30 border-border/50 cursor-not-allowed'
                }`}
              >
                <Checkbox
                  checked={isAgreed}
                  onCheckedChange={(checked) => setIsAgreed(checked === true)}
                  disabled={!hasScrolledToBottom}
                  className="mt-0.5 h-5 w-5"
                />
                <span className={`text-sm select-none ${!hasScrolledToBottom ? 'text-muted-foreground' : ''}`}>
                  I have read, understood, and agree to the Welile Tenant Terms & Conditions. I accept full responsibility for my rent obligations.
                </span>
              </div>

              <Button
                onClick={handleAccept}
                disabled={!canAccept}
                className="w-full"
                size="lg"
              >
                {isAccepting ? (
                  <>
                    <span className="animate-spin mr-2">⏳</span>
                    Processing...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-5 w-5 mr-2" />
                    Accept & Continue
                  </>
                )}
              </Button>
            </>
          )}

          {viewOnly && (
            <div className="flex items-center justify-center gap-2 text-green-600 dark:text-green-400">
              <CheckCircle2 className="h-5 w-5" />
              <span className="text-sm font-medium">Agreement Accepted</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
});

TenantAgreementModal.displayName = 'TenantAgreementModal';

export default TenantAgreementModal;
