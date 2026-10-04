import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Download, Printer, CheckCircle2, Loader2 } from 'lucide-react';
import { AGENT_AGREEMENT_TEXT, AGENT_AGREEMENT_VERSION } from '@/components/agent/agreement/AgentAgreementContent';
import { useProfile } from '@/hooks/useProfile';
import { useAgentAgreement } from '@/hooks/useAgentAgreement';
import { toast } from 'sonner';

export default function AgentAgreementPage() {
  const navigate = useNavigate();
  const { profile } = useProfile();
  const { isAccepted, isLoading, acceptAgreement } = useAgentAgreement();

  const getFormattedAgreement = () => {
    let text = AGENT_AGREEMENT_TEXT;
    const namePhone = profile?.full_name || profile?.phone || 'Agent';
    text = text.replace('[Agent Name / Phone]', namePhone);
    text = text.replace('[Auto-filled Date]', new Date().toLocaleDateString());
    return text;
  };

  const handleDownload = () => {
    const blob = new Blob([getFormattedAgreement()], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Welile_Agent_Agreement_${AGENT_AGREEMENT_VERSION}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handlePrint = () => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    printWindow.document.write(`
      <html>
        <head>
          <title>Welile Agent Agreement</title>
          <style>body { font-family: monospace; padding: 40px; line-height: 1.6; white-space: pre-wrap; }</style>
        </head>
        <body>${getFormattedAgreement()}</body>
      </html>
    `);
    printWindow.document.close();
    printWindow.print();
  };

  const handleAccept = async () => {
    const success = await acceptAgreement();
    if (success) {
      toast.success('Agreement accepted successfully!');
    } else {
      toast.error('Failed to accept agreement. Please try again.');
    }
  };

  return (
    <div className="min-h-screen bg-background safe-area-top safe-area-bottom">
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b border-border px-4 py-3">
        <div className="flex items-center gap-3 max-w-2xl mx-auto">
          <Button variant="ghost" size="icon-sm" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex-1">
            <h1 className="font-bold text-base">Agent Agreement</h1>
            <Badge variant="secondary" className="text-[10px] mt-0.5">{AGENT_AGREEMENT_VERSION}</Badge>
          </div>
          <div className="flex gap-1">
            <Button variant="outline" size="icon-sm" onClick={handleDownload}>
              <Download className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="icon-sm" onClick={handlePrint}>
              <Printer className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-2xl mx-auto p-4 pb-32">
        <Card className="border-border/50 rounded-2xl">
          <CardContent className="p-4 sm:p-6">
            <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed text-foreground/90">
              {getFormattedAgreement()}
            </pre>
          </CardContent>
        </Card>
      </div>

      {/* Sticky Accept Footer */}
      <div className="fixed bottom-0 inset-x-0 bg-background/95 backdrop-blur-sm border-t border-border p-4 safe-area-bottom z-10">
        <div className="max-w-2xl mx-auto">
          {isAccepted ? (
            <div className="flex items-center justify-center gap-2 py-3 rounded-xl bg-success/10 border border-success/30">
              <CheckCircle2 className="h-5 w-5 text-success" />
              <span className="font-semibold text-success text-sm">Agreement Accepted</span>
            </div>
          ) : (
            <Button
              onClick={handleAccept}
              disabled={isLoading}
              className="w-full h-12 text-base font-bold rounded-xl"
            >
              {isLoading ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                'I Agree to the Terms & Conditions'
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
