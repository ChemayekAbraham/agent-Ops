/**
 * Dev-only Playwright harness: the Quick Promissory Note dialog on its own, with the
 * Tenants step's house and plan lists seeded (one house with a very long name and
 * address), so phone-width layout can be checked without the agent dashboard.
 * The create call is answered by the spec's network mock.
 *
 * Mounted at `/__e2e/promissory-note` only when `import.meta.env.DEV` is true.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PromissoryNoteDialog } from '@/components/agent/PromissoryNoteDialog';

const LONG_HOUSE = {
  house_id: 'e2e-house-1',
  title: 'Spacious two-bedroom self-contained family house with a big compound behind the Nakawa market roundabout',
  house_category: 'two_bedroom',
  monthly_rent: 450000,
  district: 'Kampala Central Division Extended Metropolitan Area',
  sub_county: 'Nakawa Division Upper Kiswa Parish',
  village: 'Kiswa Zone B behind the old Shell petrol station near Nakawa Market',
  region: 'Central',
  number_of_rooms: 2,
  verified: true,
  listing_agent_id: null,
  listing_agent_name: 'Agent E2E',
  latitude: 0.33,
  longitude: 32.61,
  landlord_name: 'Landlord With A Very Long Registered Business Name Limited',
  landlord_phone: '0772000000',
  partner_monthly_return: 67500,
  partner_annual_return: 810000,
};

export default function PromissoryNoteHarness() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(() => {
    qc.setQueryData(['promissory-fundable-houses', ''], { houses: [LONG_HOUSE], total: 1 });
    qc.setQueryData(['promissory-fundable-plans', ''], { plans: [], total: 0, available_pool: 0 });
    return true;
  });
  return (
    <div data-testid="e2e-promissory-note-harness" className="p-4">
      <button data-testid="open-dialog" onClick={() => setOpen(true)}>Open</button>
      <PromissoryNoteDialog open={open} onOpenChange={setOpen} supportMode="self" />
    </div>
  );
}
