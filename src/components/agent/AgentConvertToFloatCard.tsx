import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAgentBalances } from '@/hooks/useAgentBalances';
import { formatUGX } from '@/lib/rentCalculations';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ArrowLeftRight, ChevronRight, CheckCircle2, Loader2, Wallet } from 'lucide-react';
import { toast } from 'sonner';

const QUICK_AMOUNTS = [50_000, 100_000, 500_000];

interface ConversionResult {
  amount: number;
  reference_id: string;
  float_after: number;
  withdrawable_after: number;
}

export function AgentConvertToFloatCard() {
  const queryClient = useQueryClient();
  const { withdrawableBalance, floatBalance, isLoading, refetch } = useAgentBalances();

  const [open, setOpen] = useState(false);
  const [amountText, setAmountText] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ConversionResult | null>(null);

  const amount = Number(amountText.replace(/[^0-9]/g, '')) || 0;
  const tooMuch = amount > withdrawableBalance;
  const canSubmit = amount >= 1000 && !tooMuch && !submitting;

  const reset = () => {
    setAmountText('');
    setNote('');
    setResult(null);
    setSubmitting(false);
  };

  const handleConvert = async () => {
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('agent-convert-withdrawable-to-float', {
        body: { amount, note },
      });
      const payload = data as (ConversionResult & { success?: boolean; error?: string }) | null;
      if (error || !payload?.success) {
        const msg = payload?.error || error?.message || "Couldn't move the money. Please try again.";
        toast.error(msg);
        return;
      }
      setResult(payload);
      toast.success(`UGX ${payload.amount.toLocaleString()} moved to your Float.`);
      await refetch();
      queryClient.invalidateQueries({ queryKey: ['wallet-balance'] });
      queryClient.invalidateQueries({ queryKey: ['agent-landlord-float-row'] });
      queryClient.invalidateQueries({ queryKey: ['wallet-transactions'] });
    } catch (e) {
      toast.error((e as Error).message || "Couldn't move the money. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        onClick={() => { reset(); setOpen(true); }}
        className="w-full rounded-2xl border-2 border-emerald-500/30 bg-emerald-500/5 p-4 text-left active:scale-[0.98] transition-all touch-manipulation"
        style={{ WebkitTapHighlightColor: 'transparent' }}
      >
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-emerald-500/15 shrink-0">
            <ArrowLeftRight className="h-5 w-5 text-emerald-600 dark:text-emerald-400" strokeWidth={2.2} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Move balance to Float
            </p>
            <p className="mt-0.5 truncate text-sm font-bold text-foreground">
              {isLoading ? 'Loading your balance…' : `${formatUGX(withdrawableBalance)} available`}
            </p>
            <p className="text-[10px] leading-snug text-muted-foreground">
              Turn your own balance into float you can spend on landlord payouts · Float now {formatUGX(floatBalance)}
            </p>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </div>
      </button>

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
        <DialogContent className="max-w-md">
          {result ? (
            <div className="py-2 text-center">
              <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15">
                <CheckCircle2 className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
              </div>
              <DialogHeader>
                <DialogTitle className="text-center text-lg">Moved to Float</DialogTitle>
                <DialogDescription className="text-center">
                  {formatUGX(result.amount)} is now in your Float and ready to spend.
                </DialogDescription>
              </DialogHeader>
              <div className="mt-4 space-y-2 rounded-xl border border-border/60 bg-muted/40 p-3 text-left text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Float now</span>
                  <span className="font-bold text-foreground">{formatUGX(result.float_after)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Your balance now</span>
                  <span className="font-bold text-foreground">{formatUGX(result.withdrawable_after)}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Reference</span>
                  <span className="truncate font-mono text-[10px] text-foreground">{result.reference_id}</span>
                </div>
              </div>
              <p className="mt-3 text-[11px] text-muted-foreground">
                This move is recorded in your wallet history.
              </p>
              <Button className="mt-4 w-full" onClick={() => { setOpen(false); reset(); }}>
                Done
              </Button>
            </div>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <ArrowLeftRight className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  Move balance to Float
                </DialogTitle>
                <DialogDescription>
                  Float can only be spent on company work such as landlord payouts. It cannot be withdrawn afterwards.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-xl border border-border/60 bg-muted/40 p-3">
                    <p className="text-muted-foreground">Available now</p>
                    <p className="mt-0.5 font-bold text-foreground">{formatUGX(withdrawableBalance)}</p>
                  </div>
                  <div className="rounded-xl border border-border/60 bg-muted/40 p-3">
                    <p className="text-muted-foreground">Float now</p>
                    <p className="mt-0.5 font-bold text-foreground">{formatUGX(floatBalance)}</p>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground">Amount (UGX)</label>
                  <Input
                    inputMode="numeric"
                    value={amountText}
                    onChange={(e) => setAmountText(e.target.value.replace(/[^0-9]/g, ''))}
                    placeholder="e.g. 100000"
                    className="mt-1 text-lg font-bold"
                  />
                  <div className="mt-2 flex flex-wrap gap-2">
                    {QUICK_AMOUNTS.filter((a) => a <= withdrawableBalance).map((a) => (
                      <Button
                        key={a}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="text-[11px]"
                        onClick={() => setAmountText(String(a))}
                      >
                        {formatUGX(a)}
                      </Button>
                    ))}
                    {withdrawableBalance >= 1000 && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="text-[11px]"
                        onClick={() => setAmountText(String(Math.floor(withdrawableBalance)))}
                      >
                        All
                      </Button>
                    )}
                  </div>
                  {tooMuch && (
                    <p className="mt-2 text-[11px] font-medium text-destructive">
                      You only have {formatUGX(withdrawableBalance)} available.
                    </p>
                  )}
                  {!tooMuch && amount > 0 && amount < 1000 && (
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      The smallest amount you can move is {formatUGX(1000)}.
                    </p>
                  )}
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground">What is it for? (optional)</label>
                  <Input
                    value={note}
                    onChange={(e) => setNote(e.target.value.slice(0, 200))}
                    placeholder="e.g. Landlord payout in Kireka"
                    className="mt-1"
                  />
                </div>

                {amount >= 1000 && !tooMuch && (
                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs">
                    <div className="flex items-center gap-2 font-medium text-foreground">
                      <Wallet className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      After this move
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-muted-foreground">Your balance</span>
                      <span className="font-bold text-foreground">{formatUGX(withdrawableBalance - amount)}</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between">
                      <span className="text-muted-foreground">Float</span>
                      <span className="font-bold text-foreground">{formatUGX(floatBalance + amount)}</span>
                    </div>
                  </div>
                )}

                <Button className="w-full" disabled={!canSubmit} onClick={handleConvert}>
                  {submitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Moving…
                    </>
                  ) : (
                    `Move ${amount >= 1000 ? formatUGX(amount) : 'to Float'}`
                  )}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
