import { HelpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

// Plain-language notes on how the all-time rent request figures are counted.
const NOTES: [string, string][] = [
  ['All time', 'These figures cover every rent request since the start. The date filter on this page does not apply to them.'],
  ['The journey', 'Each stage counts the requests that cleared it or went further. A request that was rejected, cancelled or withdrawn is placed at the stage where it ended, and it only counts for the stages before that one.'],
  ['In approval', 'Requests that have passed the Service Centre and are waiting between Agent Ops and the executive approval.'],
  ['Financed', 'A Rent Plan is financed once the landlord has actually been paid out of the agent float. The four repayment groups always add up to the financed number.'],
  ['Never paid', 'The landlord was paid more than 30 days ago and the tenant has paid nothing yet. A request paid 30 days ago or less is shown as Too early instead.'],
  ['Landlord-paid date', 'The date shown for the landlord payment is approximate. It is the earliest update time on the landlord payment record, and it will be replaced by the real paid date once that date is stored.'],
  ['Money recovered', 'What tenants have repaid out of what they owe in total, over the financed Rent Plans only.'],
];

export function TenantOpsRentLifetimeHowCounted() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="min-h-11 text-xs" data-testid="lifetime-how-counted">
          <HelpCircle className="mr-1.5 h-4 w-4" />How these are counted
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[70vh] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto" data-testid="lifetime-how-counted-body">
        <p className="mb-2 text-sm font-bold text-foreground">How these are counted</p>
        <dl className="space-y-2">
          {NOTES.map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs font-semibold text-foreground">{k}</dt>
              <dd className="text-xs text-muted-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}
