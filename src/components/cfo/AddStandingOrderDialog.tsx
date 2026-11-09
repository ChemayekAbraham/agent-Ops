import { useState } from 'react';
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
  ArrowLeft,
  ChevronDown,
  Sparkles,
  CheckCircle2,
  Wallet,
  Building2,
  Info,
} from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { getSessionCheckedUser } from '@/lib/authenticatedRequests';
import { getNextRunDate } from '@/lib/standingOrderSchedule';
import { logStandingOrderAction } from '@/lib/standingOrderAudit';
import { PAYOUT_CATEGORIES, type PayoutCategory } from './DirectCreditTool';
import { UserSearchPicker, type UserResult } from './UserSearchPicker';
import {
  PayoutAutomationToggle,
  describeSchedule,
  type PayoutScheduleConfig,
} from './PayoutAutomationToggle';

interface AddStandingOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

// Standing orders credit recipient wallets on a recurring automated schedule.
// Exclude batch queues (rent disbursement and business advances) which require
// individual pipeline contracts and multi-stage COO verification.
const CREDIT_CATEGORIES: PayoutCategory[] = PAYOUT_CATEGORIES.filter(
  (c) =>
    c.allowedOps.includes('credit') &&
    c.id !== 'rent_disbursement' &&
    c.id !== 'business_advance' &&
    c.id !== 'agent_float_allocation',
);

export function AddStandingOrderDialog({
  open,
  onOpenChange,
  onSuccess,
}: AddStandingOrderDialogProps) {
  const qc = useQueryClient();
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('');
  const [selectedSubCategoryId, setSelectedSubCategoryId] = useState<string>('');
  const [selectedUser, setSelectedUser] = useState<UserResult | null>(null);
  const [amount, setAmount] = useState<string>('');
  const [reason, setReason] = useState<string>('');
  const [disburseFirstNow, setDisburseFirstNow] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const [scheduleConfig, setScheduleConfig] = useState<PayoutScheduleConfig>({
    frequency: 'monthly',
    dayOfMonth: 1,
    dayOfWeek: 1,
    intervalDays: 7,
  });

  const selectedCategory = CREDIT_CATEGORIES.find((c) => c.id === selectedCategoryId);
  const hasSubCategories = (selectedCategory?.subCategories?.length ?? 0) > 0;
  const numAmount = Number(amount);

  const handleReset = () => {
    setSelectedCategoryId('');
    setSelectedSubCategoryId('');
    setSelectedUser(null);
    setAmount('');
    setReason('');
    setDisburseFirstNow(false);
    setIsSubmitting(false);
  };

  const handleClose = (newOpen: boolean) => {
    if (!newOpen && !isSubmitting) {
      handleReset();
    }
    onOpenChange(newOpen);
  };

  const isFormValid =
    selectedCategory !== null &&
    (!hasSubCategories || Boolean(selectedSubCategoryId)) &&
    selectedUser !== null &&
    numAmount > 0 &&
    reason.trim().length >= 20;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid || !selectedCategory || !selectedUser || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const auth = await getSessionCheckedUser();
      const currentUserId = auth.data.user?.id;
      if (!currentUserId) throw new Error('You must be signed in to create a standing order.');

      const nextRunAt = getNextRunDate(scheduleConfig);

      // 1. If CFO requested an immediate first payout, credit the user wallet right now via cfo-direct-credit.
      if (disburseFirstNow) {
        const { data: creditData, error: creditErr } = await supabase.functions.invoke(
          'cfo-direct-credit',
          {
            body: {
              target_user_id: selectedUser.id,
              amount: numAmount,
              reason: `[Initial Disbursed + Standing Order] ${reason}`,
              operation: 'credit',
              recipient_type: selectedCategory.recipientLock === 'operational_wallet' ? 'operational_wallet' : 'user',
              wallet_category: selectedCategory.walletCategory,
              platform_category: selectedCategory.platformCategory,
              financial_impact: selectedCategory.impact,
              category_label: selectedCategory.label,
              sub_category: selectedSubCategoryId || null,
            },
          },
        );

        if (creditErr) {
          throw new Error(`Initial disbursement failed: ${creditErr.message}`);
        }
        if ((creditData as any)?.error) {
          throw new Error(`Initial disbursement failed: ${(creditData as any).error}`);
        }
      }

      // 2. Insert schedule record into scheduled_payouts table.
      const { data: schedRow, error: schedErr } = await supabase
        .from('scheduled_payouts')
        .insert({
          created_by: currentUserId,
          target_user_id: selectedUser.id,
          amount: numAmount,
          category_id: selectedCategoryId,
          sub_category: selectedSubCategoryId || null,
          reason,
          frequency: scheduleConfig.frequency,
          day_of_month: scheduleConfig.frequency === 'monthly' ? scheduleConfig.dayOfMonth : null,
          day_of_week: scheduleConfig.frequency === 'weekly' ? scheduleConfig.dayOfWeek : null,
          interval_days: scheduleConfig.frequency === 'interval' ? scheduleConfig.intervalDays : null,
          enabled: true,
          next_run_at: nextRunAt,
        })
        .select('id')
        .maybeSingle();

      if (schedErr) throw schedErr;

      // 3. Log audit event.
      await logStandingOrderAction({
        scheduledPayoutId: (schedRow as any)?.id ?? null,
        action: 'create',
        targetUserId: selectedUser.id,
        recipientName: selectedUser.full_name ?? null,
        amount: numAmount,
        reason,
        scheduleDescription: describeSchedule(scheduleConfig),
      });

      // 4. Notify recipient (non-blocking).
      try {
        await supabase.functions.invoke('notify-standing-order-setup', {
          body: {
            target_user_id: selectedUser.id,
            scheduled_payout_id: (schedRow as any)?.id ?? null,
            amount: numAmount,
            schedule: describeSchedule(scheduleConfig),
            reason,
            next_run_at: nextRunAt,
          },
        });
      } catch (notifyErr) {
        console.error('[AddStandingOrderDialog] Notification failed:', notifyErr);
      }

      toast.success('🔁 Standing order created', {
        description: `${selectedUser.full_name} will be auto-credited UGX ${numAmount.toLocaleString()} (${describeSchedule(scheduleConfig)})`,
      });

      qc.invalidateQueries({ queryKey: ['standing-orders'] });
      qc.invalidateQueries({ queryKey: ['channel-balances'] });
      qc.invalidateQueries({ queryKey: ['treasury-cash-snapshot'] });
      qc.invalidateQueries({ queryKey: ['expense-transfers'] });

      handleClose(false);
      onSuccess?.();
    } catch (err: any) {
      toast.error('Failed to create standing order', {
        description: err?.message || String(err),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[92vh] overflow-y-auto rounded-3xl p-6 sm:p-7 border-border/80 shadow-2xl">
        <DialogHeader className="pb-3 border-b border-border/60">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20 shadow-xs">
              <CalendarClock className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-lg sm:text-xl font-bold tracking-tight text-foreground flex items-center gap-2">
                Create Standing Order
              </DialogTitle>
              <DialogDescription className="text-xs sm:text-sm text-muted-foreground mt-0.5">
                Schedule recurring automated wallet credits with double-entry general ledger tracking.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* STEP 1: Select Category */}
        {!selectedCategory ? (
          <div className="py-2 space-y-4">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                <Sparkles className="h-4 w-4 text-primary" />
                Select Payout Category
              </p>
              <p className="text-xs text-muted-foreground">
                Choose an authorized wallet credit category to schedule for recurring payments.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {CREDIT_CATEGORIES.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setSelectedCategoryId(cat.id)}
                  className="group relative text-left p-3.5 rounded-2xl border border-border/70 bg-card hover:border-primary/60 hover:bg-primary/5 transition-all shadow-2xs hover:shadow-xs"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-bold text-foreground group-hover:text-primary transition-colors">
                      {cat.label}
                    </span>
                    <Badge variant="outline" className="text-[10px] capitalize px-2 py-0">
                      {cat.impact}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                    {cat.description}
                  </p>
                  {cat.subCategories && (
                    <div className="text-[10px] text-primary/80 font-medium mt-1.5 flex items-center gap-1">
                      <span>📂 {cat.subCategories.length} subcategories available</span>
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* STEP 2: Fill Form Fields */
          <form onSubmit={handleSubmit} className="py-2 space-y-5">
            {/* Active Category Header */}
            <div className="flex items-center justify-between p-3.5 rounded-2xl border border-primary/30 bg-primary/5 shadow-2xs">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="h-8 w-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center font-bold shrink-0">
                  <CheckCircle2 className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground font-medium">Selected Category</p>
                  <p className="text-sm font-bold text-foreground truncate">{selectedCategory.label}</p>
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 text-xs font-semibold gap-1 text-primary hover:text-primary hover:bg-primary/10"
                onClick={() => {
                  setSelectedCategoryId('');
                  setSelectedSubCategoryId('');
                }}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Change
              </Button>
            </div>

            {/* Subcategory */}
            {hasSubCategories && (
              <div className="space-y-1.5">
                <Label htmlFor="so-subcategory" className="text-xs font-semibold text-foreground flex items-center gap-1">
                  Subcategory <span className="text-destructive">*</span>
                </Label>
                <div className="relative">
                  <select
                    id="so-subcategory"
                    value={selectedSubCategoryId}
                    onChange={(e) => setSelectedSubCategoryId(e.target.value)}
                    className="flex h-11 w-full appearance-none rounded-xl border border-border/80 bg-background px-3.5 py-2 pr-10 text-sm text-foreground transition-colors ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring/20 focus:border-primary/50"
                  >
                    <option value="">Select subcategory...</option>
                    {selectedCategory.subCategories?.map((sub) => (
                      <option key={sub.id} value={sub.id}>
                        {sub.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                </div>
              </div>
            )}

            {/* Recipient User Picker */}
            <UserSearchPicker
              label="Recipient User"
              placeholder="Search user by name or phone..."
              selectedUser={selectedUser}
              onSelect={(u) => setSelectedUser(u)}
            />

            {/* Amount Field with Big Visible Typography */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="so-amount" className="text-xs font-semibold text-foreground">
                  Recurring Amount (UGX) <span className="text-destructive">*</span>
                </Label>
                {numAmount > 0 && (
                  <span className="text-xs font-bold font-mono text-primary bg-primary/10 px-2 py-0.5 rounded-md border border-primary/20">
                    UGX {numAmount.toLocaleString()}
                  </span>
                )}
              </div>
              <div className="relative flex items-center">
                <div className="pointer-events-none absolute left-3 z-10 flex items-center justify-center h-8 px-2.5 rounded-lg bg-muted text-foreground font-bold text-xs border border-border/70 shadow-2xs">
                  UGX
                </div>
                <Input
                  id="so-amount"
                  type="number"
                  placeholder="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="pl-20 h-14 rounded-2xl text-xl sm:text-2xl font-bold tracking-tight text-foreground bg-background border-border/80 focus-visible:ring-2 focus-visible:ring-primary/25 focus-visible:border-primary shadow-xs"
                />
              </div>
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                {[10000, 50000, 100000, 200000, 500000].map((v) => (
                  <Button
                    key={v}
                    type="button"
                    size="sm"
                    variant="outline"
                    className="text-xs h-8 px-3 rounded-xl border-border/70 hover:border-primary/50 hover:bg-primary/5 hover:text-primary font-semibold"
                    onClick={() => setAmount(String(v))}
                  >
                    {(v / 1000).toFixed(0)}K
                  </Button>
                ))}
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
                <Label htmlFor="so-reason" className="text-xs font-semibold text-foreground">
                  Audit Reason <span className="text-destructive">*</span>
                </Label>
                <span
                  className={`text-[11px] font-medium transition-colors ${
                    reason.trim().length >= 20
                      ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                      : 'text-muted-foreground'
                  }`}
                >
                  {reason.trim().length}/20 characters minimum
                </span>
              </div>
              <Textarea
                id="so-reason"
                placeholder="e.g. Monthly stipend advance for technical operations, authorized by CFO..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                className="rounded-xl border-border/80 focus-visible:ring-primary/20 text-sm"
              />
            </div>

            {/* Optional First Payout Now */}
            <div className="rounded-2xl border border-border/70 bg-muted/30 p-3.5 flex items-start gap-3">
              <input
                id="disburse-now-checkbox"
                type="checkbox"
                checked={disburseFirstNow}
                onChange={(e) => setDisburseFirstNow(e.target.checked)}
                className="h-4 w-4 mt-0.5 rounded border-border text-primary focus:ring-primary/20 cursor-pointer"
              />
              <label htmlFor="disburse-now-checkbox" className="text-xs cursor-pointer select-none">
                <p className="font-semibold text-foreground">Disburse first payout immediately today</p>
                <p className="text-muted-foreground mt-0.5">
                  Sends UGX {numAmount > 0 ? numAmount.toLocaleString() : '...'} to the user's wallet right now via CFO Direct Credit, and schedules subsequent payouts starting on schedule.
                </p>
              </label>
            </div>

            {/* Action buttons */}
            <div className="flex items-center justify-end gap-2.5 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => handleClose(false)}
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
                    Saving Standing Order...
                  </>
                ) : (
                  <>
                    <CalendarClock className="h-4 w-4" />
                    {disburseFirstNow ? 'Disburse & Schedule' : 'Schedule Standing Order'}
                  </>
                )}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

