import { useSearchParams } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import HRPlaceholderPage from './HRPlaceholderPage';
import StaffDirectory from '../components/StaffDirectory';
import PayrollEnrollment from '@/hr/pay/PayrollEnrollment';
import Contracts from '@/hr/contracts/Contracts';
import HRBirthdayRegister from '@/components/hr/HRBirthdayRegister';

const TABS = [
  { value: 'directory', label: 'Directory' },
  { value: 'enrollment', label: 'Pay setup' },
  { value: 'contracts', label: 'Contracts' },
  { value: 'documents', label: 'Documents' },
] as const;

export default function PeoplePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const active = TABS.some((t) => t.value === requested) ? (requested as string) : 'directory';

  const handleChange = (value: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', value);
    setSearchParams(next, { replace: true });
  };

  return (
    <HRPlaceholderPage
      heading="People"
      subtitle="Everyone at Welile: the org chart, payroll enrollment, and their records."
    >
      <Tabs value={active} onValueChange={handleChange} className="space-y-4">
        <TabsList className="flex flex-wrap h-auto">
          {TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="directory" className="space-y-6">
          <StaffDirectory />
          <HRBirthdayRegister />
        </TabsContent>

        <TabsContent value="enrollment">
          <PayrollEnrollment />
        </TabsContent>

        <TabsContent value="contracts">
          <Contracts />
        </TabsContent>

        <TabsContent value="documents">
          <div>
            <h3 className="text-base font-semibold text-foreground">Staff documents</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Not built yet. Contracts of employment, certificates and identity documents arrive here.
            </p>
          </div>
        </TabsContent>
      </Tabs>
    </HRPlaceholderPage>
  );
}
