import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { CheckCircle2, ChevronDown, ChevronUp, Package, Wallet } from 'lucide-react';
import { toast } from 'sonner';

import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatUGX } from '@/lib/rentCalculations';
import { useAgentBalances } from '@/hooks/useAgentBalances';
import {
  useMerchandiseRepaymentPortfolio,
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
  const { activePlans, plans, deductions, totalOutstanding, totalPaid } =
    useMerchandiseRepaymentPortfolio(userId);
  const { withdrawableBalance } = useAgentBalances(userId);
  const pay = usePayMerchandisePlan(userId);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [payTarget, setPayTarget] = useState<MerchandiseRepaymentPlan | null>(null);
  const [payAmount, setPayAmount] = useState('');

  const available = Math.max(0, Number(withdrawableBalance || 0));
  const settled = useMemo(
    () => plans.filter((p) => p.status !== 'active' || Number(p.outstanding_balance) <= 0),
    [plans],
  );

  if (activePlans.length === 0 && settled.length === 0) return null;

  const openPay = (plan: MerchandiseRepaymentPlan) => {
    const suggested = Math.min(
      Number(plan.outstanding_balance || 0),
      Number(plan.daily_deduction_amount || 0) > 0
        ? Number(plan.daily_deduction_amount)
        : Number(plan.outstanding_balance || 0),
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
    try {
      const res = await pay.mutateAsync({ planId: payTarget.id, amount });
      toast.success(
        res.completed
          ? `${payTarget.item_name || 'Product'} is now fully paid.`
          : `${formatUGX(Number(res.amount_paid || 0))} paid — ${formatUGX(Number(res.outstanding_after || 0))} left.`,
      );
      setPayTarget(null);
    } catch (e: any) {
      toast.error(e?.message || 'Payment could not be completed.');
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
            <p className="text-sm font-bold tabular-nums">{formatUGX(available)}</p>
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

          {settled.map((plan) => (
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
                <p className="font-bold tabular-nums">{formatUGX(available)}</p>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium">Amount to pay (UGX)</label>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                value={payAmount}
                onChange={(e) => setPayAmount(e.target.value)}
              />
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
                  onClick={() =>
                    setPayAmount(String(Math.floor(Number(payTarget?.outstanding_balance || 0))))
                  }
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
            <Button onClick={submitPay} disabled={pay.isPending}>
              {pay.isPending ? 'Paying…' : 'Pay now'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
