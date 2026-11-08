import { useSearchParams } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import HRPlaceholderPage from './HRPlaceholderPage';
import StaffDirectory from '../components/StaffDirectory';
import PayrollEnrollment from '@/hr/pay/PayrollEnrollment';
import Contracts from '@/hr/contracts/Contracts';
import HRBirthdayRegister from '@/components/hr/HRBirthdayRegister';
import DeskAccessManager from '../components/DeskAccessManager';
import { useMyDeskAccess } from '@/pages/desk/deskAccess';

const TABS = [
  { value: 'directory', label: 'Directory' },
  { value: 'enrollment', label: 'Pay setup' },
  { value: 'contracts', label: 'Contracts' },
  { value: 'documents', label: 'Documents' },
  { value: 'birthdays', label: 'Birthdays' },
] as const;

/** Shown only to people who may manage desk access (desk_my_access().can_manage). */
const DESKS_TAB = { value: 'desks', label: 'Desks' } as const;

export default function PeoplePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const access = useMyDeskAccess();
  const canManageDesks = access.data?.can_manage === true;
  const tabs = canManageDesks ? [...TABS, DESKS_TAB] : TABS;
  const active = tabs.some((t) => t.value === requested) ? (requested as string) : 'directory';

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
          {tabs.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="directory">
          <StaffDirectory />
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

        <TabsContent value="birthdays">
          <HRBirthdayRegister />
        </TabsContent>

        {canManageDesks && (
          <TabsContent value="desks">
            <DeskAccessManager />
          </TabsContent>
        )}
      </Tabs>
    </HRPlaceholderPage>
  );
}
