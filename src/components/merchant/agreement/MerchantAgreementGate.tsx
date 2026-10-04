import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ShieldCheck, FileCheck, Loader2, Download, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { useMerchantAgreement } from '@/hooks/useMerchantAgreement';
import { useProfile } from '@/hooks/useProfile';
import { MERCHANT_AGREEMENT_VERSION } from './MerchantAgreementContent';
import { downloadMerchantAgreementPdf } from './merchantAgreementPdf';

/**
 * Mandatory acceptance gate for Merchant (Cash-Out) Agents. Until the agent
 * accepts the current Merchant Agent Agreement, this blocks the payout console
 * and produces the audited acceptance record the CFO reviews.
 */
export function MerchantAgreementGate({ children }: { children: React.ReactNode }) {
  const { isAccepted, isLoading, accepting, acceptAgreement } = useMerchantAgreement();
  const { profile } = useProfile();
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const merchantName = profile?.full_name || profile?.phone || 'Merchant Agent';
  const [downloaded, setDownloaded] = useState(false);
  void merchantName;

  const handleDownload = async () => {
    try {
      await downloadMerchantAgreementPdf({ name: profile?.full_name, phone: profile?.phone });
      setDownloaded(true);
      toast.success('Agreement PDF downloaded — please review before accepting.');
    } catch (err) {
      console.warn('[MerchantAgreementGate] pdf download failed', err);
      toast.error('Could not download the PDF. Please try again.');
    }
  };

  if (isLoading) return null;
  if (isAccepted) return <>{children}</>;

  const handleAccept = async () => {
    const ok = await acceptAgreement();
    if (ok) {
      try {
        await downloadMerchantAgreementPdf({ name: profile?.full_name, phone: profile?.phone });
      } catch (err) {
        console.warn('[MerchantAgreementGate] pdf download failed', err);
      }
      toast.success('Merchant Agent Agreement accepted — payouts unlocked.');
      setOpen(false);
    } else {
      toast.error('Could not record your acceptance. Please try again.');
    }
  };

  return (
    <div className="space-y-4">
      <Card className="border-2 border-primary/40 bg-primary/5 rounded-2xl">
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-bold flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Accept the Merchant Agent Agreement
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            To process user withdrawals as a Merchant (Cash-Out) Agent, you must first
            read and accept the Welile Merchant Agent Agreement. Your acceptance is
            recorded with the date, device and version for compliance.
          </p>
          <Badge variant="secondary" className="text-[10px]">Version {MERCHANT_AGREEMENT_VERSION}</Badge>
          <div className="flex gap-2 pt-1">
            <Button className="flex-1 gap-1.5" onClick={() => setOpen(true)}>
              <FileCheck className="h-4 w-4" /> Review & Accept
            </Button>
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={() => downloadMerchantAgreementPdf({ name: profile?.full_name, phone: profile?.phone })}
            >
              <Download className="h-4 w-4" /> PDF
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Welile Merchant Agent Agreement</DialogTitle>
          </DialogHeader>
          <div className="rounded-lg border border-border bg-muted/40 p-5 space-y-3">
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-lg bg-primary/10 shrink-0">
                <FileText className="h-5 w-5 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-bold">Merchant Agent Agreement ({MERCHANT_AGREEMENT_VERSION})</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Download and read the full PDF on your device before accepting. Your acceptance is
                  recorded with the date, device and version for compliance.
                </p>
              </div>
            </div>
            <Button variant="outline" className="w-full gap-1.5" onClick={handleDownload}>
              <Download className="h-4 w-4" /> {downloaded ? 'Download again' : 'Download Agreement PDF'}
            </Button>
          </div>
          <div className="flex items-start gap-2 pt-1">
            <Checkbox
              id="merchant-agree"
              checked={confirmed}
              onCheckedChange={(v) => setConfirmed(!!v)}
              disabled={!downloaded}
              className="mt-0.5"
            />
            <label htmlFor="merchant-agree" className="text-sm text-foreground cursor-pointer">
              I have downloaded, read, understood and agree to the Welile Merchant Agent Agreement
              ({MERCHANT_AGREEMENT_VERSION}).
            </label>
          </div>
          <Button className="w-full gap-1.5" disabled={!confirmed || accepting} onClick={handleAccept}>
            {accepting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCheck className="h-4 w-4" />}
            I Agree — Become a Merchant Agent
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
