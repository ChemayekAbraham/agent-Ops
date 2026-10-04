import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Download, Printer, CheckCircle2, Loader2 } from 'lucide-react';
import { ANGEL_POOL_AGREEMENT_TEXT, ANGEL_POOL_AGREEMENT_VERSION } from '@/components/angel-pool/agreement/AngelPoolAgreementContent';
import { useProfile } from '@/hooks/useProfile';
import { useAngelPoolAgreement } from '@/hooks/useAngelPoolAgreement';
import { toast } from 'sonner';

export default function AngelPoolAgreement() {
  const navigate = useNavigate();
  const { profile } = useProfile();
  const { isAccepted, isLoading, acceptAgreement } = useAngelPoolAgreement();

  const getFormattedAgreement = () => {
    let text = ANGEL_POOL_AGREEMENT_TEXT;
    const name = profile?.full_name || profile?.phone || 'Participant';
    const date = new Date().toLocaleDateString();
    text = text.replace('[Participant Name]', name);
    text = text.split('[Date]').join(date);
    return text;
  };

  const handleDownload = () => {
    const blob = new Blob([getFormattedAgreement()], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Welile_Angel_Pool_Agreement_${ANGEL_POOL_AGREEMENT_VERSION}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handlePrint = () => {
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(`<html><head><title>Welile Angel Pool Agreement</title><style>body{font-family:monospace;padding:40px;line-height:1.6;white-space:pre-wrap;}</style></head><body>${getFormattedAgreement()}</body></html>`);
    w.document.close();
    w.print();
  };

  const handleAccept = async () => {
    const ok = await acceptAgreement();
    if (ok) toast.success('Angel Pool Agreement accepted!');
    else toast.error('Failed to accept. Please try again.');
  };

  return (
    <div className="min-h-screen bg-background safe-area-top safe-area-bottom">
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b border-border px-4 py-3">
        <div className="flex items-center gap-3 max-w-2xl mx-auto">
          <Button variant="ghost" size="icon-sm" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex-1">
            <h1 className="font-bold text-base">Angel Pool Agreement</h1>
            <Badge variant="secondary" className="text-[10px] mt-0.5">{ANGEL_POOL_AGREEMENT_VERSION}</Badge>
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

      <div className="fixed bottom-0 inset-x-0 bg-background/95 backdrop-blur-sm border-t border-border p-4 safe-area-bottom z-10">
        <div className="max-w-2xl mx-auto">
          {isAccepted ? (
            <div className="flex items-center justify-center gap-2 py-3 rounded-xl bg-success/10 border border-success/30">
              <CheckCircle2 className="h-5 w-5 text-success" />
              <span className="font-semibold text-success text-sm">Agreement Accepted</span>
            </div>
          ) : (
            <Button onClick={handleAccept} disabled={isLoading} className="w-full h-12 text-base font-bold rounded-xl">
              {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : "I Agree — Accept & Sign"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
