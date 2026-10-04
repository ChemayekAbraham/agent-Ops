import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Lock, TrendingDown } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import {
  MERCHANT_ADJUSTMENT_LABELS,
  MerchantAdjustmentType,
  MerchantFloatPosition,
  useMerchantFloatAdjustments,
  useMerchantFloatLedgerVariance,
  usePostMerchantAdjustment,
  usePostMerchantOpeningFloatLedger,
  useSetMerchantDeskFloat,
  usePostMerchantFloatWritedown,
} from '@/hooks/useMerchantFloat';
import { useFinancialOpsEditAccess } from '@/hooks/useFinancialOpsEditAccess';

/**
 * Professional correction path for a single merchant agent's settlement
 * position. Nothing here touches wallets or the ledger — corrections are
 * recorded in `merchant_float_reconciliations` with a mandatory reason and are
 * folded into the position math by `get_merchant_float_positions()`.
 */
export function MerchantReconcileDialog({
  position,
  open,
  onOpenChange,
}: {
  position: MerchantFloatPosition | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [type, setType] = useState<MerchantAdjustmentType>('opening_balance');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  // Opening balances are ALWAYS recognised on the BOOKS: balanced legs (agent
  // float cash_in + platform cash_out) plus the float bucket moved by the sole
  // wallet writer. Board-only opening balances are no longer allowed — they
  // read as a false success because they can never move the float figure.
  const [postToLedger, setPostToLedger] = useState(true);
  const { data: history } = useMerchantFloatAdjustments(position?.deskId);
  const { data: variances } = useMerchantFloatLedgerVariance(open);
  const post = usePostMerchantAdjustment();
  const postLedger = usePostMerchantOpeningFloatLedger();
  const postWritedown = usePostMerchantFloatWritedown();
  const setFloat = useSetMerchantDeskFloat();
  const { canEdit: canEditFloat, readOnlyReason } = useFinancialOpsEditAccess();

  if (!position) return null;

  const truth = variances?.find((v) => v.deskId === position.deskId);
  const numericAmount = Number(amount.replace(/[^\d.-]/g, ''));
  // "Starting balance" is a TARGET, not an addition. The CFO types the figure
  // the agent actually holds and we post only the difference — up through the
  // opening-balance path, down through the evidenced write-down path. Typing
  // the same figure twice can no longer stack float.
  const targetMode = type === 'opening_balance' && postToLedger;
  const currentFloat = Math.max(position.companyCashWithAgent, 0);
  const targetDelta = targetMode ? Math.round(numericAmount) - currentFloat : 0;
  const ledgerMode = targetMode && targetDelta > 0;
  const writedownMode = type === 'evidenced_writedown';
  const evidenceOk = evidence.trim().length >= 20;
  const valid = targetMode
    ? Number.isFinite(numericAmount) &&
      numericAmount >= 0 &&
      reason.trim().length >= 10 &&
      evidenceOk
    :
    Number.isFinite(numericAmount) &&
    (ledgerMode || writedownMode ? numericAmount > 0 : numericAmount !== 0) &&
    reason.trim().length >= 10 &&
    (!writedownMode || evidenceOk) &&
    (!writedownMode || numericAmount <= position.companyCashWithAgent);
  const busy =
    post.isPending || postLedger.isPending || postWritedown.isPending || setFloat.isPending;

  // What a recorded fix can and cannot move. Every adjustment type folds into
  // `adjustments_total` (which moves "Money we paid them back" and "We owe
  // them"). NOTHING here can move "They're holding our money" or the board vs
  // books gap — both read the agent's ledger-backed float bucket directly.
  const signedAmount = type === 'payout_correction' ? -numericAmount : numericAmount;
  const projectedReimbursed = position.reimbursed + signedAmount;
  const projectedOwed = Math.max(position.paidOut - projectedReimbursed, 0);

  const submit = async () => {
    try {
      if (targetMode) {
        const res = await setFloat.mutateAsync({
          deskId: position.deskId,
          agentId: position.agentId,
          target: Math.round(numericAmount),
          reason,
          evidenceNote: evidence,
        });
        toast.success(
          res.no_op ? 'Float confirmed as evidenced' : 'Float set to the evidenced figure',
          {
            description: res.no_op
              ? `Float stays at ${formatUGX(
                  Number(res.float_after),
                )} — already what the books support. It is now recorded as evidenced, so no legacy or unverified float remains on this desk.`
              : `Float is now exactly ${formatUGX(Number(res.float_after))} (was ${formatUGX(
                  Number(res.float_before),
                )}). Balanced entries of ${formatUGX(
                  Math.abs(Number(res.delta)),
                )} were posted (money in and money out) and the agent's float cache was re-seeded to match.`,
          },
        );
        setAmount('');
        setReason('');
        setEvidence('');
        onOpenChange(false);
        return;
      }
      if (writedownMode) {
        const res = await postWritedown.mutateAsync({
          deskId: position.deskId,
          agentId: position.agentId,
          adjustmentType: 'evidenced_writedown',
          amount: numericAmount,
          reason,
          evidenceNote: evidence,
        });
        toast.success('Written down on the books', {
          description: `Float is now ${formatUGX(Number(res.float_after))} (was ${formatUGX(
            Number(res.float_before),
          )}). Ledger group ${String(res.ledger_group_id).slice(0, 8)}. This entry is permanent.`,
        });
        setAmount('');
        setReason('');
        setEvidence('');
        onOpenChange(false);
        return;
      }
      const row = await post.mutateAsync({
        deskId: position.deskId,
        agentId: position.agentId,
        adjustmentType: type,
        amount: numericAmount,
        reason,
        evidenceNote: evidence,
      });
      if (!row?.id) {
        toast.error('The fix was not saved. Nothing changed.');
        return;
      }
      toast.success('Fix recorded', {
        description: `We owe them is now ${formatUGX(projectedOwed)}. "They're holding our money" (${formatUGX(
          position.companyCashWithAgent,
        )}) is unchanged — that figure comes from the books, not from fixes.`,
      });
      setAmount('');
      setReason('');
      setEvidence('');
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e?.message || 'Could not record the correction');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">
            Fix balance for {position.agentName || position.label || 'this agent'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            This only fixes what the board shows for this agent. It does not move any real money or
            change their wallet. The books stay the truth.
          </DialogDescription>
        </DialogHeader>

        {!canEditFloat && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2">
            <p className="text-[11px] font-semibold text-destructive">Read-only</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">{readOnlyReason}</p>
          </div>
        )}

        {truth && (
          <div
            className={`rounded-lg border px-3 py-2 ${
              truth.varianceState === 'aligned'
                ? 'border-border bg-muted/20'
                : 'border-destructive/40 bg-destructive/5'
            }`}
          >
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Float held: board vs books
            </p>
            <div className="mt-1 grid grid-cols-3 gap-2 text-[11px]">
              <Stat label="Board" value={truth.storedFloat} />
              <Stat label="Books" value={truth.ledgerFloat} />
              <Stat label="Gap" value={truth.variance} muted={truth.varianceState === 'aligned'} />
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">
              {truth.varianceState === 'aligned'
                ? 'The board matches the books for this agent.'
                : 'The board does not match the books. A fix here will NOT close this gap — the books have to be corrected.'}
            </p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <Stat label="Money they paid out" value={position.paidOut} />
          <Stat label="Money we paid them back" value={position.reimbursed} />
          <Stat label="Float we sent them" value={position.floatCredits} />
          <Stat label="Payment messages matched" value={position.emailMatched} muted />
          <Stat label="Fixes already made" value={position.adjustments} muted />
          <Stat
            label={position.companyCashWithAgent > 0 ? "They're holding our money" : 'We owe them'}
            value={position.companyCashWithAgent > 0 ? position.companyCashWithAgent : position.owedToAgent}
          />
        </div>

        <div className="space-y-3 pt-2">
          <div>
            <Label className="text-xs">What kind of fix</Label>
            <Select value={type} onValueChange={(v) => setType(v as MerchantAdjustmentType)}>
              <SelectTrigger className="mt-1 h-9 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(MERCHANT_ADJUSTMENT_LABELS) as MerchantAdjustmentType[]).map((k) => (
                  <SelectItem key={k} value={k} className="text-xs">
                    {MERCHANT_ADJUSTMENT_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="text-xs">
              {targetMode ? 'Float the agent actually holds now (UGX)' : 'Amount (UGX)'}
            </Label>
            <Input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="numeric"
              placeholder={targetMode ? `Now on the books: ${currentFloat}` : 'e.g. 2500000'}
              className="mt-1 h-9 text-sm"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              {type === 'payout_correction'
                ? 'Lowers what we count as paid out by this agent.'
                : type === 'opening_balance'
                  ? `This is the FINAL figure, not an addition. Their float on the books becomes exactly this number — we only post the difference from ${formatUGX(currentFloat)}. Entering the same figure twice cannot double it.`
                  : type === 'evidenced_writedown'
                    ? "Reduces the agent's float on the books to the amount actually seen with them. Enter the amount to SUBTRACT."
                    : type === 'write_off'
                      ? 'Closes the balance we agreed to let go with this agent.'
                      : 'Adds to the money we already count as paid back to this agent.'}{' '}
              {targetMode
                ? ''
                : writedownMode
                ? 'Must be a positive amount — to reduce float, use CFO Direct Debit.'
                : 'Use a minus amount to undo an earlier fix.'}
            </p>
            {targetMode && targetDelta === 0 && numericAmount >= 0 && amount.trim() !== '' && (
              <p className="mt-1 text-[10px] font-medium text-muted-foreground">
                Already {formatUGX(currentFloat)} on the books — submitting still confirms this
                figure as evidenced and clears any legacy / unverified float on this desk.
              </p>
            )}
            {targetMode && !evidenceOk && (
              <p className="mt-1 text-[10px] font-medium text-destructive">
                Evidence is required below: what you saw on their phone and when.
              </p>
            )}
            {writedownMode && numericAmount > position.companyCashWithAgent && (
              <p className="mt-1 text-[10px] font-medium text-destructive">
                Cannot exceed the float on the books ({formatUGX(position.companyCashWithAgent)}).
              </p>
            )}
          </div>

          {writedownMode && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2">
              <TrendingDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
              <span className="text-[11px] leading-snug">
                <span className="font-semibold text-foreground">
                  Permanent, ledger-backed write-down
                </span>
                <span className="block text-[10px] text-muted-foreground">
                  Posts real balanced entries (agent float out, company in) and lowers their float
                  through the normal wallet writer. Only the CFO, Financial Ops or a super admin can
                  post it, never on their own desk, and it can only ever be answered by another
                  equally evidenced entry — never edited or deleted.
                </span>
              </span>
            </div>
          )}

          {type === 'opening_balance' && (
            <div className="flex items-start gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="text-[11px] leading-snug">
                <span className="font-semibold text-foreground">
                  Recorded on the books — required
                </span>
                <span className="block text-[10px] text-muted-foreground">
                  You type the figure their float should END at. We post only the difference — up
                  through balanced float legs, down through an evidenced write-down — so repeating
                  the same figure never stacks their balance.
                </span>
              </span>
            </div>
          )}

          <div>
            <Label className="text-xs">Why (at least 10 letters)</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Why you are making this fix"
              className="mt-1 text-sm"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">{reason.trim().length}/10</p>
          </div>

          <div>
            <Label className="text-xs">
              {writedownMode || targetMode
                ? 'Evidence (required — at least 20 letters)'
                : 'Proof (optional)'}
            </Label>
            <Input
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              placeholder={
                writedownMode || targetMode
                  ? 'Which agent, what was on their phone (balance / screenshot ref / TID), date & time checked'
                  : 'MoMo transaction ID, statement line, or approval note'
              }
              className="mt-1 h-9 text-sm"
            />
            {(writedownMode || targetMode) && (
              <p className="mt-1 text-[10px] text-muted-foreground">
                {evidence.trim().length}/20 — name the agent, the balance or screenshot reference or
                provider TID, and the date and time it was checked.
              </p>
            )}
          </div>

          <Button onClick={submit} disabled={!valid || busy || !canEditFloat} className="w-full">
            {busy
              ? 'Saving…'
              : targetMode
                ? `Set float to ${amount.trim() ? formatUGX(Math.round(numericAmount) || 0) : '—'}`
                : writedownMode
                ? 'Post write-down to the books'
                : ledgerMode
                  ? 'Post to the books'
                  : 'Save fix'}
          </Button>

          {valid && targetMode && (
            <div className="rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 space-y-1">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                What this will change
              </p>
              <p className="text-[11px] text-foreground">
                Float on the books: {formatUGX(currentFloat)} →{' '}
                <span className="font-semibold">{formatUGX(Math.round(numericAmount))}</span>
              </p>
              <p className="text-[10px] text-muted-foreground">
                Balanced ledger legs record the difference against the books, then the shown balance
                is cleared to exactly this figure — no leftover "cache exceeds the books" gap.
              </p>
            </div>
          )}

          {valid && writedownMode && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 space-y-1">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                What this will change
              </p>
              <p className="text-[11px] text-foreground">
                They're holding our money: {formatUGX(position.companyCashWithAgent)} →{' '}
                <span className="font-semibold">
                  {formatUGX(Math.max(position.companyCashWithAgent - Math.round(numericAmount), 0))}
                </span>
              </p>
              <p className="text-[10px] text-muted-foreground">
                Two balanced legs are posted (their float out, company in) and their float balance
                drops for real through the normal wallet writer. Permanent once posted.
              </p>
            </div>
          )}

          {valid && !targetMode && !writedownMode && (
            <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 space-y-1">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                What this fix will change
              </p>
              <p className="text-[11px] text-foreground">
                Money we paid them back: {formatUGX(position.reimbursed)} →{' '}
                <span className="font-semibold">{formatUGX(projectedReimbursed)}</span>
              </p>
              <p className="text-[11px] text-foreground">
                We owe them: {formatUGX(Math.max(position.paidOut - position.reimbursed, 0))} →{' '}
                <span className="font-semibold">{formatUGX(projectedOwed)}</span>
              </p>
              <p className="text-[10px] text-muted-foreground">
                Will NOT change: "They're holding our money" ({formatUGX(position.companyCashWithAgent)})
                or the board vs books gap. Those come from the agent's float in the books and can only
                be corrected on the books.
              </p>
            </div>
          )}
        </div>

        {!!history?.length && (
          <div className="border-t border-border pt-3 space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Past fixes
            </p>
            {history.map((h) => (
              <div key={h.id} className="rounded-lg border border-border bg-muted/20 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-medium text-foreground truncate">
                    {MERCHANT_ADJUSTMENT_LABELS[h.adjustment_type as MerchantAdjustmentType] ??
                      h.adjustment_type}
                  </p>
                  <p className="font-mono text-[11px] font-bold tabular-nums shrink-0">
                    {formatUGX(Number(h.amount))}
                  </p>
                </div>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {new Date(h.created_at).toLocaleString()} · {h.reason}
                </p>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-2">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p
        className={`mt-0.5 font-mono text-xs font-bold tabular-nums break-all ${
          muted ? 'text-muted-foreground' : 'text-foreground'
        }`}
      >
        {formatUGX(value)}
      </p>
    </div>
  );
}
