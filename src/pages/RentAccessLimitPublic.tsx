import { useEffect, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { calculateRentAccessLimit, TIER_META } from '@/lib/rentAccessLimit';
import { formatUGX } from '@/lib/rentCalculations';
import { Loader2, TrendingUp, TrendingDown, Sparkles } from 'lucide-react';
import ScreenLoader from '@/components/common/ScreenLoader';

/**
 * Public landing page resolved from short links: /limit/:tenantId  (or  /limit?t=…)
 * Fetches the tenant's monthly_rent + repayments and renders the live limit.
 */
export default function RentAccessLimitPublic() {
  const { tenantId: paramId } = useParams<{ tenantId: string }>();
  const [search] = useSearchParams();
  const tenantId = paramId || search.get('t') || '';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [rent, setRent] = useState<number | null>(null);
  const [repayments, setRepayments] = useState<{ amount: number; created_at: string }[]>([]);

  useEffect(() => {
    if (!tenantId) {
      setError('Missing tenant id');
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const [{ data: prof }, { data: reps }] = await Promise.all([
          supabase.from('profiles').select('full_name, monthly_rent').eq('id', tenantId).single(),
          supabase.from('repayments').select('amount, created_at').eq('tenant_id', tenantId),
        ]);
        if (!prof) {
          setError('Tenant not found');
        } else {
          setName(prof.full_name || 'Tenant');
          setRent(prof.monthly_rent ?? null);
          setRepayments((reps || []) as any);
        }
      } catch (e: any) {
        setError(e.message || 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, [tenantId]);

  if (loading) {
    return (
      <ScreenLoader />
    );
  }

  if (error || !rent) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background p-6 text-center">
        <Sparkles className="h-8 w-8 text-muted-foreground mb-3" />
        <h1 className="text-lg font-bold">Limit unavailable</h1>
        <p className="text-sm text-muted-foreground mt-1">{error || 'No rent on file yet.'}</p>
        <Link to="/" className="mt-4 text-sm text-primary underline">Visit Welile</Link>
      </div>
    );
  }

  const result = calculateRentAccessLimit(rent, repayments);
  const tier = TIER_META[result.tier];
  const pct = result.netAdjustmentPct * 100;

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/15 via-background to-background p-4 sm:p-8 flex justify-center">
      <div className="w-full max-w-md space-y-4">
        <header className="text-center">
          <p className="text-xs font-bold uppercase tracking-widest text-primary">Welile</p>
          <h1 className="text-xl font-bold mt-1">Rent Access Certificate</h1>
        </header>

        <section className="rounded-3xl border border-primary/20 bg-card shadow-lg overflow-hidden">
          <div className="p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs text-muted-foreground">Issued to</p>
                <p className="text-lg font-bold leading-tight">{name}</p>
              </div>
              <span className={`shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-bold bg-muted ${tier.color}`}>
                <span aria-hidden>{tier.emoji}</span>{tier.label}
              </span>
            </div>

            <div>
              <p className="text-[10px] uppercase tracking-widest text-primary/80 font-bold">Rent Access Limit</p>
              <p className="text-3xl sm:text-4xl font-black font-mono mt-1 break-all">{formatUGX(result.limit)}</p>
              <p className="text-xs text-muted-foreground mt-1">
                Base {formatUGX(result.base)} ·{' '}
                <span className={pct >= 0 ? 'text-success font-semibold' : 'text-destructive font-semibold'}>
                  {pct >= 0 ? '+' : ''}{pct.toFixed(0)}%
                </span>{' '}
                from daily payments
              </p>
            </div>

            <div className={`flex items-center gap-2 rounded-xl px-3 py-2 border ${result.paidToday ? 'bg-success/10 border-success/30 text-success' : 'bg-warning/10 border-warning/30 text-warning'}`}>
              {result.paidToday ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
              <p className="text-sm font-semibold">
                {result.paidToday
                  ? `+${formatUGX(result.todayChange)} earned today`
                  : `Pay today to earn +${formatUGX(Math.abs(result.todayChange))}`}
              </p>
            </div>

            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-muted/60 p-2">
                <p className="text-base font-black text-success">{result.paidDays}</p>
                <p className="text-[10px] uppercase text-muted-foreground">On-time</p>
              </div>
              <div className="rounded-lg bg-muted/60 p-2">
                <p className="text-base font-black text-destructive">{result.missedDays}</p>
                <p className="text-[10px] uppercase text-muted-foreground">Missed</p>
              </div>
              <div className="rounded-lg bg-muted/60 p-2">
                <p className="text-base font-black">{result.trackedDays}</p>
                <p className="text-[10px] uppercase text-muted-foreground">Days</p>
              </div>
            </div>

            <div className="rounded-xl bg-muted/40 p-3 text-xs space-y-1">
              <p className="font-bold">How it grows</p>
              <p className="text-success">+5% of base for every on-time day</p>
              <p className="text-destructive">−5% of base for every missed day</p>
            </div>

            <p className="text-center text-sm font-bold text-primary pt-1">
              Pay today. Unlock more rent tomorrow.
            </p>
          </div>
        </section>

        <p className="text-center text-[11px] text-muted-foreground">
          Informational only. Final access subject to Welile review.
        </p>
      </div>
    </div>
  );
}
