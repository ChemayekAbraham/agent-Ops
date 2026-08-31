import ExecutiveDashboardLayout from '@/components/layout/ExecutiveDashboardLayout';
import { usePersistedActiveTab } from '@/hooks/usePersistedActiveTab';
import { CRMDashboard } from '@/components/executive/CRMDashboard';
import { CRMDirectoryPanel } from '@/components/executive/CRMDirectoryPanel';
import { CRMLandlordsPanel } from '@/components/executive/CRMLandlordsPanel';
import { CRMSupportLogPanel } from '@/components/executive/CRMSupportLogPanel';
import { CallCentrePanel } from '@/components/executive/crm/CallCentrePanel';
import { CTOCommunicationOverview } from '@/components/executive/CTOCommunicationOverview';
import { RequisitionsWorkspace } from '@/components/requisitions/RequisitionsWorkspace';

export default function CRMDashboardPage() {
  const [activeTab, setActiveTab] = usePersistedActiveTab('crm');

  const renderContent = () => {
    switch (activeTab) {
      case 'requisitions':
        return <RequisitionsWorkspace />;
      case 'call-centre':
        return <CallCentrePanel />;
      case 'all-tenants':
        return (
          <CRMDirectoryPanel
            role="tenant"
            title="All Tenants"
            subtitle="Every tenant on the platform with full profile details. Click a row to view more."
          />
        );
      case 'all-agents':
        return (
          <CRMDirectoryPanel
            role="agent"
            title="All Agents"
            subtitle="Every agent on the platform with full profile details. Click a row to view more."
          />
        );
      case 'all-landlords':
        return (
          <CRMLandlordsPanel
            title="All Landlords"
            subtitle="Every landlord on the platform with full details and payout info. Click a row to view more."
          />
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
