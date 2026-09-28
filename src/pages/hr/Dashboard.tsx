import ExecutiveDashboardLayout from '@/components/layout/ExecutiveDashboardLayout';
import { useEffect, useState, useCallback } from 'react';
import { usePolling } from '@/hooks/usePolling';
import { supabase } from '@/integrations/supabase/client';
import { usePersistedActiveTab } from '@/hooks/usePersistedActiveTab';
import HROverview from '@/components/hr/HROverview';
import HRLeaveManagement from '@/components/hr/HRLeaveManagement';
import HRDisciplinary from '@/components/hr/HRDisciplinary';
import HRAudit from '@/components/hr/HRAudit';
import HRDepartments from '@/components/hr/HRDepartments';
import { RequisitionsWorkspace } from '@/components/requisitions/RequisitionsWorkspace';
import { ApprovalHistoryLog } from '@/components/executive/ApprovalHistoryLog';
import HRSubmittedReports from '@/components/hr/HRSubmittedReports';
import { ReportArchiveList } from '@/components/reports/ReportArchiveList';

export default function HRDashboard() {
  const [activeSection, setActiveSection] = usePersistedActiveTab('hr');
  const [pendingLeave, setPendingLeave] = useState(0);

  /** Pending leave requests filed since HR last opened the Leave tab. */
  const refreshLeaveBeacon = useCallback(async () => {
    let seenAt = '1970-01-01T00:00:00.000Z';
    try {
      seenAt = window.localStorage.getItem('hr:leave:lastSeenAt') || seenAt;
    } catch {
      /* storage unavailable */
    }
    const { count } = await supabase
      .from('leave_requests')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending')
      .gt('created_at', seenAt);
    setPendingLeave(count ?? 0);
  }, []);

  // Polled every 60s (+ on focus). The old Realtime listener was on
  // leave_requests, which is not in the publication, so it never fired (doc 147).
  usePolling(refreshLeaveBeacon, 60_000, { immediate: true });

  // Opening the tab clears the beacon.
  useEffect(() => {
    if (activeSection !== 'leave') return;
    try {
      window.localStorage.setItem('hr:leave:lastSeenAt', new Date().toISOString());
    } catch {
      /* storage unavailable */
    }
    setPendingLeave(0);
  }, [activeSection]);

  const renderContent = () => {
    switch (activeSection) {
      case 'requisitions': return <RequisitionsWorkspace />;
      case 'overview': return <HROverview onNavigate={setActiveSection} />;
      case 'leave': return <HRLeaveManagement />;
      case 'disciplinary': return <HRDisciplinary />;
      case 'audit': return <HRAudit />;
      case 'approval-history': return <ApprovalHistoryLog />;
      case 'departments': return <HRDepartments />;
      case 'submitted-reports': return <HRSubmittedReports />;
      case 'report-archive': return <ReportArchiveList />;
      default: return <HROverview onNavigate={setActiveSection} />;
    }
  };

  return (
    <ExecutiveDashboardLayout
      role="hr"
      activeTab={activeSection}
      onTabChange={setActiveSection}
      badges={pendingLeave > 0 ? { leave: pendingLeave } : undefined}
      pulseBadgeIds={['leave']}
    >
      {renderContent()}
    </ExecutiveDashboardLayout>
  );
}