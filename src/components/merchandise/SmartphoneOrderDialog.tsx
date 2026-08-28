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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Smartphone, FileText } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import smartphonePromoAsset from '@/assets/smartphone-promo.jpg.asset.json';
import { useSmartphoneCatalog } from '@/components/executive/agent-ops/SmartphoneCatalogDialog';

const db = supabase as any;

/** Internal recovery markup used only to derive the agent-facing daily repayment. */
const SMARTPHONE_RECOVERY_RATE = 0.33;
const SMARTPHONE_REPAYMENT_DAYS = 365;



interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId?: string;
}

/**
 * Structured smartphone order form. Orders are submitted as Pending Approval —
 * no wallet balance is required up front and nothing is charged until an
 * executive approves the order on the Agent Smart Phones page.
 */
export default function SmartphoneOrderDialog({ open, onOpenChange, userId }: Props) {
  const queryClient = useQueryClient();
  const [brand, setBrand] = useState<string>('');
  const [modelType, setModelType] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const { data: catalog = [], isLoading: catalogLoading } = useSmartphoneCatalog();
  const activeCatalog = catalog.filter((c) => c.is_active);
  const brands = Array.from(new Set(activeCatalog.map((c) => c.brand)));
  const models = activeCatalog.filter((c) => c.brand === brand && !!c.model_name);

  const matched = activeCatalog.find((c) => c.brand === brand && c.model_name === modelType);
  const totalAmount = Math.max(0, Math.round(Number(matched?.default_amount ?? 0)) || 0);
  const dailyRepayment = totalAmount > 0
    ? Math.max(1, Math.ceil(totalAmount * (1 + SMARTPHONE_RECOVERY_RATE) / SMARTPHONE_REPAYMENT_DAYS))
    : 0;

  const canSubmit = !!brand && !!modelType && totalAmount >= 1000;

  const onBrandChange = (value: string) => {
    setBrand(value);
    setModelType('');
  };

  const onModelChange = (value: string) => {
    setModelType(value);
  };

  const reset = () => {
    setBrand('');
    setModelType('');
  };


  const submit = async () => {
    if (!brand || !modelType) {
      toast.error('Select a brand and phone model from the catalog');
      return;
    }
    if (totalAmount < 1000) {
      toast.error('This model has no catalog price yet — contact Agent Ops');
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

        <Tabs defaultValue="order" className="w-full">
          <TabsList className="w-full">
            <TabsTrigger value="order" className="flex-1">Order</TabsTrigger>
            <TabsTrigger value="tnc" className="flex-1">
              <FileText className="h-3.5 w-3.5 mr-1.5" /> View T&C
            </TabsTrigger>
          </TabsList>

          <TabsContent value="order" className="space-y-3 mt-3">
            <img
              src={smartphonePromoAsset.url}
              alt="Welile Smartphone selection"
              className="w-full h-36 object-cover rounded-lg border border-border"
            />

            <div className="space-y-1">
              <Label className="text-xs">Product Brand</Label>
              <Select value={brands.includes(brand) ? brand : ''} onValueChange={onBrandChange} disabled={catalogLoading}>
                <SelectTrigger>
                  <SelectValue placeholder={catalogLoading ? 'Loading brands…' : 'Select brand'} />
                </SelectTrigger>
                <SelectContent>
                  {brands.map((b) => (
                    <SelectItem key={b} value={b}>{b}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Phone Model</Label>
              <Select
                value={models.some((m) => m.model_name === modelType) ? modelType : ''}
                onValueChange={onModelChange}
                disabled={!brand || models.length === 0}
              >
                <SelectTrigger>
                  <SelectValue placeholder={!brand ? 'Select a brand first' : models.length ? 'Select a listed model' : 'No models listed'} />
                </SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m.id} value={m.model_name as string}>{m.model_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {totalAmount > 0 && (
              <div className="rounded-lg border border-border bg-muted/40 p-3">
                <p className="text-xs text-muted-foreground">Total access amount</p>
                <p className="text-lg font-bold tabular-nums">{formatUGX(accessAmount)}</p>
              </div>
            )}

            <p className="text-[11px] text-muted-foreground">
              Your order is submitted as Pending Approval. Nothing is charged to your wallet until it is
              approved — you can order even with a UGX 0 balance. Your payment projection is shown once the
              order is approved.
            </p>
          </TabsContent>

          <TabsContent value="tnc" className="mt-3">
            <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3 text-sm">
              <h4 className="font-semibold">Terms & Conditions</h4>
              <ol className="list-decimal pl-4 space-y-2 text-muted-foreground">
                <li><span className="font-medium text-foreground">Eligibility:</span> Must have an active Welile Wallet and active tenants.</li>
                <li><span className="font-medium text-foreground">Access Fee Only:</span> Welile pays only the Access Fee. You pay any remaining supplier balance directly.</li>
                <li><span className="font-medium text-foreground">Repayment:</span> You must repay the Access Fee back to Welile through your wallet.</li>
                <li><span className="font-medium text-foreground">Auto-Deduction:</span> Daily repayments (min. UGX 1,000) will be automatically deducted from your Welile Wallet.</li>
              </ol>
            </div>
          </TabsContent>
        </Tabs>

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
