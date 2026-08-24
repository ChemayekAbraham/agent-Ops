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

const db = supabase as any;

/** Wallet recovery rate applied to every approved smartphone order. */
export const SMARTPHONE_RECOVERY_RATE = 0.33;

const BRANDS = ['iPhone', 'Samsung'] as const;

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

  const totalAmount = Math.max(0, parseInt(amount || '0', 10) || 0);
  const projection = Math.round(totalAmount * SMARTPHONE_RECOVERY_RATE);
  const canSubmit = !!brand && modelType.trim().length > 1 && totalAmount >= 1000;

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
    if (modelType.trim().length < 2) {
      toast.error('Enter the type of phone');
      return;
    }
    if (totalAmount < 1000) {
      toast.error('Enter a phone amount of at least UGX 1,000');
      return;
    }
    setSubmitting(true);
    const { error } = await db.rpc('agent_order_smartphone', {
      p_total_amount: totalAmount,
      p_brand: brand,
      p_model_type: modelType.trim(),
    });
    setSubmitting(false);
    if (error) {
      toast.error(error.message || 'Could not submit smartphone order');
      return;
    }
    toast.success(
      `Order submitted for approval. Payment projection ${formatUGX(projection)} (33% wallet recovery rate).`,
    );
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
            <Select value={brand} onValueChange={setBrand}>
              <SelectTrigger>
                <SelectValue placeholder="Select brand" />
              </SelectTrigger>
              <SelectContent>
                {BRANDS.map((b) => (
                  <SelectItem key={b} value={b}>{b}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Type Of Phone</Label>
            <Input
              value={modelType}
              onChange={(e) => setModelType(e.target.value)}
              placeholder="e.g. iPhone 13 Pro Max or Samsung Galaxy A14"
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

          <div className="rounded-lg border bg-muted/50 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">
              Payment Projection
            </p>
            <p className="text-base font-bold">{formatUGX(projection)}</p>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Your order is submitted as Pending Approval. Nothing is charged to your wallet until it is
            approved — you can order even with a UGX 0 balance.
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
