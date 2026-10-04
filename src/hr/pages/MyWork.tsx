import PersonalLayout from '@/components/layout/PersonalLayout';
import MyProxyInviteLink from '@/components/executive/MyProxyInviteLink';
import MyProxyNotesFeed from '@/components/executive/MyProxyNotesFeed';
import MyWork from '../components/MyWork';
import { useIsPartnerGrowthLead } from '../hooks/usePartnerGrowthLead';

export default function MyWorkPage() {
  const { data: isPartnerGrowthLead } = useIsPartnerGrowthLead();

  return (
    <PersonalLayout title="My work">
      {isPartnerGrowthLead && (
        <>
          <MyProxyInviteLink />
          <MyProxyNotesFeed />
        </>
      )}
      <MyWork />
    </PersonalLayout>
  );
}
