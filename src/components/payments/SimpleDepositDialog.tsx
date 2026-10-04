import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, CheckCircle2, Wallet, Info } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { validateDepositReference } from '@/lib/depositReferenceValidator';
import { formatUGX } from '@/lib/rentCalculations';
import { safeDepositPurpose, type DepositPurpose } from '@/lib/depositPurposeGuard';

/**
 * Bare-minimum deposit flow for non-technical users.
 * Asks only:
 *   1. Amount (UGX)
 *   2. Transaction ID (MP… / TID… / FT…)
 *
 * Everything else is auto-derived:
 *   • Provider inferred from TID prefix (MP→MTN, TID→Airtel, FT→Bank)
 *   • Date/time = now
 *   • Purpose pinned by caller (defaults to 'personal_deposit')
 *   • No notes, no slip, no per-tenant breakdown
 *
 * The submitted row is a normal `deposit_requests` insert — Financial Ops
 * sees and approves it through the same pipeline as DepositFlow.
 */
interface SimpleDepositDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-pinned purpose. Defaults to 'personal_deposit'. */
  purpose?: DepositPurpose;
  /** Optional callback after a successful submit. */
  onSubmitted?: (depositId: string) => void;
}

function detectProvider(tid: string): 'mtn' | 'airtel' | 'bank' | null {
  const s = tid.toUpperCase().trim();
  if (/^MP\d{6,16}$/.test(s)) return 'mtn';
  if (/^TID\d{4,18}$/.test(s)) return 'airtel';
  if (/^FT[A-Z0-9]{6,18}$/.test(s)) return 'bank';
  return null;
}

const MIN_DEPOSIT = 500;
const MAX_DEPOSIT = 1_000_000_000;

export default function SimpleDepositDialog({
  open,
  onOpenChange,
  purpose = 'personal_deposit',
  onSubmitted,
}: SimpleDepositDialogProps) {
  const { user } = useAuth();
  const [amount, setAmount] = useState('');
  const [tid, setTid] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!open) {
      setAmount('');
      setTid('');
      setSubmitting(false);
      setDone(false);
    }
  }, [open]);

  const amountNum = Number(amount) || 0;
  const provider = useMemo(() => detectProvider(tid), [tid]);
  const normalizedTid = tid.toUpperCase().trim();
  const tidValid = provider !== null;
  const amountValid = amountNum >= MIN_DEPOSIT && amountNum <= MAX_DEPOSIT;
  const canSubmit = tidValid && amountValid && !submitting;

  const handleSubmit = async () => {
    if (!user?.id) {
      toast.error('Please sign in first');
      return;
    }
    if (!canSubmit || !provider) return;

    setSubmitting(true);
    try {
      // Pre-flight duplicate guard (same as DepositFlow).
      const dup = await validateDepositReference(normalizedTid);
      if (!dup.valid) {
        toast.error(dup.message || 'This transaction ID has already been used.');
        setSubmitting(false);
        return;
      }

      const now = new Date();
      const { data: inserted, error } = await supabase
        .from('deposit_requests')
        .insert({
          user_id: user.id,
          amount: amountNum,
          status: 'pending',
          provider,
          transaction_id: normalizedTid,
          transaction_date: now.toISOString(),
          notes: 'Submitted via simplified deposit',
          deposit_purpose: safeDepositPurpose(purpose),
          purpose_audit: {
            chosen_purpose: safeDepositPurpose(purpose),
            chosen_at: now.toISOString(),
            chosen_by: user.id,
            entry_point: 'simple_dialog',
            required_choice: false,
          },
        } as any)
        .select('id')
        .single();

      if (error) throw error;

      // Best-effort instant auto-verify (mirrors DepositFlow).
      // If a parsed MTN/Airtel Gmail receipt matches digits+amount,
      // `try_link_gmail_for_deposit` links it; we then invoke
      // `approve-deposit` with auto_approved:true so the deposit is
      // approved immediately without Financial Ops review.
      let autoApproved = false;
      try {
        const { data: linkRes } = await (supabase.rpc as any)(
          'try_link_gmail_for_deposit',
          { p_deposit_id: inserted.id },
        );
        const outcome = (linkRes as any)?.outcome;
        if (outcome === 'linked') {
          const { data: session } = await supabase.auth.getSession();
          const token = session?.session?.access_token;
          const { error: invErr } = await supabase.functions.invoke(
            'approve-deposit',
            {
              body: {
                deposit_request_id: inserted.id,
                action: 'approve',
                access_token: token,
                auto_approved: true,
                auto_match_method: 'tid',
              },
            },
          );
          if (!invErr) autoApproved = true;
        }
      } catch {
        // Non-fatal — Financial Ops will still see the pending row.
      }
      if (autoApproved) {
        toast.success('Deposit auto-verified ⚡', {
          description: 'We matched your MoMo receipt instantly.',
        });
      }

      setDone(true);
      toast.success('Deposit submitted — Financial Ops will verify shortly');
      onSubmitted?.(inserted.id);
      setTimeout(() => onOpenChange(false), 1400);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to submit deposit';
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-2">
          <DialogTitle className="flex items-center gap-2 text-xl font-bold">
            <Wallet className="h-5 w-5 text-primary" />
            Quick deposit
          </DialogTitle>
          <DialogDescription className="text-xs">
            Just the amount and your transaction ID. We'll handle the rest.
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="px-6 py-12 flex flex-col items-center text-center gap-3">
            <div className="h-16 w-16 rounded-full bg-emerald-500/10 flex items-center justify-center">
              <CheckCircle2 className="h-9 w-9 text-emerald-500" />
            </div>
            <p className="text-lg font-bold">Submitted</p>
            <p className="text-sm text-muted-foreground">
              {formatUGX(amountNum)} · {normalizedTid}
            </p>
          </div>
        ) : (
          <div className="px-6 py-5 space-y-5">
            <div>
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Amount (UGX)
              </Label>
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
                inputMode="numeric"
                placeholder="e.g. 50000"
                className="text-2xl font-bold mt-2 h-14"
                autoFocus
              />
            </div>

            <div>
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Transaction ID
              </Label>
              <Input
                value={tid}
                onChange={(e) => setTid(e.target.value.toUpperCase().replace(/\s+/g, ''))}
                placeholder="MP… or TID… or FT…"
                className="text-base font-mono mt-2 h-12 tracking-wider"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
              />
              <p className="text-[11px] text-muted-foreground mt-1.5">
                {provider === 'mtn' && '✓ MTN MoMo detected'}
                {provider === 'airtel' && '✓ Airtel Money detected'}
                {provider === 'bank' && '✓ Bank reference detected'}
                {tid && provider === null && (
                  <span className="text-destructive">
                    Must start with MP, TID, or FT
                  </span>
                )}
                {!tid && 'Copy the reference from your MoMo/bank SMS'}
              </p>
            </div>

            {/* Auto-verification policy notice */}
            <div className="flex items-start gap-2 p-2.5 rounded-lg border border-primary/20 bg-primary/5">
              <Info className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
              <p className="text-[11px] text-muted-foreground leading-snug">
                <span className="font-semibold text-foreground">Auto-verified deposits</span>{' '}
                are credited to your <span className="font-semibold text-foreground">Operational Float</span>{' '}
                wallet by default.
              </p>
            </div>

            <Button
              className="w-full h-14 text-base gap-2"
              size="lg"
              disabled={!canSubmit}
              onClick={handleSubmit}
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitting ? 'Submitting…' : 'Submit deposit'}
            </Button>

            <p className="text-[11px] text-center text-muted-foreground">
              Need to add a slip, notes, or split between tenants?{' '}
              <button
                type="button"
                className="text-primary underline font-medium"
                onClick={() => onOpenChange(false)}
              >
                Use full deposit
              </button>
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
