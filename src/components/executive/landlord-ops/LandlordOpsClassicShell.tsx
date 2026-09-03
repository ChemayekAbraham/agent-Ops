import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { LandlordOpsDashboard, type LandlordOpsClassicView } from '../LandlordOpsDashboard';
import { LandlordOpsSidebar } from './LandlordOpsSidebar';
import { LandlordOpsTopBar } from './LandlordOpsTopBar';
import { LandlordOpsHome } from './LandlordOpsHome';
import { CallingHub } from '@/components/ops/calling';
import { TenantOpsLandlordFloatPanel } from '../TenantOpsLandlordFloatPanel';
import { useLandlordOpsBadgeCounts } from '@/hooks/useLandlordOpsBadgeCounts';
import {
  landlordOpsLabelFor,
  LANDLORD_OPS_VIEW_KEYS,
  type LandlordOpsViewKey,
} from './landlordOpsNav';

/**
 * Persistent-sidebar shell around Classic Landlord Ops. The selected section
 * lives in the URL (`?view=`) so deep links, refresh and browser back/forward
 * all work; Classic itself renders in controlled mode with its legacy overview
 * suppressed. Navigation and presentation only — no workflow logic here.
 */
export function LandlordOpsDashboardShell() {
  const [params, setParams] = useSearchParams();
  const { pendingHouses, pendingLandlords } = useLandlordOpsBadgeCounts();

  const raw = params.get('view') || 'home';
  const active = (LANDLORD_OPS_VIEW_KEYS.has(raw) ? raw : 'home') as LandlordOpsViewKey;

  const badges = useMemo<Partial<Record<string, number>>>(
    () => ({
      verify: pendingHouses,
      landlords: pendingLandlords,
    }),
    [pendingHouses, pendingLandlords],
  );

  const goTo = useCallback(
    (key: LandlordOpsViewKey) => {
      const next = new URLSearchParams(params);
      if (key === 'home') next.delete('view');
      else next.set('view', key);
      setParams(next);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [params, setParams],
  );

  const handleClassicViewChange = useCallback(
    (view: LandlordOpsClassicView) => {
      // Classic can navigate itself (e.g. its own back row); mirror it into the
      // URL so the sidebar and browser history stay in sync.
      goTo(view as LandlordOpsViewKey);
    },
    [goTo],
  );

  const label = active === 'home' ? '' : landlordOpsLabelFor(active);

  return (
    <div className="space-y-2">
      <LandlordOpsTopBar active={active} onSelect={goTo} badges={badges} />

      <div className="flex gap-3">
        <aside className="hidden w-56 shrink-0 lg:block">
          <div className="sticky top-14 h-[calc(100vh-4.5rem)] overflow-hidden rounded-xl border bg-card shadow-sm">
            <LandlordOpsSidebar active={active} onSelect={goTo} badges={badges} />
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          {label && <h2 className="mb-2 text-sm font-bold text-foreground lg:text-base">{label}</h2>}
          {active === 'home' ? (
            <LandlordOpsHome onNavigate={goTo} />
          ) : active === 'calling-hub' ? (
            <CallingHub subjectType="landlord" />
          ) : active === 'agent-landlord-float' ? (
            <TenantOpsLandlordFloatPanel />
          ) : (
            <LandlordOpsDashboard
              view={active as LandlordOpsClassicView}
              onViewChange={handleClassicViewChange}
              hideOverview
            />
          )}
        </main>
      </div>
    </div>
  );
}
