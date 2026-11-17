import { useNavigate } from 'react-router-dom';
import { LogIn, Wallet } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { ProfileWalletCard } from '@/components/wallet/ProfileWalletCard';
import type { SchoolsRole } from '@/lib/welileSchoolsHome';

/**
 * "Your wallet" on the Welile Schools role homes: the same wallet card (balance, full wallet sheet,
 * deposit / withdraw / transfer) as the main Welile dashboards. Visitors get a sign-in prompt that
 * brings them back to the same role page.
 */
export default function SchoolsWalletSection({ role }: { role: SchoolsRole }) {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  return (
    <section aria-labelledby="ws-wallet" className="space-y-2">
      <h2 id="ws-wallet" className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Your wallet</h2>
      {loading ? null : user ? (
        <ProfileWalletCard />
      ) : (
        <div className="flex items-center gap-3 rounded-3xl border border-border/70 bg-card p-4 shadow-sm">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Wallet className="h-5 w-5" aria-hidden /></span>
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">Sign in to see your Welile wallet balance, deposit and withdraw.</p>
          <Button size="sm" className="h-10 shrink-0 gap-1.5 rounded-full" onClick={() => navigate(`/auth?redirect=${encodeURIComponent(`/schools?role=${role}`)}`)}>
            <LogIn className="h-4 w-4" aria-hidden />Sign in
          </Button>
        </div>
      )}
    </section>
  );
}
