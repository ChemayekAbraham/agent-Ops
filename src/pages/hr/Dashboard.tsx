import ExecutiveDashboardLayout from '@/components/layout/ExecutiveDashboardLayout';
import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { usePersistedActiveTab } from '@/hooks/usePersistedActiveTab';
import HROverview from '@/components/hr/HROverview';
import HRLeaveManagement from '@/components/hr/HRLeaveManagement';
import HRPayroll from '@/components/hr/HRPayroll';
import HRDisciplinary from '@/components/hr/HRDisciplinary';
import HRAudit from '@/components/hr/HRAudit';
import HRDepartments from '@/components/hr/HRDepartments';
import HRInternshipApplications from '@/components/hr/HRInternshipApplications';
import { RequisitionsWorkspace } from '@/components/requisitions/RequisitionsWorkspace';

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

  useEffect(() => {
    void refreshLeaveBeacon();
    const channel = supabase
      .channel('hr-leave-beacon')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'leave_requests' },
        () => { void refreshLeaveBeacon(); },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [refreshLeaveBeacon]);

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
      case 'payroll': return <HRPayroll />;
      case 'disciplinary': return <HRDisciplinary />;
      case 'audit': return <HRAudit />;
      case 'departments': return <HRDepartments />;
      case 'internships': return <HRInternshipApplications />;
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