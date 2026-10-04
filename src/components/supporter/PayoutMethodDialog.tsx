import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Loader2, CreditCard, Phone, Building2, Banknote } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { UGANDA_BANKS, PAYOUT_METHODS } from '@/lib/ugandaBanks';

interface PayoutMethodDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  portfolioId: string;
  portfolioName: string;
}

export function PayoutMethodDialog({ open, onOpenChange, portfolioId, portfolioName }: PayoutMethodDialogProps) {
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [payoutMode, setPayoutMode] = useState<string>('mobile_money');
  const [momoNumber, setMomoNumber] = useState('');
  const [momoNetwork, setMomoNetwork] = useState('MTN');
  const [bankName, setBankName] = useState('');
  const [bankAccountName, setBankAccountName] = useState('');
  const [bankAccountNumber, setBankAccountNumber] = useState('');

  useEffect(() => {
    if (open && portfolioId) {
      setLoading(true);
      supabase.from('investor_portfolios')
        .select('payment_method, mobile_money_number, mobile_network, bank_name, bank_account_name, account_number')
        .eq('id', portfolioId)
        .single()
        .then(({ data }) => {
          if (data) {
            setPayoutMode((data as any).payment_method || 'mobile_money');
            setMomoNumber((data as any).mobile_money_number || '');
            setMomoNetwork((data as any).mobile_network || 'MTN');
            setBankName((data as any).bank_name || '');
            setBankAccountName((data as any).bank_account_name || '');
            setBankAccountNumber((data as any).account_number || '');
          }
          setLoading(false);
        });
    }
  }, [open, portfolioId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const update: Record<string, any> = { payment_method: payoutMode };

      if (payoutMode === 'mobile_money') {
        if (!momoNumber.trim() || momoNumber.trim().length < 9) {
          toast.error('Please enter a valid mobile money number');
          setSaving(false);
          return;
        }
        update.mobile_money_number = momoNumber.trim();
        update.mobile_network = momoNetwork;
        update.bank_name = null;
        update.bank_account_name = null;
        update.account_number = null;
      } else if (payoutMode === 'bank_transfer') {
        if (!bankName || !bankAccountName.trim() || !bankAccountNumber.trim()) {
          toast.error('Please fill in all bank details');
          setSaving(false);
          return;
        }
        update.bank_name = bankName;
        update.bank_account_name = bankAccountName.trim();
        update.account_number = bankAccountNumber.trim();
        update.mobile_money_number = null;
        update.mobile_network = null;
      } else {
        // cash
        update.bank_name = null;
        update.bank_account_name = null;
        update.account_number = null;
        update.mobile_money_number = null;
        update.mobile_network = null;
      }

      const { error } = await supabase
        .from('investor_portfolios')
        .update(update as any)
        .eq('id', portfolioId);

      if (error) throw error;

      toast.success('Payout method saved successfully!');
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e.message || 'Failed to save payout method');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto" stable>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <CreditCard className="h-4 w-4 text-primary" />
            Payout Method
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            Set how you want to receive payouts for <span className="font-bold text-foreground">{portfolioName}</span>
          </p>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4 py-2">
            {/* Payout mode cards */}
            <div className="space-y-2">
              {PAYOUT_METHODS.map((method) => (
                <Card
                  key={method.value}
                  className={`p-3 cursor-pointer transition-all ${
                    payoutMode === method.value
                      ? 'ring-2 ring-primary border-primary bg-primary/5'
                      : 'hover:border-primary/50'
                  }`}
                  onClick={() => setPayoutMode(method.value)}
                >
                  <div className="flex items-center gap-3">
                    <span className="text-lg">{method.icon}</span>
                    <div className="flex-1">
                      <p className="text-sm font-semibold">{method.label}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {method.value === 'mobile_money' && 'MTN or Airtel Mobile Money'}
                        {method.value === 'bank_transfer' && 'Direct bank deposit'}
                        {method.value === 'cash' && 'Collect cash at the office'}
                      </p>
                    </div>
                    {payoutMode === method.value && (
                      <div className="w-4 h-4 rounded-full bg-primary flex items-center justify-center">
                        <span className="text-white text-[10px]">✓</span>
                      </div>
                    )}
                  </div>
                </Card>
              ))}
            </div>

            {/* Mobile Money fields */}
            {payoutMode === 'mobile_money' && (
              <div className="space-y-3 pt-2 border-t border-border/40">
                <div className="space-y-1.5">
                  <Label className="text-xs">Network</Label>
                  <Select value={momoNetwork} onValueChange={setMomoNetwork}>
                    <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MTN">🟡 MTN Mobile Money</SelectItem>
                      <SelectItem value="Airtel">🔴 Airtel Money</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Mobile Number</Label>
                  <div className="relative">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      type="tel"
                      placeholder="e.g. 0770123456"
                      value={momoNumber}
                      onChange={(e) => setMomoNumber(e.target.value)}
                      className="h-10 pl-10"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Bank fields */}
            {payoutMode === 'bank_transfer' && (
              <div className="space-y-3 pt-2 border-t border-border/40">
                <div className="space-y-1.5">
                  <Label className="text-xs">Bank Name</Label>
                  <Select value={bankName} onValueChange={setBankName}>
                    <SelectTrigger className="h-10">
                      <SelectValue placeholder="Select your bank..." />
                    </SelectTrigger>
                    <SelectContent className="max-h-60">
                      {UGANDA_BANKS.map(b => (
                        <SelectItem key={b} value={b}>{b}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Account Holder Name</Label>
                  <div className="relative">
                    <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="e.g. JOHN DOE"
                      value={bankAccountName}
                      onChange={(e) => setBankAccountName(e.target.value)}
                      className="h-10 pl-10"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Account Number</Label>
                  <div className="relative">
                    <Banknote className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="e.g. 9030012345678"
                      value={bankAccountNumber}
                      onChange={(e) => setBankAccountNumber(e.target.value)}
                      className="h-10 pl-10"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Cash info */}
            {payoutMode === 'cash' && (
              <div className="px-3 py-2.5 rounded-lg bg-muted/50 border border-border/60 mt-2">
                <p className="text-xs text-muted-foreground">
                  💵 You will collect your payout in cash at the office. No account details needed.
                </p>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || loading} className="gap-1.5">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save Payout Method
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
