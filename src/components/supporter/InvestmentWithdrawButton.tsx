import { useState, useEffect, useMemo } from 'react';
import { LogOut, Clock, AlertTriangle, PauseCircle, CalendarCheck, TrendingDown, Shield } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import { useDeployedCapital } from '@/hooks/useDeployedCapital';
import { format, differenceInDays, differenceInHours } from 'date-fns';
import { Progress } from '@/components/ui/progress';
import { motion } from 'framer-motion';

export function InvestmentWithdrawButton() {
  const { user } = useAuth();
  const { deployedCapital, loading: capitalLoading } = useDeployedCapital(user?.id);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const [existingRequest, setExistingRequest] = useState<{
    amount: number;
    status: string;
    earliest_process_date: string;
    created_at: string;
    requested_at: string;
    partner_ops_approved_at: string | null;
    coo_approved_at: string | null;
    cfo_processed_at: string | null;
  } | null>(null);

  const amountNum = Number(amount) || 0;
  const maxWithdrawable = deployedCapital;

  const quickChips = useMemo(() => {
    if (maxWithdrawable <= 0) return [];
    return [
      { label: '25%', value: Math.floor(maxWithdrawable * 0.25) },
      { label: '50%', value: Math.floor(maxWithdrawable * 0.5) },
      { label: '75%', value: Math.floor(maxWithdrawable * 0.75) },
      { label: '100%', value: maxWithdrawable },
    ].filter(c => c.value > 0);
  }, [maxWithdrawable]);

  useEffect(() => {
    if (!user) return;
    const fetchExisting = async () => {
      const { data } = await supabase
        .from('investment_withdrawal_requests')
        .select('amount, status, earliest_process_date, created_at, requested_at, partner_ops_approved_at, coo_approved_at, cfo_processed_at')
        .eq('user_id', user.id)
        .in('status', ['pending', 'partner_ops_approved', 'coo_approved', 'approved'])
        .order('created_at', { ascending: false })
        .limit(1);
      if (data && data.length > 0) {
        setExistingRequest(data[0]);
      }
    };
    fetchExisting();
  }, [user]);

  const handleSubmit = async () => {
    if (!user || amountNum <= 0) return;

    if (amountNum > maxWithdrawable) {
      toast.error('Amount exceeds deployed capital', {
        description: `You can withdraw up to ${formatUGX(maxWithdrawable)}.`,
      });
      return;
    }

    setSubmitting(true);
    try {
      const { error } = await supabase
        .from('investment_withdrawal_requests')
        .insert({
          user_id: user.id,
          amount: amountNum,
          reason: reason.trim() || null,
          rewards_paused: true,
        });

      if (error) throw error;

      const processDate = new Date();
      processDate.setDate(processDate.getDate() + 90);

      setExistingRequest({
        amount: amountNum,
        status: 'pending',
        earliest_process_date: processDate.toISOString(),
        created_at: new Date().toISOString(),
        requested_at: new Date().toISOString(),
        partner_ops_approved_at: null,
        coo_approved_at: null,
        cfo_processed_at: null,
      });

      toast.success('⏳ Awaiting Approval', {
        description: `Your withdrawal of ${formatUGX(amountNum)} has been submitted and is awaiting approval. You'll be notified once reviewed.`,
        duration: 6000,
      });

      setAmount('');
      setReason('');
      setStep('form');
      setOpen(false);
    } catch (err: any) {
      console.error('[InvestmentWithdrawButton] Error:', err);
      toast.error('Request failed', {
        description: err?.message || 'Please try again.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  // ─── Active withdrawal tracker ───
  if (existingRequest) {
    const payoutDate = new Date(existingRequest.earliest_process_date);
    const createdDate = new Date(existingRequest.created_at);
    const now = new Date();
    const totalDays = 90;
    const daysPassed = Math.min(totalDays, Math.max(0, differenceInDays(now, createdDate)));
    const daysRemaining = Math.max(0, differenceInDays(payoutDate, now));
    const hoursRemaining = Math.max(0, differenceInHours(payoutDate, now) % 24);
    const progressPct = Math.min(100, (daysPassed / totalDays) * 100);
    const isReady = daysRemaining <= 0;

    return (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-xl border-2 border-amber-500/30 bg-amber-500/5 p-4 space-y-3"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <PauseCircle className="h-5 w-5 text-amber-600" />
            <p className="text-sm font-bold text-amber-700 dark:text-amber-400">
              {isReady ? 'Ready for Payout' : 'Capital Withdrawal In Progress'}
            </p>
          </div>
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full capitalize ${
            existingRequest.status === 'approved'
              ? 'bg-success/10 text-success'
              : 'bg-amber-500/10 text-amber-600'
          }`}>
            {existingRequest.status}
          </span>
        </div>

        <div className="text-center py-2">
          {isReady ? (
            <p className="text-2xl font-black text-success">✅ Ready</p>
          ) : (
            <div className="flex items-baseline justify-center gap-1">
              <span className="text-3xl font-black text-foreground">{daysRemaining}</span>
              <span className="text-sm text-muted-foreground font-semibold">days</span>
              <span className="text-lg font-bold text-muted-foreground/60 ml-1">{hoursRemaining}h</span>
              <span className="text-xs text-muted-foreground">remaining</span>
            </div>
          )}
        </div>

        <div className="space-y-1">
          <Progress value={progressPct} className="h-2" />
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>{format(createdDate, 'MMM d')}</span>
            <span className="font-bold">{Math.round(progressPct)}% collected</span>
            <span>{format(payoutDate, 'MMM d, yyyy')}</span>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Amount</span>
            <span className="font-bold text-foreground">{formatUGX(existingRequest.amount)}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground flex items-center gap-1">
              <CalendarCheck className="h-3.5 w-3.5" />
              Payout Date
            </span>
            <span className="font-bold text-foreground">{format(payoutDate, 'MMMM d, yyyy')}</span>
          </div>
        </div>

        <div className="px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/20">
          <p className="text-xs text-destructive font-semibold flex items-center gap-1.5">
            <PauseCircle className="h-3.5 w-3.5 shrink-0" />
            Monthly rewards are PAUSED until payout is processed
          </p>
        </div>

        <div className="pt-1 text-center">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 200, damping: 15 }}
            className="mx-auto w-14 h-14 rounded-full bg-gradient-to-br from-success/20 to-success/5 flex items-center justify-center mb-2"
          >
            <CalendarCheck className="h-7 w-7 text-success" />
          </motion.div>
          <p className="text-sm text-muted-foreground">
            ⏳ Awaiting approval — you'll be notified once each stage is complete. Thank you for your patience!
          </p>
        </div>

        <div className="flex items-start gap-2 px-1">
          <Shield className="h-3 w-3 text-muted-foreground mt-0.5 shrink-0" />
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Your capital is deployed to tenants' rent. The 90-day notice allows Welile agents to collect repayments 
            from tenants so your full amount is available for payout.
          </p>
        </div>
      </motion.div>
    );
  }

  // ─── Request button + sheet ───
  return (
    <>
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        disabled={capitalLoading || maxWithdrawable <= 0}
        className="w-full gap-2 rounded-xl font-bold h-10 text-sm border-border/60 text-muted-foreground"
      >
        <LogOut className="h-4 w-4" />
        Withdraw Capital
      </Button>

      <Sheet open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setStep('form'); } }}>
        <SheetContent side="bottom" className="h-[85vh] rounded-t-2xl px-0">
          <SheetHeader className="px-4 pb-2">
            <SheetTitle className="flex items-center gap-2 text-base">
              <LogOut className="h-5 w-5 text-primary" />
              Capital Withdrawal
            </SheetTitle>
          </SheetHeader>

          <div className="overflow-y-auto flex-1 px-4 pb-8" style={{ maxHeight: 'calc(85vh - 60px)' }}>
            <div className="space-y-4">
              {step === 'form' ? (
                <>
                  {/* Deployed capital summary */}
                  <div className="px-4 py-3 rounded-xl bg-primary/5 border border-primary/20 space-y-1">
                    <p className="text-xs text-muted-foreground font-semibold">Your Deployed Capital</p>
                    <p className="text-xl font-black text-foreground">{formatUGX(maxWithdrawable)}</p>
                    <p className="text-[10px] text-muted-foreground">
                      This is the total amount currently supporting tenants' rent.
                    </p>
                  </div>

                  {/* 90-day notice info */}
                  <div className="px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/30 space-y-2">
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-amber-600" />
                      <p className="text-sm font-bold text-amber-700 dark:text-amber-400">90-Day Notice Period</p>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Because your capital is deployed to active tenant rent, a <span className="font-bold">90-day collection period</span> is 
                      required for agents to recover funds from tenants.
                    </p>
                  </div>

                  {/* Rewards pause warning */}
                  <div className="px-4 py-3 rounded-xl bg-destructive/10 border border-destructive/20 space-y-2">
                    <div className="flex items-center gap-2">
                      <TrendingDown className="h-4 w-4 text-destructive" />
                      <p className="text-sm font-bold text-destructive">Rewards Will Be Paused</p>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Your <span className="font-bold">monthly rewards stop immediately</span> on the withdrawn portion 
                      once this request is submitted.
                    </p>
                  </div>

                  {/* Amount input */}
                  <div className="space-y-2">
                    <label className="text-sm font-bold text-foreground">Withdrawal Amount (UGX)</label>
                    <Input
                      type="number"
                      inputMode="numeric"
                      placeholder="e.g. 500000"
                      value={amount}
                      onChange={e => setAmount(e.target.value)}
                      className="text-lg font-bold h-12"
                    />
                    {amountNum > maxWithdrawable && (
                      <p className="text-xs text-destructive font-semibold">
                        Exceeds your deployed capital of {formatUGX(maxWithdrawable)}
                      </p>
                    )}
                  </div>

                  {/* Quick amount chips */}
                  {quickChips.length > 0 && (
                    <div className="flex gap-2 flex-wrap">
                      {quickChips.map(chip => (
                        <Button
                          key={chip.label}
                          type="button"
                          variant={amountNum === chip.value ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => setAmount(String(chip.value))}
                          className="text-xs rounded-full h-8 px-3"
                        >
                          {chip.label}
                        </Button>
                      ))}
                    </div>
                  )}

                  {/* Reason */}
                  <div className="space-y-1.5">
                    <label className="text-sm font-bold text-foreground">Reason (optional)</label>
                    <Textarea
                      placeholder="Why are you withdrawing?"
                      value={reason}
                      onChange={e => setReason(e.target.value)}
                      className="text-sm min-h-[60px]"
                    />
                  </div>

                  <Button
                    onClick={() => setStep('confirm')}
                    disabled={amountNum <= 0 || amountNum > maxWithdrawable}
                    className="w-full gap-2 rounded-xl font-bold h-12 text-base"
                  >
                    Review Withdrawal
                  </Button>
                </>
              ) : (
                /* ─── Confirmation preview step ─── */
                <motion.div
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="space-y-4"
                >
                  <div className="text-center py-2">
                    <div className="mx-auto w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center mb-2">
                      <AlertTriangle className="h-6 w-6 text-amber-600" />
                    </div>
                    <p className="text-sm font-bold text-foreground">Confirm Your Withdrawal</p>
                    <p className="text-xs text-muted-foreground mt-1">Please review the details below</p>
                  </div>

                  <div className="rounded-xl border border-border bg-muted/30 divide-y divide-border">
                    <div className="flex justify-between items-center px-4 py-3">
                      <span className="text-xs text-muted-foreground">Amount</span>
                      <span className="text-base font-black text-foreground">{formatUGX(amountNum)}</span>
                    </div>
                    <div className="flex justify-between items-center px-4 py-3">
                      <span className="text-xs text-muted-foreground">Notice Period</span>
                      <span className="text-sm font-bold text-foreground">90 days</span>
                    </div>
                    <div className="flex justify-between items-center px-4 py-3">
                      <span className="text-xs text-muted-foreground">Estimated Payout</span>
                      <span className="text-sm font-bold text-foreground">
                        {format(new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), 'MMM d, yyyy')}
                      </span>
                    </div>
                    <div className="flex justify-between items-center px-4 py-3">
                      <span className="text-xs text-muted-foreground">Rewards Impact</span>
                      <span className="text-xs font-bold text-destructive">Paused immediately</span>
                    </div>
                    {reason.trim() && (
                      <div className="px-4 py-3">
                        <span className="text-xs text-muted-foreground block mb-1">Reason</span>
                        <span className="text-xs text-foreground">{reason.trim()}</span>
                      </div>
                    )}
                  </div>

                  <div className="flex items-start gap-2 px-1">
                    <Shield className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                    <p className="text-[10px] text-muted-foreground">
                      By confirming, you acknowledge the 90-day notice period and that rewards will 
                      <strong> stop immediately</strong> on the withdrawn amount.
                    </p>
                  </div>

                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={() => setStep('form')}
                      className="flex-1 rounded-xl font-bold h-12 text-base"
                      disabled={submitting}
                    >
                      Back
                    </Button>
                    <Button
                      onClick={handleSubmit}
                      disabled={submitting}
                      className="flex-1 gap-2 rounded-xl font-bold h-12 text-base"
                    >
                      {submitting ? 'Submitting…' : 'Confirm Withdrawal'}
                    </Button>
                  </div>
                </motion.div>
              )}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
