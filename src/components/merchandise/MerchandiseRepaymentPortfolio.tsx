import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Package, Trash2, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';

import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX } from '@/lib/rentCalculations';
import { useAgentBalances } from '@/hooks/useAgentBalances';
import {
  useMerchandiseRepaymentPortfolio,
  useDeleteMerchandiseApplication,
  usePayMerchandisePlan,
  type MerchandiseRepaymentPlan,
} from '@/hooks/useMerchandiseRepaymentPortfolio';

interface Props {
  userId?: string;
}

const safeDate = (value: string | null) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Repayment portfolio — the agent's own view of every product they are paying
 * for: what it is, the plan behind it, and a button to pay towards it now.
 *
 * Payments go through `agent_pay_merchandise_plan` (SECURITY DEFINER); this
 * component never touches wallet or ledger rows itself.
 */
export default function MerchandiseRepaymentPortfolio({ userId }: Props) {
  const { user } = useAuth();
  const effectiveUserId = userId || user?.id;

  const { activePlans, plans, deductions, totalOutstanding, totalPaid } =
    useMerchandiseRepaymentPortfolio(userId);
  const { withdrawableBalance } = useAgentBalances(userId);
  const pay = usePayMerchandisePlan(userId);
  const deleteApplication = useDeleteMerchandiseApplication(userId);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [payTarget, setPayTarget] = useState<MerchandiseRepaymentPlan | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<MerchandiseRepaymentPlan | null>(null);

  const available = Math.max(0, Number(withdrawableBalance || 0));

  const { data: strictAvailableBalance } = useQuery({
    queryKey: ['user-strict-available-balance', effectiveUserId],
    enabled: !!effectiveUserId,
    staleTime: 10_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_user_available_balance', {
        p_user_id: effectiveUserId as string,
      });
      if (error) {
        console.warn('Could not fetch get_user_available_balance:', error);
        return null;
      }
      return Number(data) || 0;
    },
  });

  const spendable = strictAvailableBalance !== null && strictAvailableBalance !== undefined
    ? Math.max(0, strictAvailableBalance)
    : available;
  const lockedByAdvance = Math.max(0, available - spendable);

  const rejected = useMemo(
    () => plans.filter((p) => ['rejected', 'cancelled', 'failed'].includes(p.order_status || '')),
    [plans],
  );
  const rejectedIds = useMemo(() => new Set(rejected.map((p) => p.id)), [rejected]);
  const completed = useMemo(
    () =>
      plans.filter(
        (p) =>
          !rejectedIds.has(p.id) &&
          Number(p.amount_recovered) > 0 &&
          (p.status === 'completed' || (p.status !== 'active' && Number(p.outstanding_balance) <= 0)),
      ),
    [plans, rejectedIds],
  );

  if (activePlans.length === 0 && completed.length === 0 && rejected.length === 0) return null;

  const openPay = (plan: MerchandiseRepaymentPlan) => {
    const outstanding = Number(plan.outstanding_balance || 0);
    const maxPayable = spendable > 0 ? Math.min(outstanding, spendable) : outstanding;
    const daily = Number(plan.daily_deduction_amount || 0);
    const suggested = Math.min(
      maxPayable,
      daily > 0 ? daily : maxPayable,
    );
    setPayAmount(String(Math.max(1, Math.floor(suggested))));
    setPayTarget(plan);
  };

  const submitPay = async () => {
    if (!payTarget) return;
    const amount = Math.floor(Number(payAmount || 0));
    if (!(amount >= 1)) {
      toast.error('Enter how much you want to pay.');
      return;
    }
    if (spendable > 0 && amount > spendable) {
      toast.error(`You can only pay up to ${formatUGX(spendable)} from your available wallet balance.`);
      return;
    }
    try {
      const res = await pay.mutateAsync({ planId: payTarget.id, amount });
      const paid = Number(res.amount_paid || 0);
      if (paid < amount) {
        toast.warning(
          `Only ${formatUGX(paid)} was deducted because your available spendable wallet balance was capped. The remaining ${formatUGX(amount - paid)} was not deducted from your wallet.`,
          { duration: 8000 },
        );
      } else {
        toast.success(
          res.completed
            ? `${payTarget.item_name || 'Product'} is now fully paid.`
            : `${formatUGX(paid)} paid — ${formatUGX(Number(res.outstanding_after || 0))} left.`,
        );
      }
      setPayTarget(null);
    } catch (e: any) {
      toast.error(e?.message || 'Payment could not be completed.');
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteApplication.mutateAsync(deleteTarget);
      toast.success('Application deleted.');
      setDeleteTarget(null);
    } catch (e: any) {
      toast.error(e?.message || 'Application could not be deleted.');
    }
  };

  return (
    <Card className="border-primary/30">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-xl bg-primary/10 shrink-0">
            <Package className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold leading-tight">My repayment portfolio</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Products you are paying for. Pay any amount from your wallet at any time.
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Still to pay
            </p>
            <p className="text-base font-bold tabular-nums">{formatUGX(totalOutstanding)}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-border bg-muted/40 p-2.5">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Paid so far
            </p>
            <p className="text-sm font-bold tabular-nums">{formatUGX(totalPaid)}</p>
          </div>
          <div className="rounded-lg border border-border bg-muted/40 p-2.5">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Wallet available
            </p>
            <p className="text-sm font-bold tabular-nums">{formatUGX(spendable)}</p>
            {lockedByAdvance > 0 && (
              <p className="text-[10px] text-amber-600 dark:text-amber-400 font-medium">
                {formatUGX(lockedByAdvance)} locked by advance
              </p>
            )}
          </div>
        </div>

        <div className="space-y-2">
          {activePlans.map((plan) => {
            const original = Number(plan.original_amount || 0);
            const outstanding = Number(plan.outstanding_balance || 0);
            const paid = Number(plan.amount_recovered || 0);
            const progress = original > 0 ? Math.min(100, Math.round((paid / original) * 100)) : 0;
            const daily = Number(plan.daily_deduction_amount || 0);
            const starts = safeDate(plan.starts_on);
            const isOpen = expanded === plan.id;
            const history = deductions.filter((d) => d.plan_id === plan.id);

            return (
              <div key={plan.id} className="rounded-xl border border-border overflow-hidden">
                <div className="p-3 space-y-2.5">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold truncate">
                        {plan.item_name || 'Product'}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {formatUGX(paid)} of {formatUGX(original)} paid
                      </p>
                    </div>
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {progress}%
                    </Badge>
                  </div>

                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${progress}%` }}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                    <div>
                      <span className="text-muted-foreground">Left to pay</span>
                      <p className="font-semibold tabular-nums">{formatUGX(outstanding)}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Daily amount</span>
                      <p className="font-semibold tabular-nums">
                        {daily > 0 ? formatUGX(daily) : '—'}
                      </p>
                    </div>
                  </div>

                  {starts && (
                    <p className="text-[10px] text-muted-foreground">
                      Repayment starts {format(starts, 'd MMM yyyy')}
                    </p>
                  )}

                  <div className="flex items-center gap-2">
                    <Button size="sm" className="h-8 text-xs flex-1" onClick={() => openPay(plan)}>
                      <Wallet className="h-3.5 w-3.5 mr-1" />
                      Make a payment
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 text-xs"
                      onClick={() => setExpanded(isOpen ? null : plan.id)}
                    >
                      {isOpen ? (
                        <>
                          Hide <ChevronUp className="h-3.5 w-3.5 ml-1" />
                        </>
                      ) : (
                        <>
                          Payments <ChevronDown className="h-3.5 w-3.5 ml-1" />
                        </>
                      )}
                    </Button>
                  </div>
                </div>

                {isOpen && (
                  <div className="border-t border-border divide-y divide-border/60">
                    {history.length === 0 ? (
                      <p className="p-3 text-[11px] text-muted-foreground">
                        No payments recorded on this product yet.
                      </p>
                    ) : (
                      history.map((d) => (
                        <div key={d.id} className="p-2.5 flex items-center justify-between text-[11px]">
                          <span className="text-muted-foreground">
                            {format(new Date(d.created_at), 'd MMM yyyy, HH:mm')}
                          </span>
                          <span className="font-semibold tabular-nums">
                            {formatUGX(Number(d.amount || 0))}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {rejected.map((plan) => (
            <div
              key={plan.id}
              className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 space-y-2.5"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold truncate">{plan.item_name || 'Product'}</p>
                  <Badge variant="destructive" className="mt-1 text-[10px]">
                    {plan.order_status === 'rejected' ? 'Application Rejected' : 'Application Cancelled'}
                  </Badge>
                </div>
              </div>
              <div className="rounded-lg border border-destructive/20 bg-background/70 p-2.5">
                <p className="text-[10px] font-semibold uppercase text-destructive">Reason</p>
                <p className="mt-0.5 text-xs text-foreground">
                  {plan.rejection_reason?.trim() || 'No reason was recorded. Please contact support.'}
                </p>
                {safeDate(plan.rejected_at) && (
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {format(safeDate(plan.rejected_at) as Date, 'd MMM yyyy, HH:mm')}
                  </p>
                )}
              </div>
              {plan.sale_id && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 w-full border-destructive/30 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setDeleteTarget(plan)}
                >
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete application
                </Button>
              )}
            </div>
          ))}

          {completed.map((plan) => (
            <div
              key={plan.id}
              className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 flex items-center gap-2"
            >
              <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold truncate">{plan.item_name || 'Product'}</p>
                <p className="text-[11px] text-muted-foreground">
                  Fully paid — {formatUGX(Number(plan.amount_recovered || 0))}
                </p>
              </div>
            </div>
          ))}
        </div>
      </CardContent>

      <Dialog open={!!payTarget} onOpenChange={(o) => !o && setPayTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Pay for {payTarget?.item_name || 'product'}</DialogTitle>
            <DialogDescription>
              The money is taken from your wallet and goes straight onto this product.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-lg border border-border p-2.5">
                <p className="text-muted-foreground">Left to pay</p>
                <p className="font-bold tabular-nums">
                  {formatUGX(Number(payTarget?.outstanding_balance || 0))}
                </p>
              </div>
              <div className="rounded-lg border border-border p-2.5">
                <p className="text-muted-foreground">Wallet available</p>
                <p className="font-bold tabular-nums">{formatUGX(spendable)}</p>
                {lockedByAdvance > 0 && (
                  <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-0.5 font-medium">
                    ({formatUGX(lockedByAdvance)} locked by advance)
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium">Amount to pay (UGX)</label>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={spendable > 0 ? spendable : undefined}
                value={payAmount}
                onChange={(e) => setPayAmount(e.target.value)}
              />
              {Number(payAmount || 0) > spendable && spendable > 0 && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400 font-medium">
                  ⚠️ Your spendable balance is {formatUGX(spendable)}. {lockedByAdvance > 0 ? `${formatUGX(lockedByAdvance)} is locked by an active advance.` : ''}
                </p>
              )}
              {spendable <= 0 && (
                <p className="text-[11px] text-destructive font-medium">
                  ⚠️ No spendable balance available right now. {lockedByAdvance > 0 ? `Your ${formatUGX(lockedByAdvance)} wallet balance is locked by an active advance.` : ''}
                </p>
              )}
              <div className="flex gap-2 pt-1">
                {Number(payTarget?.daily_deduction_amount || 0) > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    onClick={() =>
                      setPayAmount(
                        String(Math.floor(Number(payTarget?.daily_deduction_amount || 0))),
                      )
                    }
                  >
                    One day
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-[11px]"
                  onClick={() => {
                    const full = Number(payTarget?.outstanding_balance || 0);
                    const payable = spendable > 0 ? Math.min(full, spendable) : full;
                    setPayAmount(String(Math.floor(payable)));
                  }}
                >
                  Clear it all
                </Button>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setPayTarget(null)} disabled={pay.isPending}>
              Cancel
            </Button>
            <Button
              onClick={submitPay}
              disabled={
                pay.isPending ||
                spendable <= 0 ||
                (Number(payAmount || 0) > spendable && spendable > 0)
              }
            >
              {pay.isPending ? 'Paying…' : 'Pay now'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete rejected application?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes {deleteTarget?.item_name || 'this product application'} from your portfolio. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteApplication.isPending}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={deleteApplication.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteApplication.isPending ? 'Deleting…' : 'Delete application'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
