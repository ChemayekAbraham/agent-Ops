import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Download, Printer } from 'lucide-react';
import { LANDLORD_AGREEMENT_TEXT, LANDLORD_AGREEMENT_VERSION } from '@/components/landlord/agreement/LandlordAgreementContent';
import { useProfile } from '@/hooks/useProfile';

export default function LandlordAgreementPage() {
  const navigate = useNavigate();
  const { profile } = useProfile();

  const getFormattedAgreement = () => {
    let text = LANDLORD_AGREEMENT_TEXT;
    const namePhone = profile?.full_name || profile?.phone || 'Landlord';
    text = text.replace('[Full Name / Phone]', namePhone);
    text = text.replace('[Date]', new Date().toLocaleDateString());
    return text;
  };

  const handleDownload = () => {
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
    if (!printWindow) return;
    printWindow.document.write(`
      <html>
        <head>
          <title>Welile Landlord Agreement</title>
          <style>body { font-family: monospace; padding: 40px; line-height: 1.6; white-space: pre-wrap; }</style>
        </head>
        <body>${getFormattedAgreement()}</body>
      </html>
    `);
    printWindow.document.close();
    printWindow.print();
  };

  return (
    <div className="min-h-screen bg-background safe-area-top safe-area-bottom">
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b border-border px-4 py-3">
        <div className="flex items-center gap-3 max-w-2xl mx-auto">
          <Button variant="ghost" size="icon-sm" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex-1">
            <h1 className="font-bold text-base">Landlord Agreement</h1>
            <Badge variant="secondary" className="text-[10px] mt-0.5">{LANDLORD_AGREEMENT_VERSION}</Badge>
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

      <div className="max-w-2xl mx-auto p-4">
        <Card className="border-border/50 rounded-2xl">
          <CardContent className="p-4 sm:p-6">
            <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed text-foreground/90">
              {getFormattedAgreement()}
            </pre>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
