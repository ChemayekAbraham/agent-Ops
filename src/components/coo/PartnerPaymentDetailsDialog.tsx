import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/sonner';
import { Loader2, Save, Wallet, FileText } from 'lucide-react';

interface PortfolioRow {
  id: string;
  portfolio_code: string | null;
  account_name: string | null;
  status: string;
  investment_amount?: number;
  payment_method: 'mobile_money' | 'bank_transfer' | 'cash' | null;
  mobile_network: 'MTN' | 'Airtel' | null;
  mobile_money_number: string | null;
  bank_name: string | null;
  bank_account_name: string | null;
  account_number: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  partnerId: string;
  partnerName: string;
  portfolio: PortfolioRow;
  onSaved?: () => void;
}

export default function PartnerPaymentDetailsDialog({ open, onOpenChange, partnerId, partnerName, portfolio, onSaved }: Props) {
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<'mobile_money' | 'bank_transfer' | 'cash'>('mobile_money');
  const [momoProvider, setMomoProvider] = useState<'MTN' | 'Airtel'>('MTN');
  const [momoNumber, setMomoNumber] = useState('');
  const [momoName, setMomoName] = useState('');
  const [bankName, setBankName] = useState('');
  const [bankAccName, setBankAccName] = useState('');
  const [bankAccNumber, setBankAccNumber] = useState('');
  const [sending, setSending] = useState(false);
  const [previewEmail, setPreviewEmail] = useState('');

  useEffect(() => {
    if (!open || !portfolio) return;
    setMode((portfolio.payment_method as any) || 'mobile_money');
    setMomoProvider((portfolio.mobile_network as any) || 'MTN');
    setMomoNumber(portfolio.mobile_money_number || '');
    setMomoName(portfolio.bank_account_name || '');
    setBankName(portfolio.bank_name || '');
    setBankAccName(portfolio.bank_account_name || '');
    setBankAccNumber(portfolio.account_number || '');
  }, [open, portfolio]);

  const handleSendAgreement = async () => {
    setSending(true);
    try {
      const { data, error } = await supabase.functions.invoke('send-partner-agreement-with-pdf', {
        body: {
          partnerId,
          portfolioId: portfolio.id,
          ...(previewEmail.trim() ? { overrideEmail: previewEmail.trim() } : {}),
        },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success('Agreement sent', {
        description: `${portfolio.portfolio_code || 'Portfolio'} → ${(data as any)?.recipient || previewEmail.trim() || 'partner'}`,
      });
    } catch (e: any) {
      toast.error('Could not send agreement', { description: e.message });
    } finally {
      setSending(false);
    }
  };

  const handleSave = async () => {
    if (mode === 'mobile_money' && !momoNumber.trim()) {
      toast.error('Enter MoMo number'); return;
    }
    if (mode === 'mobile_money' && !momoName.trim()) {
      toast.error('Enter registered recipient name'); return;
    }
    if (mode === 'bank_transfer' && (!bankName.trim() || !bankAccName.trim() || !bankAccNumber.trim())) {
      toast.error('Enter bank name, account name and account number'); return;
    }
    setSaving(true);
    try {
      const updates: any = {
        payment_method: mode,
        mobile_network: mode === 'mobile_money' ? momoProvider : null,
        mobile_money_number: mode === 'mobile_money' ? momoNumber.trim() : null,
        bank_name: mode === 'bank_transfer' ? bankName.trim() : null,
        bank_account_name:
          mode === 'mobile_money'
            ? momoName.trim()
            : mode === 'bank_transfer'
              ? bankAccName.trim()
              : null,
        account_number: mode === 'bank_transfer' ? bankAccNumber.trim() : null,
      };
      const { data: saved, error } = await supabase
        .from('investor_portfolios')
        .update(updates)
        .eq('id', portfolio.id)
        .select('id, payment_method, mobile_network, mobile_money_number, bank_name, bank_account_name, account_number')
        .maybeSingle();
      if (error) throw error;
      if (!saved) throw new Error('Save returned no rows — check permissions');
      toast.success('Portfolio payment route saved', {
        description: portfolio.portfolio_code || portfolio.account_name || 'Portfolio',
      });
      onSaved?.();
      onOpenChange(false);
    } catch (e: any) {
      toast.error('Could not save', { description: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-primary" />
            Payment Route — {portfolio?.portfolio_code || portfolio?.account_name || 'Portfolio'}
          </DialogTitle>
          <DialogDescription>
            Payout details for this portfolio only. Each portfolio under <strong>{partnerName}</strong> can have its own route — no global default.
            <div className="mt-1"><Badge variant="outline" className="text-[10px]">{portfolio?.status}</Badge></div>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 pt-2">
          <div>
            <Label className="text-xs">Type</Label>
            <Select value={mode} onValueChange={(v: any) => setMode(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="mobile_money">📱 Mobile Money</SelectItem>
                <SelectItem value="bank_transfer">🏦 Bank Transfer</SelectItem>
                <SelectItem value="cash">💵 Cash</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {mode === 'mobile_money' && (
            <>
              <div>
                <Label className="text-xs">Provider</Label>
                <Select value={momoProvider} onValueChange={(v: any) => setMomoProvider(v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MTN">MTN</SelectItem>
                    <SelectItem value="Airtel">Airtel</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">MoMo Number</Label>
                <Input value={momoNumber} onChange={e => setMomoNumber(e.target.value)} placeholder="07XXXXXXXX" inputMode="tel" />
              </div>
              <div>
                <Label className="text-xs">Registered Recipient Name</Label>
                <Input value={momoName} onChange={e => setMomoName(e.target.value)} placeholder="Name on the MoMo line" />
                <p className="text-[10px] text-muted-foreground mt-1">
                  Saved as the payout recipient only. Portfolio name stays unchanged.
                </p>
              </div>
            </>
          )}

          {mode === 'bank_transfer' && (
            <>
              <div>
                <Label className="text-xs">Bank Name</Label>
                <Input value={bankName} onChange={e => setBankName(e.target.value)} placeholder="e.g. Stanbic Bank" />
              </div>
              <div>
                <Label className="text-xs">Account Name</Label>
                <Input value={bankAccName} onChange={e => setBankAccName(e.target.value)} />
              </div>
              <div>
                <Label className="text-xs">Account Number</Label>
                <Input value={bankAccNumber} onChange={e => setBankAccNumber(e.target.value)} inputMode="numeric" />
              </div>
            </>
          )}
        </div>

        <div className="rounded-md border border-border p-3 space-y-2">
          <Label className="text-xs flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5 text-primary" />
            Partnership agreement for this portfolio
          </Label>
          <p className="text-[10px] text-muted-foreground">
            Regenerates the signed PDF using this portfolio's own amount, returns rate and code — it never overwrites the partner's other agreements.
          </p>
          <Input
            value={previewEmail}
            onChange={e => setPreviewEmail(e.target.value)}
            placeholder="Preview email (optional) — leave blank to send to the partner"
            inputMode="email"
          />
          <Button variant="secondary" size="sm" onClick={handleSendAgreement} disabled={sending} className="gap-1.5 w-full">
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
            Send agreement
          </Button>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          <Button onClick={handleSave} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save Portfolio Route
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}