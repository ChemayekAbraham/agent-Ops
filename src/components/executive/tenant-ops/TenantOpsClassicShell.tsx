import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { TenantOpsDashboard, type TenantOpsClassicView } from '../TenantOpsDashboard';
import { TenantOpsSidebar } from './TenantOpsSidebar';
import { TenantOpsTopBar } from './TenantOpsTopBar';
import { TenantOpsHome } from './TenantOpsHome';
import { TenantCallingHub } from './TenantCallingHub';
import { TenantPhoneDuplicatePanel } from '@/components/ops/TenantPhoneDuplicatePanel';
import { useTenantOpsToolCounts } from '@/hooks/useTenantOpsToolCounts';
import {
  isTenantOpsAction,
  tenantOpsLabelFor,
  TENANT_OPS_VIEW_KEYS,
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
  const active = (TENANT_OPS_VIEW_KEYS.has(raw) ? raw : 'home') as TenantOpsViewKey;

  const badges = useMemo<Partial<Record<string, number>>>(() => ({
    pipeline: counts?.review_requests ?? 0,
    missed: counts?.missed_days_tenants ?? 0,
    behavior: counts?.behavior_critical ?? 0,
    'registration-review': counts?.service_center_review ?? 0,
  }), [counts]);

  const goTo = useCallback((key: TenantOpsViewKey | TenantOpsActionKey) => {
    if (isTenantOpsAction(key)) {
      if (key === 'action.locations') onOpenLocations();
      if (key === 'action.welile-homes') onOpenWelileHomes();
      if (key === 'action.word-report') onGenerateWordReport();
      return;
    }
    const next = new URLSearchParams(params);
    if (key === 'home') next.delete('view');
    else next.set('view', key);
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
    if (active === 'calling-hub') return <TenantCallingHub />;
    if (active === 'phone-duplicates') return <TenantPhoneDuplicatePanel variant="full" />;
    return (
      <TenantOpsDashboard
        view={active as TenantOpsClassicView}
        onViewChange={handleClassicViewChange}
        hideOverview
      />
    );
  };

  const label = active === 'home' ? '' : tenantOpsLabelFor(active);

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
