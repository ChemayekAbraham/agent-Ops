import { useParams } from 'react-router-dom';
import HRPlaceholderPage from './HRPlaceholderPage';
import StaffScorecard from '../components/StaffScorecard';

export default function StaffScorecardPage() {
  const { staffId } = useParams<{ staffId: string }>();
  return (
    <HRPlaceholderPage heading="Scorecard" subtitle="One person, one period, one set of numbers">
      {staffId ? (
        <StaffScorecard staffId={staffId} />
      ) : (
        <p className="text-sm text-muted-foreground">No staff member selected.</p>
      )}
    </HRPlaceholderPage>
  );
}