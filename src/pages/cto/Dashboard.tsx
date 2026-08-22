import ExecutiveDashboardLayout from '@/components/layout/ExecutiveDashboardLayout';
import { usePersistedActiveTab } from '@/hooks/usePersistedActiveTab';
import { CTODashboard } from '@/components/executive/CTODashboard';
import { RequisitionsWorkspace } from '@/components/requisitions/RequisitionsWorkspace';

export default function CTODashboardPage() {
  const [activeTab, setActiveTab] = usePersistedActiveTab('cto');

  return (
    <ExecutiveDashboardLayout role="cto" activeTab={activeTab} onTabChange={setActiveTab}>
      {activeTab === 'requisitions' ? (
        <RequisitionsWorkspace />
      ) : (
        <CTODashboard activeTab={activeTab} />
      )}
    </ExecutiveDashboardLayout>
  );
}
