import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { 
  Shield, CheckCircle2, FileText, Clock, Eye, 
  AlertTriangle, Loader2, FileCheck, ScrollText
} from 'lucide-react';
import { format } from 'date-fns';
import { motion } from 'framer-motion';
import { SupporterAgreementModal } from './SupporterAgreementModal';

interface SupporterAgreementCardProps {
  hasAccepted: boolean;
  acceptedAt?: string | null;
  onReviewClick: () => void;
  loading?: boolean;
}

export function SupporterAgreementCard({ 
  hasAccepted, 
  acceptedAt, 
  onReviewClick,
  loading = false
}: SupporterAgreementCardProps) {
  const [showViewModal, setShowViewModal] = useState(false);
  const [viewModalTab, setViewModalTab] = useState<'summary' | 'full'>('summary');

  if (loading) {
    return (
      <Card className="border-0 bg-muted/30">
        <CardContent className="p-6 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (hasAccepted) {
    return (
      <>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <Card className="border-0 bg-gradient-to-r from-success/10 via-success/5 to-emerald-500/10">
            <CardContent className="p-4">
              <div className="flex flex-col gap-3">
                {/* Header Row */}
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="p-2 rounded-xl bg-success/20 shrink-0">
                      <CheckCircle2 className="h-5 w-5 text-success" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h4 className="font-bold text-foreground text-sm">
                          Supporter Agreement
                        </h4>
                        <Badge className="bg-success/20 text-success border-success/30 text-[10px] px-1.5">
                          Accepted ✅
                        </Badge>
                        <Badge variant="outline" className="text-[10px] px-1.5">
                          v1.0
                        </Badge>
                      </div>
                      <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        <span>
                          {acceptedAt 
                            ? format(new Date(acceptedAt), 'MMM d, yyyy • h:mm a')
                            : 'Accepted'}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Quick Access Buttons */}
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setViewModalTab('summary'); setShowViewModal(true); }}
                    className="gap-1.5 text-xs h-8 bg-background/50 hover:bg-background"
                  >
                    <ScrollText className="h-3.5 w-3.5" />
                    Quick Summary
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setViewModalTab('full'); setShowViewModal(true); }}
                    className="gap-1.5 text-xs h-8 bg-background/50 hover:bg-background"
                  >
                    <FileCheck className="h-3.5 w-3.5" />
                    Full Agreement
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onReviewClick}
                    className="gap-1.5 text-xs h-8 text-muted-foreground hover:text-foreground ml-auto"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    View Details
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* View-only Modal for reviewing the agreement */}
        <SupporterAgreementViewModal
          open={showViewModal}
          onOpenChange={setShowViewModal}
          defaultTab={viewModalTab}
        />
      </>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <Card className="border-2 border-warning/50 bg-gradient-to-r from-warning/10 via-warning/5 to-orange-500/10 shadow-lg shadow-warning/10">
        <CardContent className="p-4 sm:p-5">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="flex items-start sm:items-center gap-3 flex-1 min-w-0">
              <div className="p-2.5 sm:p-3 rounded-xl bg-warning/20 shrink-0">
                <Shield className="h-5 w-5 sm:h-6 sm:w-6 text-warning" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <h4 className="font-bold text-foreground text-sm sm:text-base">
                    Supporter Participation Agreement
                  </h4>
                  <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                    Required
                  </Badge>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                  <span className="flex items-center gap-1">
                    <FileText className="h-3 w-3" />
                    12 Months
                  </span>
                  <span>•</span>
                  <span>v1.0</span>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Accept to unlock tenant support features
                </p>
              </div>
            </div>
            
            <Button
              onClick={onReviewClick}
              className="w-full sm:w-auto gap-2 bg-warning hover:bg-warning/90 text-warning-foreground font-bold shadow-lg shadow-warning/25"
            >
              <FileText className="h-4 w-4" />
              Review & Accept
            </Button>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

// View-only modal for supporters who have already accepted
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Download, Printer } from 'lucide-react';
import { QUICK_SUMMARY_CONTENT, FULL_AGREEMENT_CONTENT } from './AgreementContent';

interface SupporterAgreementViewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: 'summary' | 'full';
}

export function SupporterAgreementViewModal({ open, onOpenChange, defaultTab = 'summary' }: SupporterAgreementViewModalProps) {
  const [activeTab, setActiveTab] = useState<string>(defaultTab);
  const effectiveDate = format(new Date(), 'MMMM d, yyyy');

  // Reset tab when modal opens with new defaultTab
  useEffect(() => {
    if (open) {
      setActiveTab(defaultTab);
    }
  }, [open, defaultTab]);

  const handleDownloadPDF = () => {
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
      <DialogContent className="max-w-2xl h-[85vh] max-h-[750px] flex flex-col p-0 gap-0 overflow-hidden">
        {/* Header */}
        <DialogHeader className="px-4 sm:px-6 pt-5 pb-4 border-b border-border shrink-0">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-xl bg-success/10 shrink-0">
              <CheckCircle2 className="h-5 w-5 text-success" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle className="text-base sm:text-lg font-bold">
                  Supporter Participation Agreement
                </DialogTitle>
                <Badge className="bg-success/20 text-success border-success/30 text-[10px] px-2">
                  Accepted ✅
                </Badge>
              </div>
              <DialogDescription className="mt-1 text-xs sm:text-sm">
                12-Month Contract • Version v1.0
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Tabs */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
            <div className="px-4 sm:px-6 pt-4 shrink-0">
              <TabsList className="w-full grid grid-cols-2">
                <TabsTrigger value="summary" className="gap-1.5 text-xs sm:text-sm">
                  <ScrollText className="h-3.5 w-3.5" />
                  Quick Summary
                </TabsTrigger>
                <TabsTrigger value="full" className="gap-1.5 text-xs sm:text-sm">
                  <FileCheck className="h-3.5 w-3.5" />
                  Full Agreement
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="summary" className="flex-1 min-h-0 mt-0 px-4 sm:px-6 data-[state=inactive]:hidden">
              <ScrollArea className="h-full pr-4 py-4">
                <div className="prose prose-sm max-w-none">
                  <div className="text-center mb-6 pb-4 border-b border-border">
                    <h3 className="text-lg font-bold text-foreground mb-1">
                      WELILE TENANT SUPPORTER AGREEMENT
                    </h3>
                    <p className="text-sm text-muted-foreground">Quick Summary (12 Months)</p>
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

            <TabsContent value="full" className="flex-1 min-h-0 mt-0 px-4 sm:px-6 data-[state=inactive]:hidden">
              <ScrollArea className="h-full pr-4 py-4">
                <div className="prose prose-sm max-w-none">
                  <div className="text-center mb-6 pb-4 border-b border-border">
                    <h3 className="text-lg font-bold text-foreground mb-1">
                      WELILE TENANT SUPPORTER TERMS & CONDITIONS
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      12-Month Supporter Participation Agreement
                    </p>
                  </div>
                  <div className="whitespace-pre-wrap text-sm text-foreground/90 leading-relaxed">
                    {FULL_AGREEMENT_CONTENT.split('\n\n').slice(1).map((section, idx) => (
                      <div key={idx} className="mb-4">
                        {section.split('\n').map((line, lineIdx) => {
                          if (line.match(/^\d+\./)) {
                            return (
                              <h4 key={lineIdx} className="font-bold text-foreground mt-6 mb-3 text-base border-b border-border/50 pb-2">
                                {line}
                              </h4>
                            );
                          }
                          if (line.match(/^\d+\.\d+/)) {
                            return (
                              <p key={lineIdx} className="font-semibold text-foreground mt-3 mb-1">
                                {line}
                              </p>
                            );
                          }
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
                </div>
              </ScrollArea>
            </TabsContent>
          </Tabs>
        </div>

        {/* Footer Actions */}
        <div className="shrink-0 border-t border-border bg-muted/30 p-4 flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleDownloadPDF}
            className="gap-1.5 text-xs"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handlePrint}
            className="gap-1.5 text-xs"
          >
            <Printer className="h-3.5 w-3.5" />
            Print
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="ml-auto"
          >
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
