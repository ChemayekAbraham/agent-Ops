import HRPlaceholderPage from './HRPlaceholderPage';
import MetricDefinitionsAdmin from '../components/MetricDefinitionsAdmin';

export default function MetricDefinitionsPage() {
  return (
    <HRPlaceholderPage heading="Metric Definitions" subtitle="Configure what each department is measured on">
      <MetricDefinitionsAdmin />
    </HRPlaceholderPage>
  );
}
