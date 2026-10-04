import { useState, useEffect, useCallback } from 'react';
import QRCode from 'qrcode';
import jsPDF from 'jspdf';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Loader2, CreditCard, ShieldCheck, FileDown, FileJson, CheckCircle2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import welileCardImage from '@/assets/welile-card.png';

interface NfcCardSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Step = 'loading' | 'existing' | 'form' | 'submitting' | 'success';

interface CardPayload {
  version: number;
  issuer: string;
  card_id: string;
  user_id: string;
  pinless_limit: number;
  issued_at: string;
  hmac_signature: string;
}

interface ExistingCard {
  card_id: string;
  pinless_limit: number;
  status: string;
  created_at: string;
}

export function NfcCardSetupDialog({ open, onOpenChange }: NfcCardSetupDialogProps) {
  const { user } = useAuth();
  const { profile } = useProfile();
  const [step, setStep] = useState<Step>('loading');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinlessLimit, setPinlessLimit] = useState('50000');
  const [card, setCard] = useState<CardPayload | null>(null);
  const [existingCard, setExistingCard] = useState<ExistingCard | null>(null);
  const [deactivating, setDeactivating] = useState(false);

  const holderName = (profile?.full_name || user?.email?.split('@')[0] || 'Card Holder').trim();

  const loadExisting = useCallback(async () => {
    if (!user?.id) return;
    setStep('loading');
    const { data } = await supabase
      .from('nfc_cards')
      .select('card_id, pinless_limit, status, created_at')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) {
      setExistingCard(data as ExistingCard);
      setStep('existing');
    } else {
      setExistingCard(null);
      setStep('form');
    }
  }, [user?.id]);

  useEffect(() => {
    if (open) loadExisting();
  }, [open, loadExisting]);

  const reset = () => {
    setStep('loading');
    setPin('');
    setConfirmPin('');
    setPinlessLimit('50000');
    setCard(null);
    setExistingCard(null);
  };

  const handleClose = (val: boolean) => {
    if (!val) reset();
    onOpenChange(val);
  };

  const handleDeactivate = async () => {
    if (!existingCard || !user?.id) return;
    if (!confirm('Deactivate this card? You will need to set up a new card to use Tap to Pay.')) return;
    setDeactivating(true);
    try {
      const { error } = await supabase
        .from('nfc_cards')
        .update({ status: 'revoked', revoked_at: new Date().toISOString() })
        .eq('card_id', existingCard.card_id)
        .eq('user_id', user.id);
      if (error) throw error;
      toast.success('Card deactivated');
      setExistingCard(null);
      setStep('form');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to deactivate card');
    } finally {
      setDeactivating(false);
    }
  };

  const handleSubmit = async () => {
    if (!/^\d{4,6}$/.test(pin)) {
      toast.error('PIN must be 4 to 6 digits');
      return;
    }
    if (pin !== confirmPin) {
      toast.error('PINs do not match');
      return;
    }
    const limit = Number(pinlessLimit);
    if (!Number.isFinite(limit) || limit < 0) {
      toast.error('Enter a valid pinless limit');
      return;
    }

    setStep('submitting');
    try {
      const { data, error } = await supabase.functions.invoke('setup-nfc-card', {
        body: { pin, pinless_limit: limit },
      });
      if (error) throw error;
      if (!data?.success || !data?.card) throw new Error('Invalid response');
      setCard(data.card as CardPayload);
      setStep('success');
      toast.success('Card configured successfully');
    } catch (e) {
      console.error(e);
      toast.error(e instanceof Error ? e.message : 'Failed to setup card');
      setStep('form');
    }
  };

  const downloadJson = () => {
    if (!card) return;
    const minimal = {
      version: card.version,
      issuer: card.issuer,
      card_id: card.card_id,
      hmac_signature: card.hmac_signature,
    };
    const blob = new Blob([JSON.stringify(minimal, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `welile-card-${card.card_id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadPdf = async () => {
    if (!card) return;
    try {
      const minimal = {
        version: card.version,
        issuer: card.issuer,
        card_id: card.card_id,
        hmac_signature: card.hmac_signature,
      };
      const qrPayload = JSON.stringify(minimal);
      const qrDataUrl = await QRCode.toDataURL(qrPayload, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 600,
      });

      const doc = new jsPDF({ unit: 'mm', format: 'a4' });
      const pageWidth = doc.internal.pageSize.getWidth();

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(20);
      doc.text('Welile NFC Card', pageWidth / 2, 22, { align: 'center' });

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(100);
      doc.text('Scan or write this payload to your physical NFC card', pageWidth / 2, 30, { align: 'center' });

      const qrSize = 90;
      doc.addImage(qrDataUrl, 'PNG', (pageWidth - qrSize) / 2, 40, qrSize, qrSize);

      let y = 145;
      doc.setTextColor(0);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text('Card ID', 20, y);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.text(card.card_id, 20, y + 5);

      y += 14;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text('Pinless Limit', 20, y);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.text(`UGX ${card.pinless_limit.toLocaleString()}`, 20, y + 5);

      y += 14;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text('Issued At', 20, y);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.text(new Date(card.issued_at).toLocaleString(), 20, y + 5);

      y += 14;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text('HMAC Signature', 20, y);
      doc.setFont('courier', 'normal');
      doc.setFontSize(7);
      const sig = card.hmac_signature;
      const sigLines = doc.splitTextToSize(sig, pageWidth - 40);
      doc.text(sigLines, 20, y + 5);

      y += 5 + sigLines.length * 3 + 10;
      doc.setDrawColor(220);
      doc.line(20, y, pageWidth - 20, y);
      y += 6;
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(8);
      doc.setTextColor(120);
      doc.text(
        'Keep this document secure. Anyone with this QR code or signature can write a duplicate card.',
        pageWidth / 2,
        y,
        { align: 'center', maxWidth: pageWidth - 40 }
      );

      doc.save(`welile-card-${card.card_id}.pdf`);
    } catch (e) {
      console.error(e);
      toast.error('Failed to generate PDF');
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-primary" />
            {step === 'existing' ? 'Your Card' : 'Setup NFC Card'}
          </DialogTitle>
          <DialogDescription>
            {step === 'existing'
              ? 'Your contactless card linked to your wallet.'
              : 'Configure a contactless card linked to your wallet.'}
          </DialogDescription>
        </DialogHeader>

        {step === 'loading' && (
          <div className="py-12 flex flex-col items-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Loading your card…</p>
          </div>
        )}

        {step === 'existing' && existingCard && (
          <div className="space-y-4">
            {/* Visual card — uses brand artwork as background */}
            <div className="relative w-full aspect-[1.586/1] rounded-2xl overflow-hidden shadow-xl">
              <img
                src={welileCardImage}
                alt="Welile Card"
                className="absolute inset-0 w-full h-full object-cover"
                draggable={false}
              />
              {/* Card Holder — bottom-left, 27px from left, 20px from bottom, fontsize 16, bold */}
              <div
                className="absolute text-white font-bold text-left"
                style={{ left: 27, bottom: 20, fontSize: 16, lineHeight: 1.2 }}
              >
                {holderName}
              </div>
            </div>

            {/* Status + meta */}
            <Card className="border-border/60">
              <CardContent className="p-3 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Status</span>
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 font-semibold">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    Active
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Account</span>
                  <span className="font-semibold">{holderName}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Pinless Limit</span>
                  <span className="font-semibold">UGX {Number(existingCard.pinless_limit).toLocaleString()}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Card ID</span>
                  <span className="font-mono text-[10px] break-all text-right">{existingCard.card_id}</span>
                </div>
              </CardContent>
            </Card>

            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                className="gap-2 text-destructive hover:text-destructive"
                onClick={handleDeactivate}
                disabled={deactivating}
              >
                {deactivating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Deactivate
              </Button>
              <Button
                className="gap-2"
                onClick={() => setStep('form')}
              >
                <Plus className="h-4 w-4" />
                Add New Card
              </Button>
            </div>

            <Button variant="ghost" className="w-full" onClick={() => handleClose(false)}>
              Close
            </Button>
          </div>
        )}

        {step === 'form' && (
          <div className="space-y-4">
            <Card className="border-primary/20 bg-primary/5">
              <CardContent className="p-3 flex gap-2 text-xs">
                <ShieldCheck className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                <p className="text-muted-foreground">
                  Your PIN is required for transactions above the pinless limit. We never store your PIN — only a hashed version.
                </p>
              </CardContent>
            </Card>

            <div className="space-y-2">
              <Label htmlFor="nfc-pin">Card PIN (4–6 digits)</Label>
              <Input
                id="nfc-pin"
                type="password"
                inputMode="numeric"
                maxLength={6}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                placeholder="••••"
                autoComplete="new-password"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="nfc-pin-confirm">Confirm PIN</Label>
              <Input
                id="nfc-pin-confirm"
                type="password"
                inputMode="numeric"
                maxLength={6}
                value={confirmPin}
                onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ''))}
                placeholder="••••"
                autoComplete="new-password"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="nfc-limit">Pinless Withdrawal Limit (UGX)</Label>
              <Input
                id="nfc-limit"
                type="number"
                min={0}
                step={1000}
                value={pinlessLimit}
                onChange={(e) => setPinlessLimit(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Withdrawals at or below this amount won't require a PIN.
              </p>
            </div>

            <Button onClick={handleSubmit} className="w-full" size="lg">
              Generate Card
            </Button>
          </div>
        )}

        {step === 'submitting' && (
          <div className="py-12 flex flex-col items-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Securing your card…</p>
          </div>
        )}

        {step === 'success' && card && (
          <div className="space-y-4">
            <div className="flex flex-col items-center text-center gap-2 py-2">
              <div className="h-12 w-12 rounded-full bg-success/10 flex items-center justify-center">
                <CheckCircle2 className="h-6 w-6 text-success" />
              </div>
              <h3 className="font-bold text-lg">Card Ready</h3>
              <p className="text-xs text-muted-foreground">
                Download the JSON file to write your physical NFC card, and the PDF for your records.
              </p>
            </div>

            <Card className="border-border/60">
              <CardContent className="p-3 space-y-2 text-xs">
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Card ID</span>
                  <span className="font-mono break-all text-right">{card.card_id}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Pinless Limit</span>
                  <span className="font-semibold">UGX {card.pinless_limit.toLocaleString()}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Signature</span>
                  <span className="font-mono text-[10px] break-all text-right">…{card.hmac_signature.slice(-12)}</span>
                </div>
              </CardContent>
            </Card>

            <div className="grid grid-cols-2 gap-2">
              <Button onClick={downloadJson} variant="outline" className="gap-2">
                <FileJson className="h-4 w-4" />
                JSON
              </Button>
              <Button onClick={downloadPdf} className="gap-2">
                <FileDown className="h-4 w-4" />
                QR PDF
              </Button>
            </div>

            <Button variant="ghost" className="w-full" onClick={() => handleClose(false)}>
              Done
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}