import { lazy, Suspense } from 'react';
import ExecutiveDashboardLayout from '@/components/layout/ExecutiveDashboardLayout';
import { usePersistedActiveTab } from '@/hooks/usePersistedActiveTab';
import { CRMDashboard } from '@/components/executive/CRMDashboard';
import { CRMSupportLogPanel } from '@/components/executive/CRMSupportLogPanel';
import { CTOCommunicationOverview } from '@/components/executive/CTOCommunicationOverview';
import { RequisitionsWorkspace } from '@/components/requisitions/RequisitionsWorkspace';
import { Skeleton } from '@/components/ui/skeleton';
import {
  CALL_SECTIONS,
  CALL_SECTION_SLUG,
  parseCallSectionNavId,
} from '@/lib/callCentre';

/**
 * Call Centre panels are lazy: they pull in recharts, which no other CRM tab
 * needs, so the default Overview should not pay for it.
 */
const CallCentreOverview = lazy(() =>
  import('@/components/executive/crm/call-centre/CallCentreOverview').then((m) => ({
    default: m.CallCentreOverview,
  })),
);
const CallCentreHistory = lazy(() =>
  import('@/components/executive/crm/call-centre/CallCentreHistory').then((m) => ({
    default: m.CallCentreHistory,
  })),
);
const CallCentreSummaries = lazy(() =>
  import('@/components/executive/crm/call-centre/CallCentreSummaries').then((m) => ({
    default: m.CallCentreSummaries,
  })),
);
const CallCentrePeople = lazy(() =>
  import('@/components/executive/crm/call-centre/CallCentrePeople').then((m) => ({
    default: m.CallCentrePeople,
  })),
);
const UserBehaviourAnalyticsPanel = lazy(() =>
  import('@/components/executive/crm/UserBehaviourAnalyticsPanel').then((m) => ({
    default: m.UserBehaviourAnalyticsPanel,
  })),
);

const TenantCampaignPanel = lazy(() =>
  import('@/components/executive/crm/TenantCampaignPanel').then((m) => ({ default: m.TenantCampaignPanel })),
);

const PanelFallback = () => (
  <div className="space-y-3">
    <Skeleton className="h-10 w-full rounded-lg" />
    <Skeleton className="h-64 w-full rounded-xl" />
  </div>
);

export default function CRMDashboardPage() {
  const [activeTab, setActiveTab] = usePersistedActiveTab('crm');

  const renderContent = () => {
    // The Call Centre is five queues × four views. Resolve those first, by
    // parsing the sidebar id, so the switch below stays a list of one-off
    // panels instead of twenty near-identical cases.
    const leaf = parseCallSectionNavId(activeTab);
    if (leaf) {
      const { section, view } = leaf;
      return (
        <Suspense fallback={<PanelFallback />}>
          {view === 'overview' && <CallCentreOverview section={section} />}
          {view === 'people' && <CallCentrePeople section={section} />}
          {view === 'logs' && <CallCentreHistory section={section} />}
          {view === 'summaries' && <CallCentreSummaries section={section} />}
        </Suspense>
      );
    }

    // A queue's own id is the sidebar disclosure, not a destination — land on
    // its Overview rather than the fallback panel.
    const parentSection = CALL_SECTIONS.find(
      (s) => activeTab === `call-centre-${CALL_SECTION_SLUG[s]}`,
    );
    if (parentSection) {
      return (
        <Suspense fallback={<PanelFallback />}>
          <CallCentreOverview section={parentSection} />
        </Suspense>
      );
    }

    switch (activeTab) {
      case 'requisitions':
        return <RequisitionsWorkspace />;
      // Pre-queue ids. Bookmarks, ?section= deep links and persisted tabs from
      // before the split still resolve — onto Tenants, the largest queue.
      case 'call-centre':
      case 'call-centre-overview':
        return (
          <Suspense fallback={<PanelFallback />}>
            <CallCentreOverview section="tenant" />
          </Suspense>
        );
      case 'call-centre-history':
        return (
          <Suspense fallback={<PanelFallback />}>
            <CallCentreHistory section="tenant" />
          </Suspense>
        );
      case 'call-centre-people':
        return (
          <Suspense fallback={<PanelFallback />}>
            <CallCentrePeople section="tenant" />
          </Suspense>
        );
      case 'customer-issues':
        return (
          <CRMSupportLogPanel
            title="Customer Issues"
            subtitle="Log complaints, rate the customer experience, and record the solution. Export a clean monthly PDF."
            defaultTab="issues"
          />
        );
      case 'tenant-support':
        return (
          <CRMSupportLogPanel
            title="Tenant Support"
            subtitle="Record partner investments — partner name, date, and amount invested. Export a clean monthly PDF."
            defaultTab="support"
          />
        );
      case 'communications':
        return <CTOCommunicationOverview />;
      case 'sms-campaigns':
        return (
          <Suspense fallback={<PanelFallback />}>
            <TenantCampaignPanel />
          </Suspense>
        );
      case 'user-behaviour':
        return (
          <Suspense fallback={<PanelFallback />}>
            <UserBehaviourAnalyticsPanel />
          </Suspense>
        );
      default:
        return <CRMDashboard />;
    }
  };

  return (
    <ExecutiveDashboardLayout role="crm" activeTab={activeTab} onTabChange={setActiveTab}>
      {renderContent()}
    </ExecutiveDashboardLayout>
  );
}
