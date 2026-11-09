import { useState, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Loader2,
  CalendarClock,
  User,
  Sliders,
  ChevronDown,
  Info,
} from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { getNextRunDate } from '@/lib/standingOrderSchedule';
import { logStandingOrderAction } from '@/lib/standingOrderAudit';
import { PAYOUT_CATEGORIES } from './DirectCreditTool';
import {
  describeSchedule,
  type PayoutScheduleConfig,
} from './PayoutAutomationToggle';
import type { StandingOrderRow } from '@/hooks/useStandingOrders';

interface EditStandingOrderDialogProps {
  order: StandingOrderRow;
  onClose: () => void;
}

export function EditStandingOrderDialog({ order, onClose }: EditStandingOrderDialogProps) {
  const qc = useQueryClient();

  const category = useMemo(
    () => PAYOUT_CATEGORIES.find((c) => c.id === order.category_id),
    [order.category_id],
  );

  const [selectedSubCategoryId, setSelectedSubCategoryId] = useState<string>(
    order.sub_category || '',
  );
  const [amount, setAmount] = useState<string>(String(order.amount));
  const [reason, setReason] = useState<string>(order.reason || '');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const [scheduleConfig, setScheduleConfig] = useState<PayoutScheduleConfig>({
    frequency: (order.frequency as any) || 'monthly',
    dayOfMonth: order.day_of_month ?? 1,
    dayOfWeek: order.day_of_week ?? 1,
    intervalDays: order.interval_days ?? 7,
  });

  const numAmount = Number(amount);
  const prevAmount = Number(order.amount);
  const amountChanged = Number.isFinite(numAmount) && numAmount > 0 && numAmount !== prevAmount;

  const scheduleChanged =
    scheduleConfig.frequency !== order.frequency ||
    (scheduleConfig.frequency === 'monthly' && scheduleConfig.dayOfMonth !== order.day_of_month) ||
    (scheduleConfig.frequency === 'weekly' && scheduleConfig.dayOfWeek !== order.day_of_week) ||
    (scheduleConfig.frequency === 'interval' && scheduleConfig.intervalDays !== order.interval_days);

  const subCategoryChanged = (selectedSubCategoryId || null) !== (order.sub_category || null);
  const reasonChanged = reason.trim() !== (order.reason || '').trim();

  const isFormValid =
    Number.isFinite(numAmount) &&
    numAmount > 0 &&
    numAmount <= 500000000 &&
    reason.trim().length >= 10;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid || isSubmitting) return;

    setIsSubmitting(true);
    try {
      // 1. If amount changed, use the atomic server RPC standing_order_set_amount
      // to ensure full ledger lock and compliance audit.
      let currentUpdatedAt = order.updated_at;
      if (amountChanged) {
        const { data: rpcData, error: rpcErr } = await (supabase.rpc as any)(
          'standing_order_set_amount',
          {
            p_order_id: order.id,
            p_expected_amount: prevAmount,
            p_expected_updated_at: order.updated_at,
            p_new_amount: numAmount,
            p_reason: reason.trim(),
          },
        );
        if (rpcErr) throw new Error(rpcErr.message);
        if (rpcData?.order?.updated_at) {
          currentUpdatedAt = rpcData.order.updated_at;
        }
      }

      // 2. If schedule, subcategory, or reason changed, update scheduled_payouts table.
      if (scheduleChanged || subCategoryChanged || (!amountChanged && reasonChanged)) {
        const nextRun = getNextRunDate(scheduleConfig);
        const { error: updateErr } = await supabase
          .from('scheduled_payouts')
          .update({
            frequency: scheduleConfig.frequency,
            day_of_month: scheduleConfig.frequency === 'monthly' ? scheduleConfig.dayOfMonth : null,
            day_of_week: scheduleConfig.frequency === 'weekly' ? scheduleConfig.dayOfWeek : null,
            interval_days: scheduleConfig.frequency === 'interval' ? scheduleConfig.intervalDays : null,
            sub_category: selectedSubCategoryId || null,
            reason: reason.trim(),
            next_run_at: nextRun,
            updated_at: new Date().toISOString(),
          })
          .eq('id', order.id);

        if (updateErr) throw updateErr;

        await logStandingOrderAction({
          scheduledPayoutId: order.id,
          action: 'update',
          targetUserId: order.target_user_id,
          recipientName: order.target_name,
          amount: numAmount,
          reason: reason.trim(),
          scheduleDescription: describeSchedule(scheduleConfig),
        });
      }

      toast.success('Standing order updated', {
        description: `${order.target_name || 'Recipient'} · UGX ${numAmount.toLocaleString()} (${describeSchedule(scheduleConfig)})`,
      });

      qc.invalidateQueries({ queryKey: ['cfo-standing-orders'] });
      qc.invalidateQueries({ queryKey: ['standing-orders'] });
      onClose();
    } catch (err: any) {
      toast.error('Failed to update standing order', {
        description: err?.message || String(err),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !isSubmitting) onClose(); }}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto rounded-3xl p-6 sm:p-7 border-border/80 shadow-2xl">
        <DialogHeader className="pb-3 border-b border-border/60">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20 shadow-xs">
              <Sliders className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-lg sm:text-xl font-bold tracking-tight text-foreground">
                Edit Standing Order
              </DialogTitle>
              <DialogDescription className="text-xs sm:text-sm text-muted-foreground mt-0.5">
                Revise recurrence schedule, recurring amount, subcategory, or audit reason.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="py-2 space-y-5">
          {/* Recipient & Category Summary Card */}
          <div className="p-4 rounded-2xl border border-border/80 bg-muted/20 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-7 w-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center font-bold">
                  <User className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm font-bold text-foreground">{order.target_name || 'Unknown User'}</p>
                  {order.target_phone && <p className="text-xs text-muted-foreground font-mono">{order.target_phone}</p>}
                </div>
              </div>
              <Badge variant="outline" className="text-xs font-semibold">
                {category?.label || order.category_id}
              </Badge>
            </div>
          </div>

          {/* Subcategory (if applicable) */}
          {category?.subCategories && category.subCategories.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="edit-so-subcategory" className="text-xs font-semibold text-foreground">
                Subcategory
              </Label>
              <div className="relative">
                <select
                  id="edit-so-subcategory"
                  value={selectedSubCategoryId}
                  onChange={(e) => setSelectedSubCategoryId(e.target.value)}
                  className="flex h-11 w-full appearance-none rounded-xl border border-border/80 bg-background px-3.5 py-2 pr-10 text-sm text-foreground transition-colors ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring/20 focus:border-primary/50"
                >
                  <option value="">No subcategory</option>
                  {category.subCategories.map((sub) => (
                    <option key={sub.id} value={sub.id}>
                      {sub.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            </div>
          )}

          {/* Amount Field */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-so-amount" className="text-xs font-semibold text-foreground">
                Recurring Amount (UGX) <span className="text-destructive">*</span>
              </Label>
              {amountChanged ? (
                <span className="text-xs font-bold font-mono text-amber-700 dark:text-amber-300 bg-amber-100/50 dark:bg-amber-900/30 px-2 py-0.5 rounded-md border border-amber-300/40">
                  {formatUGX(prevAmount)} → {formatUGX(numAmount)}
                </span>
              ) : (
                <span className="text-xs font-bold font-mono text-primary bg-primary/10 px-2 py-0.5 rounded-md border border-primary/20">
                  {formatUGX(prevAmount)}
                </span>
              )}
            </div>
            <div className="relative flex items-center">
              <div className="pointer-events-none absolute left-3 z-10 flex items-center justify-center h-8 px-2.5 rounded-lg bg-muted text-foreground font-bold text-xs border border-border/70 shadow-2xs">
                UGX
              </div>
              <Input
                id="edit-so-amount"
                type="number"
                min={1}
                max={500000000}
                placeholder="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="pl-20 h-14 rounded-2xl text-xl sm:text-2xl font-bold tracking-tight text-foreground bg-background border-border/80 focus-visible:ring-2 focus-visible:ring-primary/25 focus-visible:border-primary shadow-xs"
              />
            </div>
          </div>

          {/* Recurrence Schedule Config */}
          <div className="rounded-2xl border border-border/80 bg-muted/20 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                <CalendarClock className="h-4 w-4 text-primary" />
                Recurrence Schedule
              </Label>
              <Badge variant="outline" className="text-[11px] font-medium border-primary/30 text-primary bg-primary/5">
                {describeSchedule(scheduleConfig)}
              </Badge>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Frequency</Label>
                <Select
                  value={scheduleConfig.frequency}
                  onValueChange={(val: any) =>
                    setScheduleConfig((c) => ({ ...c, frequency: val }))
                  }
                >
                  <SelectTrigger className="h-10 rounded-xl">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="interval">Every N Days</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {scheduleConfig.frequency === 'monthly' && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Day of Month</Label>
                  <Select
                    value={String(scheduleConfig.dayOfMonth)}
                    onValueChange={(val) =>
                      setScheduleConfig((c) => ({ ...c, dayOfMonth: Number(val) }))
                    }
                  >
                    <SelectTrigger className="h-10 rounded-xl">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-56">
                      {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                        <SelectItem key={d} value={String(d)}>
                          Day {d} of month
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {scheduleConfig.frequency === 'weekly' && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Day of Week</Label>
                  <Select
                    value={String(scheduleConfig.dayOfWeek)}
                    onValueChange={(val) =>
                      setScheduleConfig((c) => ({ ...c, dayOfWeek: Number(val) }))
                    }
                  >
                    <SelectTrigger className="h-10 rounded-xl">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">Every Monday</SelectItem>
                      <SelectItem value="2">Every Tuesday</SelectItem>
                      <SelectItem value="3">Every Wednesday</SelectItem>
                      <SelectItem value="4">Every Thursday</SelectItem>
                      <SelectItem value="5">Every Friday</SelectItem>
                      <SelectItem value="6">Every Saturday</SelectItem>
                      <SelectItem value="0">Every Sunday</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {scheduleConfig.frequency === 'interval' && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Interval (Days)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={90}
                    value={scheduleConfig.intervalDays}
                    onChange={(e) =>
                      setScheduleConfig((c) => ({
                        ...c,
                        intervalDays: Math.max(1, Number(e.target.value) || 1),
                      }))
                    }
                    className="h-10 rounded-xl"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Audit Reason */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-so-reason" className="text-xs font-semibold text-foreground">
                Audit Reason <span className="text-destructive">*</span>
              </Label>
              <span
                className={`text-[11px] font-medium transition-colors ${
                  reason.trim().length >= 10
                    ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                    : 'text-muted-foreground'
                }`}
              >
                {reason.trim().length}/10 characters minimum
              </span>
            </div>
            <Textarea
              id="edit-so-reason"
              placeholder="e.g. Revised monthly payout per revised agreement..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="rounded-xl border-border/80 focus-visible:ring-primary/20 text-sm"
            />
          </div>

          {/* Action buttons */}
          <div className="flex items-center justify-end gap-2.5 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={isSubmitting}
              className="h-11 rounded-xl px-5 font-semibold"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!isFormValid || isSubmitting}
              className="h-11 rounded-xl px-6 font-semibold gap-2 bg-primary text-primary-foreground shadow-md hover:bg-primary/90"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving Changes...
                </>
              ) : (
                'Save Changes'
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

