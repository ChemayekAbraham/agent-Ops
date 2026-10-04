import ExecutiveDashboardLayout from '@/components/layout/ExecutiveDashboardLayout';
import { usePersistedActiveTab } from '@/hooks/usePersistedActiveTab';
import { CEODashboard } from '@/components/executive/CEODashboard';
import { CEORevenueGrowth } from '@/components/executive/CEORevenueGrowth';
import { RevenueRecognitionPanel } from '@/components/executive/RevenueRecognitionPanel';
import { StaffPerformancePanel } from '@/components/executive/StaffPerformancePanel';
import { AngelPoolManagementPanel } from '@/components/executive/AngelPoolManagementPanel';
import { MissionGoalsEditor } from '@/components/executive/MissionGoalsEditor';
import { RoleManagementPanel } from '@/components/executive/RoleManagementPanel';
import { RequisitionsWorkspace } from '@/components/requisitions/RequisitionsWorkspace';
import ExecutiveBrief from '@/hr/components/ExecutiveBrief';
import { GlobalVerificationHub } from '@/components/executive/GlobalVerificationHub';
import { WelileOperationsHub } from '@/components/executive/WelileOperationsHub';
import { ValuationModelPanel } from '@/components/executive/ValuationModelPanel';

export default function CEODashboardPage() {
  const [activeTab, setActiveTab] = usePersistedActiveTab('ceo');

  const renderContent = () => {
    switch (activeTab) {
      case 'revenue':
        return <CEORevenueGrowth />;
      case 'revenue-recognition':
        return <RevenueRecognitionPanel />;
      case 'valuation':
        return <ValuationModelPanel />;
      case 'staff-performance':
        return (
          <div className="space-y-6">
            <ExecutiveBrief embedded />
            <StaffPerformancePanel />
          </div>
        );
      case 'requisitions':
        return <RequisitionsWorkspace />;
      case 'angel-pool':
        return <AngelPoolManagementPanel userRole="ceo" />;
      case 'mission-goals':
        return <MissionGoalsEditor />;
      case 'global-verification':
        return <GlobalVerificationHub />;
      case 'welile-operations':
        return <WelileOperationsHub />;
      case 'role-management':
        return <RoleManagementPanel />;
      default:
        return <CEODashboard />;
    }
  };

  return (
    <ExecutiveDashboardLayout role="ceo" activeTab={activeTab} onTabChange={setActiveTab}>
      {renderContent()}
    </ExecutiveDashboardLayout>
  );
}
