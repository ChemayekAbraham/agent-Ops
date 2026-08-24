import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Smartphone } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import smartphonePromoAsset from '@/assets/smartphone-promo.jpg.asset.json';
import { useSmartphoneCatalog } from '@/components/executive/agent-ops/SmartphoneCatalogDialog';

const db = supabase as any;

/** Wallet recovery rate applied to every approved smartphone order. */
export const SMARTPHONE_RECOVERY_RATE = 0.33;



interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId?: string;
}

/**
 * Structured smartphone order form (brand, model type, total amount, 33%
 * payment projection). Orders are submitted as Pending Approval — no wallet
 * balance is required up front and nothing is charged until an executive
 * approves the order on the Agent Smart Phones page.
 */
export default function SmartphoneOrderDialog({ open, onOpenChange, userId }: Props) {
  const queryClient = useQueryClient();
  const [brand, setBrand] = useState<string>('');
  const [modelType, setModelType] = useState('');
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const { data: catalog = [], isLoading: catalogLoading } = useSmartphoneCatalog();
  const activeCatalog = catalog.filter((c) => c.is_active);
  const brands = Array.from(new Set(activeCatalog.map((c) => c.brand)));
  const models = activeCatalog.filter((c) => c.brand === brand && !!c.model_name);

  const totalAmount = Math.max(0, parseInt(amount || '0', 10) || 0);

  const canSubmit = !!brand && totalAmount >= 1000;

  const onBrandChange = (value: string) => {
    setBrand(value);
    setModelType('');
  };

  const onModelChange = (value: string) => {
    setModelType(value);
    const match = activeCatalog.find((c) => c.brand === brand && c.model_name === value);
    if (match && match.default_amount != null && Number(match.default_amount) > 0) {
      setAmount(String(Math.round(Number(match.default_amount))));
    }
  };

  const reset = () => {
    setBrand('');
    setModelType('');
    setAmount('');
  };

  const submit = async () => {
    if (!brand) {
      toast.error('Select a product brand');
      return;
    }
    if (totalAmount < 1000) {
      toast.error('Enter a phone amount of at least UGX 1,000');
      return;
    }
    setSubmitting(true);
    const { error } = await db.rpc('agent_order_smartphone', {
      p_total_amount: totalAmount,
      p_brand: brand.trim(),
      p_model_type: modelType.trim() || 'Unspecified',
    });
    setSubmitting(false);
    if (error) {
      toast.error(error.message || 'Could not submit smartphone order');
      return;
    }
    toast.success('Order submitted for approval.');

    reset();
    onOpenChange(false);
    queryClient.invalidateQueries({ queryKey: ['my-smartphone-orders', userId] });
    queryClient.invalidateQueries({ queryKey: ['my-merchandise-plans', userId] });
    queryClient.invalidateQueries({ queryKey: ['my-merchandise-deductions', userId] });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!submitting) onOpenChange(o); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-primary" /> Order a Welile Smartphone
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <img
            src={smartphonePromoAsset.url}
            alt="Welile Smartphone selection"
            className="w-full h-36 object-cover rounded-lg border border-border"
          />

          <div className="space-y-1">
            <Label className="text-xs">Product Brand</Label>
            <Select value={brand} onValueChange={onBrandChange} disabled={catalogLoading || brands.length === 0}>
              <SelectTrigger>
                <SelectValue placeholder={catalogLoading ? 'Loading brands…' : brands.length ? 'Select brand' : 'No phones available yet'} />
              </SelectTrigger>
              <SelectContent>
                {brands.map((b) => (
                  <SelectItem key={b} value={b}>{b}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">
              Phone Model <span className="text-muted-foreground font-normal">— optional</span>
            </Label>
            {models.length > 0 && (
              <Select value={models.some((m) => m.model_name === modelType) ? modelType : ''} onValueChange={onModelChange} disabled={!brand}>
                <SelectTrigger>
                  <SelectValue placeholder={!brand ? 'Select a brand first' : 'Select a listed model'} />
                </SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m.id} value={m.model_name as string}>{m.model_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Input
              value={modelType}
              onChange={(e) => setModelType(e.target.value)}
              disabled={!brand}
              placeholder={!brand ? 'Select a brand first' : 'Or type your own model name'}
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Input Phone Amount (UGX)</Label>
            <Input
              type="number"
              min={1000}
              step={1000}
              inputMode="numeric"
              placeholder="e.g. 1200000"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>

          <p className="text-[11px] text-muted-foreground">
            Your order is submitted as Pending Approval. Nothing is charged to your wallet until it is
            approved — you can order even with a UGX 0 balance. Your payment projection is shown once the
            order is approved.
          </p>

        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || !canSubmit}>
            {submitting ? 'Submitting…' : 'Submit order'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
