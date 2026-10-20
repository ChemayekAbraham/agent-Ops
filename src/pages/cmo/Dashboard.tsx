import ExecutiveDashboardLayout from '@/components/layout/ExecutiveDashboardLayout';
import { usePersistedActiveTab } from '@/hooks/usePersistedActiveTab';
import { CMODashboard } from '@/components/executive/CMODashboard';
import { CMONotificationsBell } from '@/components/executive/CMONotificationsBell';

export default function CMODashboardPage() {
  const [activeTab, setActiveTab] = usePersistedActiveTab('cmo');

  return (
    <ExecutiveDashboardLayout
      role="cmo"
      activeTab={activeTab}
      onTabChange={setActiveTab}
      headerActions={<CMONotificationsBell onJump={setActiveTab} />}
    >
      <CMODashboard activeTab={activeTab} />
    </ExecutiveDashboardLayout>
  );
}

