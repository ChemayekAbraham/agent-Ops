import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ArrowDownLeft, ArrowUpRight, Send } from 'lucide-react';
import DepositFlow from '@/components/payments/DepositFlow';
import WithdrawFlow from '@/components/payments/WithdrawFlow';
import { SendMoneyDialog } from '@/components/wallet/SendMoneyDialog';
import { hapticTap } from '@/lib/haptics';
import { usePayoutsUiEnabled } from '@/hooks/usePayoutsUiEnabled';

/**
 * Funder-only wallet actions: Deposit, Withdraw, Transfer.
 *
 * Wired strictly to the existing flows:
 *  - DepositFlow with `personal_deposit` purpose → funds land in the
 *    funder's withdrawable bucket (recipient_type=`user` per WALLET
 *    ROUTING v2), so they are immediately usable + withdrawable.
 *  - WithdrawFlow → goes through the strict ledger-backed
 *    `get_user_available_balance` gate, like every other role.
 *  - SendMoneyDialog → wallet-to-wallet transfer.
 *
 * This component MUST be rendered behind a `role === 'supporter'` (a.k.a.
 * Funder) gate by the caller; it does not gate itself.
 */
interface Props {
  availableBalance: number;
  roiBalance?: number;
  /** Called after any flow closes so caller can refresh wallet caches. */
  onChanged?: () => void;
  /**
   * `default` → standalone card (light surface).
   * `hero` → rendered inside the dark wallet hero card; uses translucent
   * surfaces so it sits cleanly under the "Invested" row.
   */
  variant?: 'default' | 'hero';
  /**
   * When true, the Deposit button gets a temporary primary-ring pulse to
   * draw attention (used right after the Funder activation modal closes).
   */
  highlightDeposit?: boolean;
}

export function FunderQuickActions({ availableBalance, roiBalance = 0, onChanged, variant = 'default', highlightDeposit = false }: Props) {
  const [showDeposit, setShowDeposit] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const { enabled: payoutsUiEnabled } = usePayoutsUiEnabled();

  const handleClose = (setter: (v: boolean) => void) => (open: boolean) => {
    setter(open);
    if (!open) onChanged?.();
  };

  const isHero = variant === 'hero';
  // On the dark purple wallet hero, force a clearly-visible frosted chip with
  // explicit white text/icons so labels never wash out on mobile (where the
  // ghost variant's faint fill made white-on-white text invisible).
  // Padding + gap scale with the viewport so the icon/label pair never touches
  // (or overflows) the button border on narrow phones. `min-w-0` lets the grid
  // column shrink, and the label truncates instead of pushing past the edge.
  const btnBase =
    'h-11 min-w-0 w-full justify-center gap-1 px-1.5 sm:gap-2 sm:px-3';
  const btnClass = isHero
    ? `${btnBase} rounded-xl bg-white/20 hover:bg-white/30 active:bg-white/30 backdrop-blur-sm border border-white/30 !text-white shadow-sm`
    : btnBase;
  const btnVariant = isHero ? 'ghost' as const : 'outline' as const;
  const depositHighlightClass = highlightDeposit
    ? ' ring-2 ring-primary ring-offset-2 ring-offset-background animate-pulse shadow-lg'
    : '';

  return (
    <>
      <div className="grid grid-cols-3 gap-1.5 sm:gap-2">
        <Button
          variant={btnVariant}
          className={btnClass + depositHighlightClass}
          onClick={() => { hapticTap(); setShowDeposit(true); }}
        >
          <ArrowDownLeft className={`w-3.5 h-3.5 shrink-0 ${isHero ? 'text-emerald-300' : 'text-success'}`} />
          <span className="font-semibold text-[9px] sm:text-[11px] truncate">Deposit</span>
        </Button>
        <Button
          variant={btnVariant}
          className={btnClass + (payoutsUiEnabled ? '' : ' opacity-50 cursor-not-allowed')}
          disabled={!payoutsUiEnabled}
          title={payoutsUiEnabled ? undefined : 'Withdrawals are temporarily disabled'}
          onClick={() => { hapticTap(); setShowWithdraw(true); }}
        >
          <ArrowUpRight className={`w-3.5 h-3.5 shrink-0 ${isHero ? 'text-rose-300' : 'text-destructive'}`} />
          <span className="font-semibold text-[9px] sm:text-[11px] truncate">Withdraw</span>
        </Button>
        <Button
          variant={btnVariant}
          className={btnClass}
          onClick={() => { hapticTap(); setShowTransfer(true); }}
        >
          <Send className={`w-3.5 h-3.5 shrink-0 ${isHero ? 'text-primary-foreground' : 'text-primary'}`} />
          <span className="font-semibold text-[9px] sm:text-[11px] truncate">Transfer</span>
        </Button>
      </div>

      <DepositFlow
        open={showDeposit}
        onOpenChange={handleClose(setShowDeposit)}
        walletBalance={availableBalance}
        allowedPurposes={['personal_deposit']}
        defaultPurpose="personal_deposit"
        lockPurpose
      />
      <WithdrawFlow
        open={showWithdraw}
        onOpenChange={handleClose(setShowWithdraw)}
        availableBalance={availableBalance}
        roiBalance={roiBalance}
        onSuccess={() => { setShowWithdraw(false); onChanged?.(); }}
      />
      <SendMoneyDialog
        open={showTransfer}
        onOpenChange={handleClose(setShowTransfer)}
      />
    </>
  );
}

export default FunderQuickActions;