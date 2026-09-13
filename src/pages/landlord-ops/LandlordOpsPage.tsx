import { useCallback, useMemo, Suspense } from 'react';
import { useLocation, useNavigate, useSearchParams, Outlet } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useLandlordOpsBadgeCounts } from '@/hooks/useLandlordOpsBadgeCounts';
import { LandlordOpsTopBar } from '@/components/executive/landlord-ops/LandlordOpsTopBar';
import { LandlordOpsSidebar } from '@/components/executive/landlord-ops/LandlordOpsSidebar';
import { LandlordOpsDecisionDrawer } from '@/components/executive/landlord-ops/LandlordOpsDecisionDrawer';

/**
 * Layout route for Landlord Ops.
 *
 * Chrome only — top bar, sidebar, the shared decision drawer and the badge
 * counters. Every destination is its own child route (see `routes.tsx`) rendered
 * through `<Outlet/>`, so each one is an independently lazy chunk with its own
 * URL, and no panel's hooks run while a different destination is open.
 *
 * The `landlord-ops` permission is checked once on this route in `App.tsx`, not
 * per destination, and `useLandlordOpsBadgeCounts` lives here so the counters
 * are fetched once for the whole console.
 */
export default function LandlordOpsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Path relative to /landlord-ops — '' on the index route.
  const path = location.pathname.replace(/^\/landlord-ops\/?/, '').toLowerCase();

  const {
    pendingHouses,
    pendingLandlords,
    pendingLc1,
    pendingPipeline,
    pendingPayouts,
  } = useLandlordOpsBadgeCounts();

  const badges = useMemo<Record<string, number>>(
    () => ({
      verify: pendingHouses,
      landlords: pendingLandlords,
      lc1: pendingLc1,
      pipeline: pendingPipeline,
      payouts: pendingPayouts,
    }),
    [pendingHouses, pendingLandlords, pendingLc1, pendingPipeline, pendingPayouts],
  );

  const handleNavigate = useCallback(
    (destination: string) => {
      const clean = destination.replace(/^\//, '');
      // A destination change closes any open decision; other params are kept.
      const next = new URLSearchParams(searchParams);
      next.delete('view');
      next.delete('decide');
      const qs = next.toString();
      navigate(`/landlord-ops${clean ? `/${clean}` : ''}${qs ? `?${qs}` : ''}`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [navigate, searchParams],
  );

  const hasDecisionDrawer = !!searchParams.get('decide');

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-background">
      <LandlordOpsTopBar activePath={path} onNavigate={handleNavigate} badges={badges} />

      <div className="flex flex-1 overflow-hidden relative">
        <aside className="hidden lg:block h-full shrink-0">
          <LandlordOpsSidebar
            activePath={path}
            onNavigate={handleNavigate}
            badges={badges}
            className="h-full"
          />
        </aside>

        <main className="flex-1 overflow-y-auto p-2.5 sm:p-4 lg:p-6 min-w-0 overscroll-contain">
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-64">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </main>

        {hasDecisionDrawer && (
          <LandlordOpsDecisionDrawer
            onClose={() => {
              const next = new URLSearchParams(searchParams);
              next.delete('decide');
              setSearchParams(next);
            }}
          />
        )}
      </div>
    </div>
  );
}
