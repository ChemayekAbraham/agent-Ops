import HRPlaceholderPage from '@/hr/pages/HRPlaceholderPage';
import Contracts from '@/hr/contracts/Contracts';

export default function ContractsPage() {
  return (
    <HRPlaceholderPage
      heading="Contracts and MOUs"
      subtitle="Employment contracts, MOUs and filed documents"
    >
      <Contracts />
    </HRPlaceholderPage>
  );
}
