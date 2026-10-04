import { useState, useEffect, forwardRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Download, Printer, CheckCircle2, FileText, Home, Banknote, Shield, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { useProfile } from '@/hooks/useProfile';
import { LANDLORD_AGREEMENT_TEXT, LANDLORD_AGREEMENT_VERSION } from './LandlordAgreementContent';

interface LandlordAgreementModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAccept: () => Promise<boolean>;
  isAccepting?: boolean;
  viewOnly?: boolean;
}

const LandlordAgreementModal = forwardRef<HTMLDivElement, LandlordAgreementModalProps>(
  ({ isOpen, onClose, onAccept, isAccepting = false, viewOnly = false }, ref) => {
    const { profile } = useProfile();
    const [hasScrolledToBottom, setHasScrolledToBottom] = useState(false);
    const [isAgreed, setIsAgreed] = useState(false);

    useEffect(() => {
      if (isOpen) {
        setHasScrolledToBottom(false);
        setIsAgreed(false);
      }
    }, [isOpen]);

    const getFormattedAgreement = () => {
      let text = LANDLORD_AGREEMENT_TEXT;
      const namePhone = profile?.full_name || profile?.phone || 'Landlord';
      text = text.replace('[Full Name / Phone]', namePhone);
      text = text.replace('[Auto-fill]', new Date().toLocaleDateString('en-UG', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      }));
      return text;
    };

    const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
      const element = e.currentTarget;
      const scrolledToBottom = element.scrollHeight - element.scrollTop <= element.clientHeight + 50;
      if (scrolledToBottom && !hasScrolledToBottom) {
        setHasScrolledToBottom(true);
      }
    };

    const handleDownloadPDF = () => {
      const blob = new Blob([getFormattedAgreement()], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Welile_Landlord_Agreement_${LANDLORD_AGREEMENT_VERSION}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };

    const handlePrint = () => {
      const printWindow = window.open('', '_blank');
      if (printWindow) {
        printWindow.document.write(`
          <html>
            <head>
              <title>Welile Landlord Agreement</title>
              <style>
                body { font-family: monospace; padding: 40px; line-height: 1.6; white-space: pre-wrap; }
              </style>
            </head>
            <body>${getFormattedAgreement()}</body>
          </html>
        `);
        printWindow.document.close();
        printWindow.print();
      }
    };

    const handleAccept = async () => {
      const success = await onAccept();
      if (success) {
        onClose();
      }
    };

    const canAccept = hasScrolledToBottom && isAgreed && !isAccepting;

    if (!isOpen) return null;

    return (
      <AnimatePresence>
        {isOpen && (
          <motion.div
            ref={ref}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="relative w-full max-w-2xl max-h-[90vh] bg-background rounded-2xl shadow-2xl overflow-hidden flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between p-4 border-b bg-gradient-to-r from-primary/10 to-success/10">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-xl bg-primary/20">
                    <Home className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h2 className="font-bold text-lg">Landlord Terms & Benefits</h2>
                    <div className="flex items-center gap-2 mt-0.5">
                      <Badge variant="secondary" className="text-xs">
                        {LANDLORD_AGREEMENT_VERSION}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {new Date().toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                </div>
                <Button variant="ghost" size="icon" onClick={onClose} className="rounded-full">
                  <X className="h-5 w-5" />
                </Button>
              </div>

              {/* Benefits Highlights */}
              <div className="p-4 bg-success/5 border-b">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div className="flex items-center gap-2 text-xs">
                    <Banknote className="h-4 w-4 text-success" />
                    <span>1 Month Upfront</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <Shield className="h-4 w-4 text-primary" />
                    <span>10% Fee Only</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <Users className="h-4 w-4 text-warning" />
                    <span>Tenant Management</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <Home className="h-4 w-4 text-secondary-foreground" />
                    <span>Reduced Vacancy</span>
                  </div>
                </div>
              </div>

              {/* Scrollable Content */}
              <div
                className="flex-1 overflow-y-auto p-4"
                onScroll={handleScroll}
              >
                <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed text-foreground/90">
                  {getFormattedAgreement()}
                </pre>
              </div>

              {/* Scroll Indicator */}
              {!hasScrolledToBottom && !viewOnly && (
                <div className="absolute bottom-32 left-0 right-0 flex justify-center pointer-events-none">
                  <Badge variant="secondary" className="animate-bounce shadow-lg">
                    ↓ Scroll to read all terms
                  </Badge>
                </div>
              )}

              {/* Footer */}
              <div className="p-4 border-t bg-muted/30 space-y-3">
                {/* Action Buttons */}
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={handleDownloadPDF} className="flex-1">
                    <Download className="h-4 w-4 mr-2" />
                    Download
                  </Button>
                  <Button variant="outline" size="sm" onClick={handlePrint} className="flex-1">
                    <Printer className="h-4 w-4 mr-2" />
                    Print
                  </Button>
                </div>

                {/* Agreement Checkbox & Accept Button */}
                {!viewOnly ? (
                  <>
                    <label className="flex items-start gap-3 p-3 rounded-lg bg-background border">
                      <Checkbox
                        checked={isAgreed}
                        onCheckedChange={(checked) => setIsAgreed(checked === true)}
                        disabled={!hasScrolledToBottom}
                        className="mt-0.5"
                      />
                      <span className="text-sm leading-relaxed">
                        I have read and understood the Landlord Terms &amp; Benefits.
                      </span>
                    </label>

                    <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
                      <p className="font-semibold">A signed agreement is required</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Reading these terms is not the agreement itself. The signed 12-month Landlord Rent Agreement
                        must be completed with your Welile agent and uploaded before verification can be completed.
                      </p>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center justify-center gap-2 p-3 rounded-lg bg-success/10 text-success">
                    <CheckCircle2 className="h-5 w-5" />
                    <span className="font-medium">Signed agreement on file</span>
                  </div>
                )}

              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    );
  }
);

LandlordAgreementModal.displayName = 'LandlordAgreementModal';

export default LandlordAgreementModal;
