import { useEffect, useState, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { HandCoins, ShieldCheck, Clock, Wallet, ArrowRight } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { normalizeAiId, isValidAiId } from '@/lib/welileAiId';

const BorrowLoanSheet = lazy(() => import('@/components/vouch/borrower/BorrowLoanSheet'));

/**
 * Public landing page for a Lending Agent's shared borrower link (/borrow/:aiId).
 * Signed-out visitors are sent to auth and returned here; signed-in visitors get
 * the borrow request sheet pre-targeted at that lending agent.
 */
export default function BorrowFromAgent() {
  const { aiId } = useParams<{ aiId: string }>();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  const cleanedAiId = normalizeAiId(aiId ?? '');
  const valid = isValidAiId(cleanedAiId);

  const [lenderName, setLenderName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    document.title = 'Request a loan on Welile';
    if (!valid) { setLoading(false); return; }
    (async () => {
      const { data } = await (supabase.rpc('get_public_trust_profile', { p_ai_id: cleanedAiId }) as any);
      const profile = data as any;
      setLenderName(profile?.identity?.full_name ?? null);
      setLoading(false);
    })();
  }, [cleanedAiId, valid]);

  const start = () => {
    if (!user) {
      navigate(`/auth?redirect=${encodeURIComponent(`/borrow/${cleanedAiId}`)}`);
      return;
    }
    setSheetOpen(true);
  };

  if (!valid) {
    return (
      <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col items-center justify-center px-5 text-center">
        <h1 className="text-lg font-bold">This borrowing link is not valid</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Ask the lending agent to send you their link again.
        </p>
        <Button className="mt-5 h-11 rounded-2xl" onClick={() => navigate('/')}>Go to Welile</Button>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-[100dvh] max-w-md px-5 pb-16 pt-10">
      <div className="flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-emerald-500">
          <HandCoins className="h-6 w-6 text-primary-foreground" />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Welile Lending Agent
          </p>
          {loading ? (
            <Skeleton className="mt-1 h-5 w-40" />
          ) : (
            <h1 className="truncate text-lg font-bold leading-tight">
              {lenderName ?? cleanedAiId}
            </h1>
          )}
        </div>
      </div>

      <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
        {lenderName ?? 'This agent'} lends money through Welile. Send your loan request here — the
        amount, how long you need it, and what it is for — and you get a decision inside the app.
      </p>

      <div className="mt-6 space-y-2.5">
        {[
          { Icon: Clock, title: 'Fast decisions', body: 'Your request lands directly in the agent’s dashboard.' },
          { Icon: Wallet, title: 'Repay from your wallet', body: 'Installments are pulled automatically on schedule.' },
          { Icon: ShieldCheck, title: 'Recorded and protected', body: 'Every loan is tracked on your Welile trust profile.' },
        ].map(({ Icon, title, body }) => (
          <Card key={title} className="rounded-2xl border-border/60">
            <CardContent className="flex items-start gap-3 p-3.5">
              <Icon className="mt-0.5 h-4.5 w-4.5 shrink-0 text-primary" />
              <div>
                <p className="text-sm font-semibold leading-tight">{title}</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{body}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Button
        className="mt-7 h-12 w-full rounded-2xl text-sm font-semibold"
        onClick={start}
        disabled={authLoading}
      >
        Request a loan <ArrowRight className="ml-1.5 h-4 w-4" />
      </Button>
      {!user && (
        <p className="mt-2 text-center text-[11px] text-muted-foreground">
          You will sign in or create a free Welile account first.
        </p>
      )}

      {sheetOpen && (
        <Suspense fallback={null}>
          <BorrowLoanSheet
            open={sheetOpen}
            onOpenChange={setSheetOpen}
            initialLenderAiId={cleanedAiId}
          />
        </Suspense>
      )}
    </main>
  );
}
