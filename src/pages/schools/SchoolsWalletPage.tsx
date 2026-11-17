import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Loader2, LogIn, Wallet } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useAgentBalances } from '@/hooks/useAgentBalances';
import { Button } from '@/components/ui/button';
import WelileSchoolsBrand from '@/components/welile-schools/WelileSchoolsBrand';
import { ProfileWalletCard } from '@/components/wallet/ProfileWalletCard';
import NationalIdPrompt from '@/components/wallet/NationalIdPrompt';
import { WalletPeriodStatementButton } from '@/components/wallet/WalletPeriodStatementButton';
import { WalletLedgerStatement } from '@/components/wallet/WalletLedgerStatement';
import { UserDepositRequests } from '@/components/wallet/UserDepositRequests';
import { UserWithdrawalRequests } from '@/components/wallet/UserWithdrawalRequests';
import { PaymentMethodIcons } from '@/components/wallet/PaymentMethodIcons';

const WALLET_PATH = '/schools/wallet';

/**
 * /schools/wallet — the Welile wallet inside Welile Schools: the same wallet card as the main
 * dashboards (always open, with deposit / withdraw / transfer), then the statement and any
 * deposits or withdrawals still being processed. Back returns to Welile Schools.
 */
export default function SchoolsWalletPage() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();

  return (
    <div className="min-h-screen bg-background pb-10">
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-xl items-center gap-2 px-3 py-2">
          <Button variant="ghost" size="icon" className="h-11 w-11 rounded-full" aria-label="Back to Welile Schools" onClick={() => navigate('/schools')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <WelileSchoolsBrand />
        </div>
      </header>

      <main className="mx-auto max-w-xl space-y-4 px-3 pt-3">
        <div className="flex items-center gap-2 px-1">
          <Wallet className="h-5 w-5 text-primary" aria-hidden />
          <h1 className="text-lg font-bold">Your wallet</h1>
        </div>

        {loading ? (
          <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
        ) : !user ? (
          <section className="space-y-3 rounded-3xl border border-border/60 bg-card p-4 shadow-sm">
            <p className="text-sm text-muted-foreground">Sign in to see your Welile wallet balance, deposit, withdraw and see your statement.</p>
            <Button className="min-h-[52px] w-full gap-2 rounded-2xl text-base" onClick={() => navigate(`/auth?redirect=${encodeURIComponent(WALLET_PATH)}`)}>
              <LogIn className="h-5 w-5" />Sign in
            </Button>
          </section>
        ) : (
          <SignedInWallet />
        )}
      </main>
    </div>
  );
}

function SignedInWallet() {
  const navigate = useNavigate();
  const { withdrawableBalance } = useAgentBalances();

  return (
    <>
      <ProfileWalletCard expanded />

      {/* National ID: required before any payout can be released (renders nothing once on file). */}
      <NationalIdPrompt withdrawableBalance={Math.max(0, withdrawableBalance)} />

      <section aria-labelledby="ws-wallet-statement" className="space-y-3 rounded-3xl border border-border/60 bg-card p-4 shadow-sm">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 id="ws-wallet-statement" className="text-base font-bold">Wallet statement</h2>
            <PaymentMethodIcons className="mt-2" />
          </div>
          <Button variant="ghost" size="sm" className="h-9 shrink-0 gap-1 rounded-full text-primary" onClick={() => navigate('/transactions')}>
            All transactions<ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        <WalletPeriodStatementButton />
        <WalletLedgerStatement />
      </section>

      {/* Deposits and withdrawals still being processed (each renders nothing when there are none). */}
      <UserDepositRequests />
      <UserWithdrawalRequests />
    </>
  );
}
