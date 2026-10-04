import { useState } from 'react';
import { Wallet, AlertTriangle, Hand, Smartphone, BadgeCheck, HandCoins, Signal, Flag, BatteryWarning } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { MerchantBalanceDisputeDialog } from './MerchantBalanceDisputeDialog';
import { useMyBalanceDisputes } from '@/hooks/useMerchantBalanceDisputes';
import { useAuth } from '@/hooks/useAuth';
import {
  useMerchantPayoutFloat,
  useMerchantFloatPositions,
  useMerchantOutOfPocket,
  useMerchantOutOfPocketRows,
} from '@/hooks/useMerchantFloat';

/**
 * Float available to pay out — the shared company payout pool (all withdrawable
 * wallet balances + agent landlord payout float, less payouts already claimed
 * and not yet settled), plus this merchant's own settlement position.
 *
 * Read-only display. Claiming and settling behave exactly as before.
 */
export function MerchantFloatAvailableCard() {
  const { user } = useAuth();
  const { data: pool, isLoading } = useMerchantPayoutFloat();
  const { data: positions } = useMerchantFloatPositions();
  const { data: oop } = useMerchantOutOfPocket();
  const { data: oopRows } = useMerchantOutOfPocketRows();
  const { data: myDisputes } = useMyBalanceDisputes();
  const [disputeOpen, setDisputeOpen] = useState(false);

  // Finance/manager roles receive every desk from the RPC, ordered by float size.
  // Always pin to the signed-in agent's own desk so the card never shows another
  // merchant's cash position.
  const mine =
    (user?.id ? positions?.find((p) => p.agentId === user.id) : undefined) ??
    (positions?.length === 1 ? positions[0] : undefined);
  const owed = mine?.owedToAgent ?? 0;
  const holding = mine?.ledgerFloatHeld ?? mine?.companyCashWithAgent ?? 0;
  // The float a merchant spends when they claim IS the company money already
  // sent to their MTN/Airtel line and not yet paid out, less what they have
  // already committed to payouts they claimed but have not settled.
  const reserved = pool?.ownReservedFloat ?? 0;
  // Headline mirrors the Financial Ops hero card: the shared company payout pool
  // (all withdrawable wallet balances + agent landlord payout float) less payouts
  // already claimed and not yet settled.
  const poolAvailable = pool?.availableFloat ?? 0;
  const spendable = Math.max(holding - reserved, 0);
  const offledger = mine?.offledgerAdjustments ?? 0;
  const unbacked = mine?.payoutsWithoutFloatEvidence ?? 0;
  const pending = (myDisputes ?? []).filter((d) => d.status === 'open' || d.status === 'reviewing');
  const lastAnswered = (myDisputes ?? []).find((d) => d.status === 'resolved' || d.status === 'rejected');

  return (
    <section className="rounded-3xl border border-border/60 bg-card p-5">
      <div className="flex items-center gap-2">
        <Wallet className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-bold">Float available to pay out</h3>
      </div>

      <p className="mt-3 font-mono text-2xl font-bold tabular-nums text-foreground break-all">
        {isLoading ? '—' : formatUGX(poolAvailable)}
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        This is the whole company payout pool — every withdrawable wallet balance plus agent landlord
        payout float, less payouts already claimed and not yet settled. It matches the Financial Ops
        figure.
        {' '}Of this, <span className="font-semibold text-foreground">{formatUGX(spendable)}</span> is
        company money already sent to your own MTN or Airtel line and still with you.
        {reserved > 0 && ` ${formatUGX(reserved)} is already committed to payouts you claimed but have not settled.`}
        {' '}If a payout is bigger than the float you hold, you can still pay it — the extra is
        recorded automatically as money Finance owes you. There is nothing for you to claim or
        confirm.
      </p>


      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-2xl border border-border/60 bg-muted/30 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Finance owes you
          </p>
          <p className="mt-1 font-mono text-base font-bold tabular-nums text-emerald-600 dark:text-emerald-400 break-all">
            {formatUGX(owed)}
          </p>
        </div>
        <div className="rounded-2xl border border-border/60 bg-muted/30 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            You have paid out
          </p>
          <p className="mt-1 font-mono text-base font-bold tabular-nums text-foreground break-all">
            {formatUGX(mine?.paidOut ?? 0)}
          </p>
        </div>
      </div>

      {holding > 0 ? (
        <div className="mt-3 rounded-2xl border-2 border-warning/50 bg-warning/10 p-4 text-center">
          <div className="flex items-center justify-center gap-2">
            <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
            <p className="text-[11px] font-bold uppercase tracking-wider text-warning">
              Company cash in your hands
            </p>
          </div>
          <p className="mt-2 font-mono text-3xl font-bold tabular-nums text-foreground break-all">
            {formatUGX(holding)}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            Company money sent to you and not yet paid out. Payouts you claim are taken from this
            first, and it drops each time you pay a request.
          </p>
        </div>
      ) : (
        !isLoading && (
          <div className="mt-3 rounded-2xl border-2 border-muted-foreground/30 bg-muted/30 p-4 text-center">
            <div className="flex items-center justify-center gap-2">
              <BatteryWarning className="h-4 w-4 text-muted-foreground shrink-0" />
              <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                Operational float is finished
              </p>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              You can still process pay-outs. Pay from your own MTN or Airtel line and Finance
              pays you back — every shilling you front is recorded for you automatically, never
              silent debt and never something you have to claim.
            </p>
          </div>
        )
      )}

      {mine?.clampedShortfall > 0 && (
        <div className="mt-3 rounded-2xl border-2 border-dashed border-destructive/60 bg-destructive/10 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-destructive">
            Hidden deficit on your desk
          </p>
          <p className="mt-1 font-mono text-lg font-bold tabular-nums text-destructive">
            {formatUGX(mine.clampedShortfall)}
          </p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Your true position is negative by this much — it can't show as a negative number, but this
            is real, not spendable float.
          </p>
        </div>
      )}

      {(offledger !== 0 || unbacked > 0) && (
        <div className="mt-3 rounded-2xl border border-border/60 bg-muted/20 p-3">
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            Kept separate on purpose
          </p>
          <div className="mt-2 space-y-1.5 text-[10px] leading-relaxed text-muted-foreground">
            {offledger !== 0 && (
              <p>
                <span className="font-mono font-semibold text-foreground">{formatUGX(offledger)}</span>{' '}
                of Finance corrections (starting balances, write-offs) are recorded on your desk but are
                not company cash you can pay out. They never add to the cash in your hands.
              </p>
            )}
            {unbacked > 0 && (
              <p>
                <span className="font-mono font-semibold text-foreground">{formatUGX(unbacked)}</span>{' '}
                of payouts you completed had no company cash behind them — that is your own money, tracked
                below, not company cash.
              </p>
            )}
          </div>
        </div>
      )}

      {/* CONFIRMED own money used beyond float — real company debt to the merchant. */}
      <div className="mt-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-3">
        <div className="flex items-center gap-2">
          <HandCoins className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
            Your own money — recorded (we pay this back)
          </p>
        </div>
        <p className="mt-1 font-mono text-lg font-bold tabular-nums text-emerald-700 dark:text-emerald-400 break-all">
          {formatUGX(oop?.owedToAgent ?? 0)}
        </p>
        <p className="text-[10px] text-muted-foreground">
          {(oop?.pendingCount ?? 0)} payout{(oop?.pendingCount ?? 0) === 1 ? '' : 's'} waiting to be paid back
          {(oop?.reimbursedTotal ?? 0) > 0 && ` · ${formatUGX(oop!.reimbursedTotal)} already paid back`}
        </p>
        {!!oopRows?.length && (
          <ul className="mt-2 space-y-1">
            {oopRows.filter((r) => r.status !== 'rejected').slice(0, 5).map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                <span className="truncate">
                  {new Date(r.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} ·{' '}
                  {r.kind === 'telecom' ? 'Telecom charge' : `Payout ${formatUGX(r.payoutAmount)}`}
                </span>
                <span className="font-mono font-semibold text-foreground shrink-0">
                  {formatUGX(r.shortfallAmount)}
                  {r.status === 'reimbursed' && ' ✓'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>


      {/* Telecom (MTN/Airtel) sending charges. */}
      <div className="mt-3 rounded-2xl border border-border/60 bg-muted/30 p-3">
        <div className="flex items-center gap-2">
          <Signal className="h-4 w-4 text-primary" />
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            Telecom sending charges
          </p>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <div>
            <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Today</p>
            <p className="font-mono text-sm font-bold tabular-nums text-foreground break-all">
              {formatUGX(oop?.telecomToday ?? 0)}
            </p>
          </div>
          <div>
            <p className="text-[9px] uppercase tracking-wider text-muted-foreground">This month</p>
            <p className="font-mono text-sm font-bold tabular-nums text-foreground break-all">
              {formatUGX(oop?.telecomMonth ?? 0)}
            </p>
          </div>
          <div>
            <p className="text-[9px] uppercase tracking-wider text-muted-foreground">All time</p>
            <p className="font-mono text-sm font-bold tabular-nums text-foreground break-all">
              {formatUGX(oop?.telecomTotal ?? 0)}
            </p>
          </div>
        </div>
        <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
          What MTN/Airtel charges you to send each payout. Your float covers this as part of the same
          debit as the payout itself, so a UGX 5,000 payout with a UGX 500 charge uses UGX 5,500 of
          float. Anything your float could not cover is recorded as money Finance owes you.
        </p>
      </div>

      <div className="mt-4 rounded-2xl border border-primary/20 bg-primary/5 p-3">
        <p className="text-[10px] font-bold uppercase tracking-wider text-primary">
          How you operate now
        </p>
        <ol className="mt-2 space-y-2">
          <li className="flex items-start gap-2 text-[11px] leading-relaxed text-foreground">
            <Hand className="h-3.5 w-3.5 shrink-0 text-primary mt-0.5" />
            <span><span className="font-semibold">Claim</span> a withdrawal request from the queue below — no float request, no waiting for the CFO.</span>
          </li>
          <li className="flex items-start gap-2 text-[11px] leading-relaxed text-foreground">
            <Smartphone className="h-3.5 w-3.5 shrink-0 text-primary mt-0.5" />
            <span><span className="font-semibold">Pay it out</span> from your own MTN or Airtel line and upload the proof.</span>
          </li>
          <li className="flex items-start gap-2 text-[11px] leading-relaxed text-foreground">
            <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-primary mt-0.5" />
            <span><span className="font-semibold">Get reimbursed</span> — Finance sends real money to your line and the provider message clears what you are owed.</span>
          </li>
        </ol>
      </div>

      <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
        You may only demand money you have already claimed and paid out. Real money sent to your MTN or
        Airtel line is recognised automatically from the provider messages.
      </p>

      {/* Report a wrong figure to Financial Ops. */}
      <div className="mt-4 rounded-2xl border border-border/60 bg-muted/20 p-3">
        <p className="text-[11px] leading-relaxed text-foreground">
          <span className="font-semibold">Do these figures not match what you really have?</span> Tell
          Finance in your own words and they will check and correct it.
        </p>
        <Button
          variant="outline"
          className="mt-2 w-full gap-2"
          onClick={() => setDisputeOpen(true)}
        >
          <Flag className="h-4 w-4" /> This is not what I have — ask Finance to fix it
        </Button>
        {pending.length > 0 && (
          <p className="mt-2 text-[10px] font-medium text-warning">
            {pending.length} request{pending.length === 1 ? '' : 's'} with Finance right now.
          </p>
        )}
        {pending.length === 0 && lastAnswered && (
          <p className="mt-2 text-[10px] text-muted-foreground">
            Last request {lastAnswered.status === 'resolved' ? 'was fixed' : 'was not accepted'}
            {lastAnswered.resolutionNote ? ` — ${lastAnswered.resolutionNote}` : ''}.
          </p>
        )}
      </div>

      <MerchantBalanceDisputeDialog
        open={disputeOpen}
        onOpenChange={setDisputeOpen}
        deskId={mine?.deskId ?? null}
        amounts={{
          owed_to_agent: owed,
          company_cash_with_agent: holding,
          paid_out: mine?.paidOut ?? 0,
          out_of_pocket: oop?.owedToAgent ?? 0,
          float_available: spendable,
        }}
      />
    </section>
  );
}
