import { useEffect, useState } from 'react';
import { SelfPortfolioPlanDetailSheet } from '@/components/partner/SelfPortfolioPlanDetailSheet';

let mounts = 0;
export default function DevPlanSheetProbe() {
  const [open, setOpen] = useState(false);
  const [clicks, setClicks] = useState(0);
  useEffect(() => { mounts += 1; console.log('PROBE mount', mounts); }, []);
  const plan = {
    rent_request_id: 'x', funding_amount: 440000, duration_days: 30, daily_repayment: 9200,
    request_city: 'OLD ENTEBBE', house_category: 'single-room', projected_end_date: null,
    repayment_cadence: 'daily', tenant_full_name: 'Test Tenant', tenant_first_name: 'Test',
    tenant_location: 'BBANGA, OLD ENTEBBE', tenant_avatar_url: null,
    landlord_name: 'Landlord', landlord_phone: null, lc1_chairperson_name: null,
    house_image_urls: ['https://placehold.co/600x400'], proxy_agent_phone: null,
  } as any;
  return (
    <div className="p-6">
      <button id="probe-open" className="rounded bg-primary px-4 py-2 text-primary-foreground"
        onClick={() => { console.log('PROBE click'); setClicks((c) => c + 1); setOpen(true); }}>
        open o={String(open)} c={clicks} m={mounts}
      </button>
      <SelfPortfolioPlanDetailSheet plan={plan} open={open} onOpenChange={setOpen} isFunded={false} />
    </div>
  );
}
