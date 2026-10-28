import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Receipt } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ThemeToggle } from '@/components/ThemeToggle';

/**
 * Shopping-receipt rewards are paused.
 *
 * This page used to show receipt totals, a rent-discount figure and a "Submit Receipt" form, but
 * every data call was stubbed out (so every number read 0) and submitting was switched off. The
 * database side could not have worked either: the receipt triggers write to a `loan_limits` table
 * that no longer exists, and nobody has ever submitted a receipt. Rather than keep promising
 * rewards that cannot be earned, the page says so plainly. Bringing the programme back needs a
 * decision on the benefit and who funds it first; see the evaluation in the project notes.
 */
export default function MyReceipts() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  useEffect(() => {
    if (!authLoading && !user) navigate('/auth');
  }, [user, authLoading, navigate]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-background to-muted/30">
      <header className="sticky top-0 z-50 border-b border-border/40 bg-background/80 backdrop-blur-xl">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => navigate(-1)}
                className="rounded-xl hover:bg-muted"
                aria-label="Back"
              >
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <div>
                <h1 className="text-xl font-bold tracking-tight">My Receipts</h1>
                <p className="text-xs text-muted-foreground">Shopping receipt rewards</p>
              </div>
            </div>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="container mx-auto max-w-lg px-4 py-10">
        <Card className="border-dashed">
          <CardContent className="space-y-4 p-8 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
              <Receipt className="h-7 w-7 text-muted-foreground" />
            </div>
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">Shopping receipt rewards are paused</h2>
              <p className="text-sm text-muted-foreground">
                We are not accepting shopping receipts right now, so there is nothing to submit and no
                rent discounts are being earned from receipts. Your wallet and your Rent Plans are not
                affected.
              </p>
            </div>
            <Button variant="outline" onClick={() => navigate(-1)}>
              Go back
            </Button>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
