import { useMemo, useState } from 'react';
import { usePartnerPortfolios } from '@/hooks/usePartnerPortfolios';
import { normalizePortfolioState } from '@/lib/portfolioAccrual';
import { ActivePortfolioCard } from './ActivePortfolioCard';
import { PortfolioSkeleton, PortfolioEmptyState, PortfolioErrorState } from './PortfolioStates';
import { SupportedTenantsSection } from '@/components/supporter/SupportedTenantsSection';
import { useSupportedTenants } from '@/hooks/useSupportedTenants';
import { hapticTap } from '@/lib/haptics';

type PortfolioView = 'portfolios' | 'self';

interface Props {
  /** Opens the existing portfolio/deployed-capital drawer */
  onViewPortfolios: (portfolioId?: string) => void;
  /** Scrolls to the existing Capital Opportunities section */
  onExploreOpportunities: () => void;
}

export function PartnerPortfolioSection({ onViewPortfolios, onExploreOpportunities }: Props) {
  const { portfolios, loading, error, refetch } = usePartnerPortfolios();
  const { tenants } = useSupportedTenants();
  const [view, setView] = useState<PortfolioView>('portfolios');

  /**
   * Dashboard list = ACTIVE portfolios only (matured / withdrawn / paused live in
   * the full portfolio drawer). Newest first. Pending ones are only used as a
   * fallback list so a partner awaiting activation still sees their capital.
   */
  const active = useMemo(() => {
    return portfolios
      .filter(p => {
        const s = normalizePortfolioState(p.status);
        // Locked portfolios (open redemption) are not active, but the partner
        // must still see them on the dashboard with the LOCKED badge.
        return s === 'active' || s === 'locked';
      })
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
  }, [portfolios]);

  const pending = useMemo(() => {
    return portfolios
      .filter(p => normalizePortfolioState(p.status) === 'pending')
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
  }, [portfolios]);

  

  const list = active.length > 0 ? active : pending;
  const shown = list.slice(0, 3);
  const hasMore = list.length > 3;

  const selfCount = tenants.length;
  const showSelf = view === 'self';

  return (
    <div id="your-portfolio" className="space-y-3 scroll-mt-4">
      <div className="flex items-center gap-1 p-1 rounded-xl bg-muted/60">
        {([
          { key: 'portfolios' as PortfolioView, label: 'Portfolios', count: list.length },
          { key: 'self' as PortfolioView, label: 'Self funded', count: selfCount },
        ]).map(tab => (
          <button
            key={tab.key}
            onClick={() => { hapticTap(); setView(tab.key); }}
            className={`flex-1 py-2 rounded-lg text-[11px] font-bold transition-colors min-h-[36px] ${
              view === tab.key
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground'
            }`}
          >
            {tab.label} ({tab.count})
          </button>
        ))}
      </div>

      {showSelf ? (
        <>
          <div className="flex items-center justify-between gap-2 px-1 pt-1">
            <h3 className="text-[10px] font-bold tracking-wide text-muted-foreground uppercase">
              YOUR SELF-FUNDED TENANTS
            </h3>
            <span className="text-[10px] font-bold text-muted-foreground">{selfCount}</span>
          </div>
          <SupportedTenantsSection embedded />
        </>
      ) : loading ? (
        <PortfolioSkeleton />
      ) : error ? (
        <PortfolioErrorState onRetry={refetch} />
      ) : list.length === 0 ? (
        <PortfolioEmptyState onExplore={onExploreOpportunities} />
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 px-1 pt-1">
            <h3 className="text-[10px] font-bold tracking-wide text-muted-foreground uppercase">
              {active.length > 0 ? 'YOUR ACTIVE PORTFOLIOS' : 'YOUR PENDING PORTFOLIOS'}
            </h3>
            <span className="text-[10px] font-bold text-muted-foreground">{list.length}</span>
          </div>

          <div className="space-y-3">
            {shown.map(p => (
              <ActivePortfolioCard key={p.id} portfolio={p} onView={() => onViewPortfolios(p.id)} />
            ))}
          </div>

          {hasMore && (
            <button
              onClick={() => onViewPortfolios()}
              className="w-full py-2.5 rounded-xl border border-border/60 text-xs font-bold text-foreground active:scale-[0.98] transition-transform touch-manipulation min-h-[44px]"
            >
              View all {list.length} portfolios →
            </button>
          )}
        </>
      )}
    </div>
  );
}
