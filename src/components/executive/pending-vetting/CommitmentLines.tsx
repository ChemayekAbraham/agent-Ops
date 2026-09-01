import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Loader2, Home, User } from 'lucide-react';

type Line = {
  id: string;
  kind: 'tenant' | 'house';
  principal: number;
  name: string;
  phone: string | null;
  location: string | null;
  daily: number;
  counterparty: string | null;
};

/**
 * Detail for a self-support portfolio, loaded on demand. A commitment is either
 * tenant-bound (rent plan lines) or house-bound (verified empty houses), so the
 * heading and each row adapt to what the partner actually committed to.
 */
export function CommitmentLines({ portfolioId }: { portfolioId: string }) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['pending-portfolio-lines', portfolioId],
    staleTime: 30_000,
    queryFn: async (): Promise<Line[]> => {
      // Ops roles cannot read rent_requests / profiles / house_listings directly
      // (no RLS policy), so this detail comes from a security-definer helper.
      const { data, error } = await supabase.rpc('partner_ops_pending_portfolio_lines' as any, {
        p_portfolio_id: portfolioId,
      });
      if (error) throw error;
      return ((data as any[]) || []).map(r => ({
        id: r.line_id,
        kind: r.line_kind === 'house' ? 'house' : 'tenant',
        principal: Number(r.principal) || 0,
        name: r.subject_name || (r.line_kind === 'house' ? 'Empty house' : 'Tenant'),
        phone: r.subject_phone || null,
        location: r.location || null,
        daily: Number(r.daily_repayment) || 0,
        counterparty: r.counterparty_name || null,
      }));
    },
  });

  const houses = (data || []).filter(l => l.kind === 'house');
  const tenants = (data || []).filter(l => l.kind === 'tenant');
  const isHousePlan = houses.length > 0 && tenants.length === 0;
  const subject = isHousePlan ? 'houses' : houses.length > 0 ? 'tenants and houses' : 'tenants';

  if (isLoading) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading what this portfolio is supporting…
      </p>
    );
  }
  if (isError) {
    return (
      <p className="text-xs text-destructive">
        Portfolio detail could not load: {(error as Error)?.message || 'unknown error'}
      </p>
    );
  }
  if (!data || data.length === 0) {
    return <p className="text-xs text-muted-foreground">No tenant or house lines recorded.</p>;
  }

  return (
    <div className="space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {data.length} {subject} on this portfolio
      </p>
      <div className="rounded-xl border border-border/60 divide-y divide-border/60 overflow-hidden">
        {data.map((l) => (
          <div key={l.id} className="flex items-center justify-between gap-3 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                {l.kind === 'house' ? <Home className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
              </span>
              <div className="min-w-0">
                <p className="text-xs font-bold text-foreground truncate">{l.name}</p>
                <p className="text-[10px] text-muted-foreground truncate">
                  {[
                    l.kind === 'house' ? 'Empty house' : null,
                    l.counterparty ? `Landlord: ${l.counterparty}` : null,
                    l.phone,
                    l.location,
                  ].filter(Boolean).join(' · ') || '—'}
                </p>
              </div>
            </div>
            <div className="text-right shrink-0">
              <p className="text-xs font-black text-foreground tabular-nums">{formatUGX(l.principal)}</p>
              {l.daily > 0 && (
                <p className="text-[10px] text-muted-foreground tabular-nums">{formatUGX(l.daily)} / day</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
