import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Download, Loader2 } from 'lucide-react';
import { MERCHANT_AGREEMENT_VERSION } from '@/components/merchant/agreement/MerchantAgreementContent';
import { buildMerchantAgreementHtml } from '@/components/merchant/agreement/merchantAgreementTemplate';
import { downloadMerchantAgreementPdf } from '@/components/merchant/agreement/merchantAgreementPdf';
import { useProfile } from '@/hooks/useProfile';

export default function MerchantAgreementPage() {
  const navigate = useNavigate();
  const { profile } = useProfile();
  const [downloading, setDownloading] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const merchantName = profile?.full_name || profile?.phone || 'Merchant Agent';
  const html = useMemo(
    () => buildMerchantAgreementHtml({
      merchantName,
      merchantPhone: profile?.phone,
      agreementDate: new Date(),
    }),
    [merchantName, profile?.phone],
  );

  const handleDownload = async () => {
    setDownloading(true);
    try {
      await downloadMerchantAgreementPdf({ name: profile?.full_name, phone: profile?.phone });
    } finally {
      setDownloading(false);
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
            <h1 className="font-bold text-base">Merchant Agent Agreement</h1>
            <Badge variant="secondary" className="text-[10px] mt-0.5">
              {MERCHANT_AGREEMENT_VERSION}
            </Badge>
          </div>
          <div className="flex gap-1">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={handleDownload} disabled={downloading}>
              {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              PDF
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto p-4">
        <Card className="border-border/50 rounded-2xl overflow-hidden">
          <CardContent className="p-0">
            <iframe
              ref={iframeRef}
              title="Welile Merchant Agent Agreement"
              srcDoc={html}
              className="w-full block border-0 bg-[#f1f5f9]"
              style={{ height: '85vh' }}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}