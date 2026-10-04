import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Download, Printer, FileCheck, ScrollText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { format } from 'date-fns';
import { AGENT_AGREEMENT_TEXT, AGENT_AGREEMENT_VERSION } from './AgentAgreementContent';
import { useProfile } from '@/hooks/useProfile';

interface AgentAgreementModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAccept: () => Promise<boolean>;
  isAccepting?: boolean;
  viewOnly?: boolean;
}

export default function AgentAgreementModal({
  isOpen,
  onClose,
  onAccept,
  isAccepting = false,
  viewOnly = false
}: AgentAgreementModalProps) {
  const [isAgreed, setIsAgreed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { profile } = useProfile();

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setIsAgreed(false);
    }
  }, [isOpen]);

  const handleAccept = async () => {
    const success = await onAccept();
    if (success) {
      onClose();
    }
  };

  const getFormattedAgreement = () => {
    const agentName = profile?.full_name || 'Agent';
    const agentPhone = profile?.phone || '';
    const today = format(new Date(), 'MMMM d, yyyy');
    
    return AGENT_AGREEMENT_TEXT
      .replace('[Agent Name / Phone]', `${agentName} / ${agentPhone}`)
      .replace('[Auto-filled Date]', today);
  };

  const handleDownloadPDF = () => {
    const content = getFormattedAgreement();
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `welile-agent-agreement-${AGENT_AGREEMENT_VERSION}.txt`;
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
            <title>Welile Agent Agreement</title>
            <style>
              body { font-family: system-ui, sans-serif; padding: 40px; line-height: 1.6; max-width: 800px; margin: 0 auto; }
              h1 { color: #1a1a1a; border-bottom: 2px solid #10b981; padding-bottom: 10px; }
              pre { white-space: pre-wrap; font-family: inherit; }
            </style>
          </head>
          <body>
            <h1>Welile Agent Agreement</h1>
            <pre>${content}</pre>
          </body>
        </html>
      `);
      printWindow.document.close();
      printWindow.print();
    }
  };

  const canAccept = isAgreed;

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="relative w-full max-w-2xl max-h-[90vh] bg-card rounded-2xl shadow-2xl overflow-hidden flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b bg-gradient-to-r from-primary/10 to-primary/5">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-primary/10">
                <ScrollText className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h2 className="font-bold text-lg">Agent Terms & Conditions</h2>
                <p className="text-xs text-muted-foreground">Version {AGENT_AGREEMENT_VERSION}</p>
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} className="rounded-full">
              <X className="h-5 w-5" />
            </Button>
          </div>

          {/* Scrollable content */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto p-4 text-sm leading-relaxed"
          >
            <pre className="whitespace-pre-wrap font-sans text-foreground/90">
              {getFormattedAgreement()}
            </pre>
          </div>

          {/* Footer */}
          <div className="p-4 border-t bg-muted/30 space-y-3">
            {/* Action buttons */}
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownloadPDF}
                className="flex-1 gap-2"
              >
                <Download className="h-4 w-4" />
                Download
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handlePrint}
                className="flex-1 gap-2"
              >
                <Printer className="h-4 w-4" />
                Print
              </Button>
            </div>

            {!viewOnly ? (
              <>
                {/* Checkbox */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setIsAgreed(!isAgreed)}
                  onKeyDown={(e) => e.key === ' ' && setIsAgreed(!isAgreed)}
                  className="flex items-start gap-3 p-3 rounded-lg bg-background border cursor-pointer hover:bg-muted/50 transition-colors"
                >
                  <Checkbox
                    checked={isAgreed}
                    onCheckedChange={(checked) => setIsAgreed(checked === true)}
                    className="mt-0.5 h-5 w-5"
                  />
                  <span className="text-sm select-none">
                    I have read, understood, and agree to the Agent Terms & Conditions. I confirm I am an independent platform partner, not an employee.
                  </span>
                </div>

                {/* Accept button */}
                <Button
                  onClick={handleAccept}
                  disabled={!canAccept || isAccepting}
                  className="w-full h-12 gap-2 text-base font-semibold"
                >
                  {isAccepting ? (
                    <div className="w-5 h-5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                  ) : (
                    <>
                      <FileCheck className="h-5 w-5" />
                      I Agree
                    </>
                  )}
                </Button>
              </>
            ) : (
              <div className="flex items-center justify-center gap-2 p-3 rounded-lg bg-green-500/10 text-green-600 dark:text-green-400">
                <FileCheck className="h-5 w-5" />
                <span className="font-medium">You have accepted these terms</span>
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
