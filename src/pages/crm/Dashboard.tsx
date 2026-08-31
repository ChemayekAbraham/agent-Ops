import ExecutiveDashboardLayout from '@/components/layout/ExecutiveDashboardLayout';
import { usePersistedActiveTab } from '@/hooks/usePersistedActiveTab';
import { CRMDashboard } from '@/components/executive/CRMDashboard';
import { CRMSupportLogPanel } from '@/components/executive/CRMSupportLogPanel';
import { CTOCommunicationOverview } from '@/components/executive/CTOCommunicationOverview';
import { RequisitionsWorkspace } from '@/components/requisitions/RequisitionsWorkspace';

export default function CRMDashboardPage() {
  const [activeTab, setActiveTab] = usePersistedActiveTab('crm');

  const renderContent = () => {
    switch (activeTab) {
      case 'requisitions':
        return <RequisitionsWorkspace />;
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
