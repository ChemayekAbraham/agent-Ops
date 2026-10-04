import { useState, useRef, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  FileText, Download, Printer, CheckCircle2, 
  Shield, Clock, Loader2, FileCheck
} from 'lucide-react';
import { motion } from 'framer-motion';
import { format } from 'date-fns';
import { QUICK_SUMMARY_CONTENT, FULL_AGREEMENT_CONTENT } from './AgreementContent';
import { cn } from '@/lib/utils';
import { hapticSuccess } from '@/lib/haptics';

interface SupporterAgreementModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAccept: () => Promise<boolean>;
  loading?: boolean;
}

export function SupporterAgreementModal({ 
  open, 
  onOpenChange, 
  onAccept,
  loading = false
}: SupporterAgreementModalProps) {
  const [activeTab, setActiveTab] = useState<string>('full');
  const [isAccepting, setIsAccepting] = useState(false);
  const fullAgreementRef = useRef<HTMLDivElement>(null);

  const effectiveDate = format(new Date(), 'MMMM d, yyyy');

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setActiveTab('full');
    }
  }, [open]);

  // Auto-accept when checkbox is checked - no scroll requirement
  const handleCheckboxChange = async (checked: boolean) => {
    if (checked) {
      setIsAccepting(true);
      const success = await onAccept();
      setIsAccepting(false);
      
      if (success) {
        hapticSuccess();
        onOpenChange(false);
      }
    }
  };

  const handleDownloadPDF = () => {
    // Create PDF content
    const content = `
WELILE TENANT SUPPORTER TERMS & CONDITIONS
(12-Month Supporter Participation Agreement)

Effective Date: ${effectiveDate}
Agreement Version: v1.0

${FULL_AGREEMENT_CONTENT}
    `;

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Welile_Supporter_Agreement_v1.0_${format(new Date(), 'yyyy-MM-dd')}.txt`;
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
            <title>Welile Supporter Agreement</title>
            <style>
              body { font-family: Arial, sans-serif; padding: 40px; line-height: 1.6; }
              h1 { font-size: 24px; margin-bottom: 10px; }
              h2 { font-size: 18px; margin-top: 20px; }
              p { margin: 10px 0; }
              .header { border-bottom: 2px solid #333; padding-bottom: 20px; margin-bottom: 20px; }
              .meta { font-size: 14px; color: #666; }
            </style>
          </head>
          <body>
            <div class="header">
              <h1>WELILE TENANT SUPPORTER TERMS & CONDITIONS</h1>
              <p class="meta">12-Month Supporter Participation Agreement</p>
              <p class="meta">Effective Date: ${effectiveDate} | Version: v1.0</p>
            </div>
            <pre style="white-space: pre-wrap; font-family: Arial, sans-serif;">${FULL_AGREEMENT_CONTENT}</pre>
          </body>
        </html>
      `);
      printWindow.document.close();
      printWindow.print();
    }
  };

  

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl h-[95vh] max-h-[900px] flex flex-col p-0 gap-0 overflow-hidden sm:rounded-xl"  >
        {/* Header */}
        <DialogHeader className="px-4 sm:px-6 pt-5 pb-4 border-b border-border shrink-0">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-xl bg-primary/10 shrink-0">
              <Shield className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle className="text-base sm:text-lg font-bold">
                  Supporter Participation Agreement
                </DialogTitle>
                <Badge variant="destructive" className="text-[10px] px-2 py-0.5">
                  Required
                </Badge>
              </div>
              <DialogDescription className="mt-1 text-xs sm:text-sm">
                12-Month Contract • Version v1.0
              </DialogDescription>
              <div className="flex items-center gap-1.5 mt-2 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                <span>Effective Date: {effectiveDate}</span>
              </div>
            </div>
          </div>
        </DialogHeader>

        {/* Tabs */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
            <div className="px-4 sm:px-6 pt-4 shrink-0">
              <TabsList className="w-full grid grid-cols-2">
                <TabsTrigger value="summary" className="gap-1.5 text-xs sm:text-sm">
                  <FileText className="h-3.5 w-3.5" />
                  Quick Summary
                </TabsTrigger>
                <TabsTrigger value="full" className="gap-1.5 text-xs sm:text-sm">
                  <FileCheck className="h-3.5 w-3.5" />
                  Full Agreement
                </TabsTrigger>
              </TabsList>
            </div>

            {/* Tab Content */}
            <TabsContent value="summary" className="flex-1 min-h-0 mt-0 px-4 sm:px-6 data-[state=inactive]:hidden">
              <ScrollArea className="h-full pr-4 py-4">
                <div className="prose prose-sm max-w-none">
                  <div className="text-center mb-6 pb-4 border-b border-border">
                    <h3 className="text-lg font-bold text-foreground mb-1">
                      WELILE TENANT SUPPORTER AGREEMENT
                    </h3>
                    <p className="text-sm text-muted-foreground">Quick Summary (12 Months)</p>
                    <p className="text-xs text-muted-foreground italic mt-2">
                      This is a short summary for easier reading. The Full Agreement is the official binding document.
                    </p>
                  </div>
                  <div className="whitespace-pre-wrap text-sm text-foreground/90 leading-relaxed">
                    {QUICK_SUMMARY_CONTENT.split('\n\n').slice(1).map((section, idx) => (
                      <div key={idx} className="mb-4">
                        {section.split('\n').map((line, lineIdx) => {
                          if (line.match(/^\d+\)/)) {
                            return (
                              <h4 key={lineIdx} className="font-bold text-foreground mt-4 mb-2 flex items-center gap-2">
                                <span className="text-primary">{line.split(')')[0]})</span>
                                <span>{line.split(')').slice(1).join(')')}</span>
                              </h4>
                            );
                          }
                          return <p key={lineIdx} className="text-muted-foreground">{line}</p>;
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              </ScrollArea>
            </TabsContent>

            <TabsContent value="full" className="flex-1 min-h-0 mt-0 px-4 sm:px-6 data-[state=inactive]:hidden relative">
              <div
                ref={fullAgreementRef}
                className="h-full overflow-y-auto pr-4 py-4"
              >
                <div className="prose prose-sm max-w-none">
                  <div className="text-center mb-6 pb-4 border-b border-border">
                    <h3 className="text-lg font-bold text-foreground mb-1">
                      WELILE TENANT SUPPORTER TERMS & CONDITIONS
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      12-Month Supporter Participation Agreement
                    </p>
                    <div className="flex items-center justify-center gap-4 mt-3 text-xs text-muted-foreground">
                      <span>Effective: {effectiveDate}</span>
                      <span>•</span>
                      <span>Duration: 12 Months</span>
                      <span>•</span>
                      <span>v1.0</span>
                    </div>
                  </div>
                  <div className="whitespace-pre-wrap text-sm text-foreground/90 leading-relaxed">
                    {FULL_AGREEMENT_CONTENT.split('\n\n').slice(1).map((section, idx) => (
                      <div key={idx} className="mb-4">
                        {section.split('\n').map((line, lineIdx) => {
                          // Section headers
                          if (line.match(/^\d+\./)) {
                            return (
                              <h4 key={lineIdx} className="font-bold text-foreground mt-6 mb-3 text-base border-b border-border/50 pb-2">
                                {line}
                              </h4>
                            );
                          }
                          // Subsection headers
                          if (line.match(/^\d+\.\d+/)) {
                            return (
                              <p key={lineIdx} className="font-semibold text-foreground mt-3 mb-1">
                                {line}
                              </p>
                            );
                          }
                          // Bullet points
                          if (line.startsWith('•')) {
                            return (
                              <p key={lineIdx} className="text-muted-foreground pl-4 py-0.5">
                                {line}
                              </p>
                            );
                          }
                          return <p key={lineIdx} className="text-muted-foreground">{line}</p>;
                        })}
                      </div>
                    ))}
                  </div>
                  
                  {/* End marker */}
                  <div className="text-center py-8 border-t border-border mt-8">
                    <CheckCircle2 className="h-8 w-8 text-success mx-auto mb-2" />
                    <p className="text-sm font-semibold text-foreground">
                      End of Agreement
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      You have reached the end of the agreement
                    </p>
                  </div>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </div>

        {/* Footer Actions - Simplified with prominent checkbox */}
        <div className="shrink-0 border-t border-border bg-muted/30 p-3 sm:p-4 space-y-3">
          {/* Prominent Accept Checkbox - Main Action */}
          <motion.div 
            className="flex items-start gap-3 p-4 rounded-xl border-2 border-primary/30 bg-primary/5 cursor-pointer hover:bg-primary/10 transition-colors"
            whileTap={{ scale: 0.98 }}
            onClick={() => !isAccepting && !loading && handleCheckboxChange(true)}
          >
            <Checkbox
              id="accept-terms"
              checked={false}
              onCheckedChange={handleCheckboxChange}
              disabled={isAccepting || loading}
              className="mt-0.5 h-5 w-5 border-2 border-primary"
            />
            <div className="flex-1">
              <label
                htmlFor="accept-terms"
                className="text-sm font-medium text-foreground cursor-pointer leading-relaxed block"
              >
                I have read and agree to the <span className="font-bold text-primary">Welile Tenant Supporter Terms & Conditions</span>
              </label>
              <p className="text-xs text-muted-foreground mt-1">
                12-Month Contract • 90-day withdrawal notice • Principal & Outcome Assurance
              </p>
              {isAccepting && (
                <div className="flex items-center gap-2 mt-2 text-primary">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm font-medium">Accepting agreement...</span>
                </div>
              )}
            </div>
            <CheckCircle2 className="h-6 w-6 text-primary/50 shrink-0" />
          </motion.div>

          {/* Secondary Actions */}
          <div className="flex items-center justify-center gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDownloadPDF}
              className="gap-1.5 text-xs text-muted-foreground"
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </Button>
            <span className="text-muted-foreground/30">•</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={handlePrint}
              className="gap-1.5 text-xs text-muted-foreground"
            >
              <Printer className="h-3.5 w-3.5" />
              Print
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
