import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Loader2, Smartphone } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { downPaymentCopy } from '@/lib/moBanjaIphone';
import { toast } from 'sonner';

const db = supabase as any;

const MIN_DAILY = 1000;

interface PendingAccessOrder {
  id: string;
  item_name: string;
  unit_price: number;
  quantity: number | null;
  total_amount: number | null;
  amount_outstanding: number;
}

interface Props {
  userId?: string;
  /** Controlled visibility — the dialog never opens on its own. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional specific merchandise_sales.id to accept. */
  saleId?: string | null;
}

/**
 * Opened explicitly from the smartphone order status card once an executive
 * approves a device order. The agent sees the access amount and picks the daily
 * wallet deduction before the device is released.
 */
export default function DeviceAccessDialog({ userId, open, onOpenChange, saleId }: Props) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'min' | 'custom'>('min');
  const [custom, setCustom] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const { data: orders = [] } = useQuery<PendingAccessOrder[]>({
    queryKey: ['device-access-pending', userId],
    enabled: !!userId && open,
    queryFn: async () => {
      const { data, error } = await db
        .from('merchandise_sales')
        .select('id, item_name, unit_price, quantity, total_amount, amount_outstanding')
        .eq('customer_id', userId)
        .eq('order_status', 'approved')
        .is('access_accepted_at', null)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
  });

  const order = useMemo(
    () => (saleId ? orders.find((o) => o.id === saleId) ?? null : orders[0] ?? null),
    [orders, saleId],
  );

  useEffect(() => {
    setMode('min');
    setCustom('');
  }, [order?.id]);

  if (!userId || !open || !order) return null;


  const totalPrice = Number(
    order.total_amount ?? Number(order.unit_price) * Math.max(Number(order.quantity ?? 1), 1),
  );
  const accessAmount = Math.round(totalPrice * 1.33);
  const dailyAmount = mode === 'min' ? MIN_DAILY : Math.round(Number(custom) || 0);
  const valid = dailyAmount >= MIN_DAILY;
  const days = valid ? Math.ceil(accessAmount / dailyAmount) : 0;

  const confirm = async () => {
    if (!valid) {
      toast.error(`Daily amount must be at least ${formatUGX(MIN_DAILY)}`);
      return;
    }
    setSubmitting(true);
    try {
      const { error } = await db.rpc('agent_accept_device_access', {
        p_sale_id: order.id,
        p_daily_amount: dailyAmount,
      });
      if (error) throw error;
      toast.success(`Device access confirmed — ${formatUGX(dailyAmount)}/day will be deducted from your wallet`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['device-access-pending', userId] }),
        queryClient.invalidateQueries({ queryKey: ['my-smartphone-orders', userId, order.item_name] }),
      ]);
      onOpenChange(false);

    } catch (e: any) {
      console.error('[DeviceAccessDialog] confirm error', e);
      toast.error(e?.message || 'Could not confirm device access');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Smartphone className="h-4 w-4 text-primary" />
            Proceed to access device
          </DialogTitle>
          <DialogDescription className="text-xs">
            Your {order.item_name} order was approved. Choose how much is deducted from your wallet
            each day, then confirm to access the device.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Down payment repayable to Welile
            </p>
            <p className="text-2xl font-bold text-primary">{formatUGX(accessAmount)}</p>
          </div>

          {(() => {
            const copy = downPaymentCopy(null, order.item_name);
            return (
              <div className="rounded-xl border border-border bg-muted/40 p-3 space-y-1">
                <p className="text-xs font-semibold">{copy.title}</p>
                <p className="text-[11px] text-muted-foreground">{copy.amountNote}</p>
                <ul className="space-y-0.5 text-[11px] text-muted-foreground">
                  {copy.twoLegs.map((line) => (
                    <li key={line}>• {line}</li>
                  ))}
                </ul>
                {copy.lockNotice && <p className="text-[11px] text-muted-foreground">{copy.lockNotice}</p>}
              </div>
            );
          })()}

          <div className="space-y-2">
            <Label className="text-xs font-semibold">Payment plan</Label>
            <RadioGroup value={mode} onValueChange={(v) => setMode(v as 'min' | 'custom')} className="space-y-2">
              <label className="flex items-start gap-3 rounded-xl border border-border p-3 cursor-pointer">
                <RadioGroupItem value="min" className="mt-0.5" />
                <span className="text-xs">
                  <span className="block font-semibold text-foreground">
                    {formatUGX(MIN_DAILY)} per day (minimum)
                  </span>
                  Automatic daily deduction from your wallet.
                </span>
              </label>
              <label className="flex items-start gap-3 rounded-xl border border-border p-3 cursor-pointer">
                <RadioGroupItem value="custom" className="mt-0.5" />
                <span className="text-xs w-full">
                  <span className="block font-semibold text-foreground">Custom daily amount</span>
                  Pay faster with a higher daily deduction (minimum {formatUGX(MIN_DAILY)}).
                  {mode === 'custom' && (
                    <Input
                      type="number"
                      min={MIN_DAILY}
                      step={500}
                      value={custom}
                      onChange={(e) => setCustom(e.target.value)}
                      placeholder="e.g. 5000"
                      className="mt-2 h-9"
                    />
                  )}
                </span>
              </label>
            </RadioGroup>
          </div>

          {valid && (
            <p className="text-[11px] text-muted-foreground">
              At {formatUGX(dailyAmount)} per day, this clears in about {days} day{days === 1 ? '' : 's'}.
            </p>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            Later
          </Button>
          <Button size="sm" disabled={!valid || submitting} onClick={confirm}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm & Access Device'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
