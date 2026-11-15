import PersonalLayout from '@/components/layout/PersonalLayout';
import { StaffApprovalsQueue } from '@/components/requisitions/StaffApprovalsQueue';

/** Where the staff loan and facilitation reminders lead: approve, decline or pay what is waiting on you. */
export default function StaffApprovals() {
  return (
    <PersonalLayout title="Staff loans and facilitation">
      <StaffApprovalsQueue />
    </PersonalLayout>
  );
}
