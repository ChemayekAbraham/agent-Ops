import { lazy, Suspense, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { TenantOpsDashboard, type TenantOpsClassicView } from '../TenantOpsDashboard';
import { TenantOpsSidebar } from './TenantOpsSidebar';
import { TenantOpsTopBar } from './TenantOpsTopBar';
import { TenantOpsHome } from './TenantOpsHome';
import { CallingHub } from '@/components/ops/calling';
import { TenantCallingCenter } from './calling-center/TenantCallingCenter';
import { TenantPhoneDuplicatePanel } from '@/components/ops/TenantPhoneDuplicatePanel';
import { useTenantOpsToolCounts } from '@/hooks/useTenantOpsToolCounts';

/** These render inside the shell so the sidebar stays visible. */
const PortfolioPerformanceReport = lazy(() => import('@/pages/tenant-ops/PortfolioPerformanceReport'));
const TenantNotificationAnalyticsPage = lazy(() => import('@/pages/tenant-ops/TenantNotificationAnalyticsPage'));
const TenantOperationsWorkspace = lazy(() => import('@/pages/tenant-ops/TenantOperationsWorkspace'));
const TenantOpsWeeklyPerformancePage = lazy(() => import('@/pages/tenant-ops/TenantOpsWeeklyPerformancePage'));
import {
  isTenantOpsAction,
  tenantOpsLabelFor,
  isTenantOpsViewKey,
  type TenantOpsActionKey,
  type TenantOpsViewKey,
} from './tenantOpsNav';

interface Props {
  /** Secondary tools that used to sit above Classic. */
  onOpenLocations: () => void;
  onOpenWelileHomes: () => void;
  onGenerateWordReport: () => void;
}

/**
 * Persistent-sidebar shell around Classic Tenant Ops. The selected section
 * lives in the URL (`?view=`) so deep links, refresh and browser back/forward
 * all work; Classic itself is rendered in controlled mode with its own
 * overview suppressed.
 */
export function TenantOpsClassicShell({ onOpenLocations, onOpenWelileHomes, onGenerateWordReport }: Props) {
  const [params, setParams] = useSearchParams();
  const { data: counts } = useTenantOpsToolCounts();

  const raw = params.get('view') || 'home';
  const active = (
    raw === 'action.portfolio-performance' || raw === 'action.notifications-analytics' || isTenantOpsViewKey(raw)
      ? raw
      : 'home'
  ) as TenantOpsViewKey | TenantOpsActionKey;

  const badges = useMemo<Partial<Record<string, number>>>(() => ({
    pipeline: counts?.review_requests ?? 0,
    missed: counts?.missed_days_tenants ?? 0,
    behavior: counts?.behavior_critical ?? 0,
    'registration-review': counts?.service_center_review ?? 0,
  }), [counts]);

  const goTo = useCallback((key: TenantOpsViewKey | TenantOpsActionKey) => {
    const next = new URLSearchParams(params);
    if (key === 'action.portfolio-performance' || key === 'action.notifications-analytics') {
      // Kept inside the shell so the sidebar and top bar stay in place.
      next.set('view', key);
    } else if (isTenantOpsAction(key)) {
      if (key === 'action.locations') onOpenLocations();
      if (key === 'action.welile-homes') onOpenWelileHomes();
      if (key === 'action.word-report') onGenerateWordReport();
      return;
    } else if (key === 'home') {
      next.delete('view');
    } else {
      next.set('view', key);
    }
    setParams(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [params, setParams, onOpenLocations, onOpenWelileHomes, onGenerateWordReport]);

  const handleClassicViewChange = useCallback((view: TenantOpsClassicView) => {
    // Classic can navigate itself (e.g. opening a tenant detail); mirror it into
    // the URL so the sidebar and history stay in sync.
    goTo(view === 'overview' ? 'home' : (view as TenantOpsViewKey));
  }, [goTo]);

  const body = () => {
    if (active === 'home') return <TenantOpsHome onNavigate={goTo} />;
    if (active === 'action.portfolio-performance') {
      return (
        <Suspense fallback={<div className="flex min-h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>}>
          <PortfolioPerformanceReport onBack={() => goTo('home')} />
        </Suspense>
      );
    }
    if (active === 'action.notifications-analytics') {
      return (
        <Suspense fallback={<div className="flex min-h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>}>
          <TenantNotificationAnalyticsPage embedded />
        </Suspense>
      );
    }
    if (active === 'tenant-operations-workspace') {
      return (
        <Suspense fallback={<div className="flex min-h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>}>
          <TenantOperationsWorkspace />
        </Suspense>
      );
    }
    if (active === 'tenant-ops-weekly-performance') {
      return (
        <Suspense fallback={<div className="flex min-h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>}>
          <TenantOpsWeeklyPerformancePage />
        </Suspense>
      );
    }
    if (active === 'calling-hub') return <CallingHub subjectType="tenant" />;
    if (active === 'calling-center') return <TenantCallingCenter />;
    if (active === 'phone-duplicates') return <TenantPhoneDuplicatePanel variant="full" />;
    return (
      <TenantOpsDashboard
        view={active as TenantOpsClassicView}
        onViewChange={handleClassicViewChange}
        hideOverview
      />
    );
  };

  // These views carry their own page header, so the shell heading is dropped
  // to avoid printing the same title twice.
  const selfTitled = active === 'action.portfolio-performance'
    || active === 'action.notifications-analytics'
    || active === 'tenant-operations-workspace'
    || active === 'tenant-ops-weekly-performance';
  const label = active === 'home' || selfTitled ? '' : tenantOpsLabelFor(active);

  return (
    <div className="space-y-2">
      <TenantOpsTopBar active={active} onSelect={goTo} badges={badges} />

      <div className="flex gap-3">
        <aside className="hidden w-56 shrink-0 lg:block">
          <div className="sticky top-14 h-[calc(100vh-4.5rem)] overflow-hidden rounded-xl border bg-card shadow-sm">
            <TenantOpsSidebar active={active} onSelect={goTo} badges={badges} />
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          {label && (
            <h2 className="mb-2 text-sm font-bold text-foreground lg:text-base">{label}</h2>
          )}
          {body()}
        </main>
      </div>
    </div>
  );
}
