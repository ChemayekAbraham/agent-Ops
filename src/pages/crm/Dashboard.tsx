import { lazy, Suspense } from 'react';
import ExecutiveDashboardLayout from '@/components/layout/ExecutiveDashboardLayout';
import { usePersistedActiveTab } from '@/hooks/usePersistedActiveTab';
import { CRMDashboard } from '@/components/executive/CRMDashboard';
import { CRMSupportLogPanel } from '@/components/executive/CRMSupportLogPanel';
import { CTOCommunicationOverview } from '@/components/executive/CTOCommunicationOverview';
import { RequisitionsWorkspace } from '@/components/requisitions/RequisitionsWorkspace';
import { Skeleton } from '@/components/ui/skeleton';

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
const CallCentrePeople = lazy(() =>
  import('@/components/executive/crm/call-centre/CallCentrePeople').then((m) => ({
    default: m.CallCentrePeople,
  })),
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
    switch (activeTab) {
      case 'requisitions':
        return <RequisitionsWorkspace />;
      // `call-centre` is the parent disclosure in the sidebar, not a view of its
      // own — it falls through to the Overview child so a stale persisted tab
      // (or a ?section=call-centre deep link) still lands somewhere real.
      case 'call-centre':
      case 'call-centre-overview':
        return (
          <Suspense fallback={<PanelFallback />}>
            <CallCentreOverview />
          </Suspense>
        );
      case 'call-centre-history':
        return (
          <Suspense fallback={<PanelFallback />}>
            <CallCentreHistory />
          </Suspense>
        );
      case 'call-centre-people':
        return (
          <Suspense fallback={<PanelFallback />}>
            <CallCentrePeople />
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
