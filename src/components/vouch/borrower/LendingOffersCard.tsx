import { useEffect, useState, lazy, Suspense } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { HandCoins, Info } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';

const BorrowLoanSheet = lazy(() => import('./BorrowLoanSheet'));

interface OfferRow {
  id: string;
  lender_display_name: string | null;
  title: string;
  min_amount_ugx: number;
  max_amount_ugx: number;
  interest_rate_pct: number;
  max_duration_days: number;
}

/** Borrower home: a short list of active lending offers with a clear "Request" button. */
export function LendingOffersCard({ userId }: { userId: string }) {
  const [offers, setOffers] = useState<OfferRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const { data } = await (supabase
        .from('lending_agent_offers' as any)
        .select('id, lender_display_name, title, min_amount_ugx, max_amount_ugx, interest_rate_pct, max_duration_days')
        .eq('active', true)
        .neq('lender_agent_id', userId)
        .order('created_at', { ascending: false })
        .limit(3) as any);
      if (!cancelled) {
        setOffers((data as OfferRow[]) ?? []);
        setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  if (!userId || !loaded) return null;

  // Helpful empty state: explain why there are no offers and what to do next.
  if (offers.length === 0) {
    return (
      <>
        <Card className="border-dashed">
          <CardContent className="p-3.5 space-y-2">
            <p className="flex items-center gap-1.5 text-sm font-bold">
              <HandCoins className="h-4 w-4 text-primary" /> Loan offers for you
            </p>
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              No lending agents have published an offer right now. Agents publish offers when they have money ready to lend — new ones appear here automatically.
            </p>
            <p className="text-xs text-muted-foreground">
              In the meantime, you can request a specific agent directly using their Welile AI ID (e.g. WEL-AB12CD), or check again later.
            </p>
            <Button size="sm" variant="outline" className="h-9 w-full rounded-xl text-xs font-bold" onClick={() => setOpen(true)}>
              Browse &amp; request a loan
            </Button>
          </CardContent>
        </Card>
        {open && (
          <Suspense fallback={null}>
            <BorrowLoanSheet open={open} onOpenChange={setOpen} />
          </Suspense>
        )}
      </>
    );
  }

  return (
    <>
      <Card>
        <CardContent className="p-3.5 space-y-2.5">
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-sm font-bold">
              <HandCoins className="h-4 w-4 text-primary" /> Loan offers for you
            </p>
            <button className="text-xs font-semibold text-primary" onClick={() => setOpen(true)}>See all</button>
          </div>
          {offers.map((o) => (
            <div key={o.id} className="flex items-center gap-3 rounded-xl border bg-muted/20 p-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">{o.title}</p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {o.lender_display_name ?? 'Lending agent'} · {formatUGX(o.min_amount_ugx)}–{formatUGX(o.max_amount_ugx)} · {Number(o.interest_rate_pct)}% · up to {o.max_duration_days} days
                </p>
              </div>
              <Button size="sm" className="h-10 shrink-0 rounded-xl px-4 font-bold" onClick={() => setOpen(true)}>
                Request
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
      {open && (
        <Suspense fallback={null}>
          <BorrowLoanSheet open={open} onOpenChange={setOpen} />
        </Suspense>
      )}
    </>
  );
}

export default LendingOffersCard;
