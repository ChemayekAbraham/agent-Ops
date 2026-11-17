import { useNavigate } from 'react-router-dom';
import { ChevronRight, Wallet } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';

/** Where the Welile wallet lives: the same card as the main dashboards, at the top of "Your Profile". */
const WALLET_PATH = '/your-profile';

/**
 * "Your wallet" on the Welile Schools role homes: one button that opens the Welile wallet
 * (balance, deposit / withdraw / transfer, statement). Visitors sign in first and land on it.
 */
export default function SchoolsWalletSection() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const open = () => navigate(user ? WALLET_PATH : `/auth?redirect=${encodeURIComponent(WALLET_PATH)}`);

  return (
    <button
      type="button"
      onClick={open}
      className="flex min-h-[64px] w-full items-center gap-3 rounded-3xl bg-gradient-to-br from-primary to-primary/80 p-4 text-left text-primary-foreground shadow-sm transition active:scale-[0.99]"
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary-foreground/15">
        <Wallet className="h-5 w-5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-base font-semibold">Your wallet</span>
        <span className="block text-xs text-primary-foreground/80">
          {user ? 'Balance, deposit, withdraw and statement' : 'Sign in to see your balance, deposit and withdraw'}
        </span>
      </span>
      <ChevronRight className="h-5 w-5 shrink-0 text-primary-foreground/80" aria-hidden />
    </button>
  );
}
