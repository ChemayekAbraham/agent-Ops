import { Suspense } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { roleToSlug } from '@/lib/roleRoutes';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Download, Loader2 } from 'lucide-react';
import { lazyWithRetry, lazyNamed } from '@/lib/lazyWithRetry';
import { MissionBanner } from '@/components/mission/MissionBanner';
import { useStaffPermissions } from '@/hooks/useStaffPermissions';
import NotFound from '@/pages/NotFound';
import ScreenLoader from '@/components/common/ScreenLoader';

// Only ONE of these dashboards is ever mounted per visit (the `?tab=` slug),
// so each is code-split into its own chunk instead of being welded into one
// multi-MB ExecutiveHub bundle. Behaviour is unchanged — the selected tab
// still renders exactly the same component.
const CEODashboard = lazyNamed(() => import('@/components/executive/CEODashboard'), 'CEODashboard');
const CTODashboard = lazyNamed(() => import('@/components/executive/CTODashboard'), 'CTODashboard');
const CMODashboard = lazyNamed(() => import('@/components/executive/CMODashboard'), 'CMODashboard');
const AgentOpsDashboard = lazyNamed(() => import('@/components/executive/AgentOpsDashboard'), 'AgentOpsDashboard');
const TenantOpsHub = lazyNamed(() => import('@/components/executive/TenantOpsHub'), 'TenantOpsHub');
const LandlordOpsDashboard = lazyNamed(() => import('@/components/executive/landlord-ops/LandlordOpsClassicShell'), 'LandlordOpsDashboardShell');
const PartnersOpsDashboard = lazyNamed(() => import('@/components/executive/PartnersOpsDashboard'), 'PartnersOpsDashboard');
const CRMDashboard = lazyNamed(() => import('@/components/executive/CRMDashboard'), 'CRMDashboard');
const LocationManager = lazyNamed(() => import('@/components/ops/LocationManager'), 'LocationManager');

import { BudgetDepartmentNotificationBell } from '@/components/budget/BudgetDepartmentNotificationBell';

/**
 * Every tab must declare the `staff_permissions.permitted_dashboard` key that
 * unlocks it. A tab with no entry here is unreachable by design — add the key
 * deliberately rather than leaving it undefined.
 *
 * NOTE the deliberate asymmetry: the tab slug is `partners-ops` (plural) but
 * the granted key is `partner-ops` (singular), because that is what is already
 * in the database and on the Access Panel card. Do not "tidy" one without
 * migrating the other.
 */
const TAB_PERMISSION: Record<string, string> = {
  ceo: 'ceo',
  cto: 'cto',
  cmo: 'cmo',
  crm: 'crm',
  'agent-ops': 'agent-ops',
  'tenant-ops': 'tenant-ops',
  'landlord-ops': 'landlord-ops',
  'partners-ops': 'partner-ops',
  locations: 'company-ops',
};

const dashboards: Record<
  string,
  { title: string; component: React.ComponentType; missionRole?: string }
> = {
  ceo: { title: 'CEO Dashboard', component: CEODashboard, missionRole: 'ceo' },
  cto: { title: 'CTO Dashboard', component: CTODashboard, missionRole: 'cto' },
  cmo: { title: 'CMO Dashboard', component: CMODashboard, missionRole: 'cmo' },
  'agent-ops': { title: 'Agent Operations', component: AgentOpsDashboard, missionRole: 'agent-ops' },
  'tenant-ops': { title: 'Tenant Operations', component: TenantOpsHub, missionRole: 'tenant-ops' },
  'landlord-ops': { title: 'Landlord Operations', component: LandlordOpsDashboard, missionRole: 'landlord-ops' },
  'partners-ops': { title: 'Partners Operations', component: PartnersOpsDashboard, missionRole: 'partners-ops' },
  crm: { title: 'CRM Dashboard', component: CRMDashboard, missionRole: 'crm' },
  locations: { title: 'Location Management', component: LocationManager },
};

export default function ExecutiveHub() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { hasPermission, loading } = useStaffPermissions();

  if (loading) {
    return (
      <ScreenLoader />
    );
  }

  const requestedTab = searchParams.get('tab');

  // Previously this defaulted to `ceo` and fell back to `ceo` for any unknown
  // slug, which meant a bare visit to /executive-hub opened the CEO dashboard
  // for anyone the route guard admitted. Now: no tab means the first tab the
  // user actually holds, and an unknown or ungranted tab is a 404.
  const grantedTabs = Object.keys(dashboards).filter((t) => hasPermission(TAB_PERMISSION[t]));
  const tab = requestedTab ?? grantedTabs[0];

  if (!tab || !dashboards[tab] || !hasPermission(TAB_PERMISSION[tab])) {
    return <NotFound />;
  }

  const current = dashboards[tab];
  const DashboardComponent = current.component;
  const fullWidth = tab === 'agent-ops' || tab === 'partners-ops';

  const showHeader = tab !== 'partners-ops';

  return (
    <div className="flex flex-col h-[100dvh] bg-background overflow-hidden">
      {showHeader && (
        <header className="shrink-0 z-30 bg-card/95 backdrop-blur border-b border-border px-4 py-3">
          <div className="max-w-7xl mx-auto flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate('/dashboard/tenant')} className="shrink-0">
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="min-w-0 flex-1">
              <h1 className="text-lg font-bold truncate">{current.title}</h1>
              <p className="text-xs text-muted-foreground">Executive &amp; Operations Hub</p>
            </div>
            <BudgetDepartmentNotificationBell dashboard={tab} />
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5"
              onClick={async () => {
                const res = await fetch('/EXECUTIVE_HUB_GUIDE.md');
                const text = await res.text();
                const blob = new Blob([text], { type: 'text/markdown' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'Executive_Hub_Guide.md';
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              <Download className="h-4 w-4" />
              <span className="hidden sm:inline">Guide</span>
            </Button>
          </div>
        </header>
      )}
      <div className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">
        <div className={`${fullWidth ? 'max-w-none' : 'max-w-7xl'} mx-auto p-4 pb-24`}>
          {current.missionRole && <MissionBanner dashboardRole={current.missionRole} className="mb-4" />}
          <Suspense
            fallback={
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            }
          >
            <DashboardComponent />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
