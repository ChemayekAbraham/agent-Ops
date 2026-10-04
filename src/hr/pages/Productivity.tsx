import HRPlaceholderPage from './HRPlaceholderPage';
import DepartmentProductivity from '../components/DepartmentProductivity';

export default function ProductivityPage() {
  return (
    <HRPlaceholderPage heading="Productivity" subtitle="Performance against defined metrics">
      <DepartmentProductivity />
    </HRPlaceholderPage>
  );
}
