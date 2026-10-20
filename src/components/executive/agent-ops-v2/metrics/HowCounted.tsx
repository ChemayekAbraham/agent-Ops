import { HelpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

// Plain-language notes on how the Metrics figures are counted, written for the people who read the page, not for engineers.
const NOTES: [string, string][] = [
  ['Dates', 'Every date is a Kampala day. The range runs from the start of the first day to the end of the last day.'],
  ['Houses listed', 'Houses an agent listed on the app during the dates. Each house is counted once, under the agent who listed it.'],
  ['Verified, pending, rejected', 'A listed house is either verified, still waiting, or rejected, so those three always add up to the houses listed. The Rejected figure on the Listings card counts rejection decisions made in the dates, which can include houses listed earlier, so it can differ from the number of listed houses that are rejected now.'],
  ['Listing earnings', 'What agents were paid for listings, taken only from the company ledger. Money taken back for rejected listings is shown separately as clawed back. Net on the Agents card is earnings less what was clawed back, worked out by the server.'],
  ['Advances', 'Advances given and repaid are for advances issued in the dates. Outstanding and overdue are today\'s balances. Outstanding includes advances being repaid from Returns, which the Advance Repayment Monitor leaves out, so this figure can be higher than the monitor\'s.'],
  ['Listing quality', 'Approval rate is the houses verified out of the houses listed in the dates. Days to verify is the average time between listing a house and its verification. Occupied and empty tell you whether a tenant has been placed in the house. Earnings per verified house is the listing earnings of the dates divided by the houses verified, worked out by the server.'],
  ['Currently rejected', 'Houses listed in the dates that are rejected right now. Verified, pending and currently rejected always add up to the houses listed. It is not the same as Rejected above it, which counts rejection decisions made in the dates.'],
  ['Waiting longest', 'Houses still waiting for verification today, oldest first, whatever date they were listed. The number of days is counted in Kampala days.'],
  ['Risk', 'Advance with no listing means an agent who owes an advance today and listed no house in the dates. The flag compares the advance outstanding with what the agent earned from listings in the dates: no listing earnings, high at 3 times or more, watch from 1 to 3 times, low under 1. These come from the server and are not worked out on this page.'],
  ['Inactive and never listed', 'An inactive lister has listed before but nothing in the last 30 days. A sub-agent who never listed has a verified link to a main agent and no house of their own. Neither depends on the dates you picked.'],
  ['Team owes most', 'Main agents ranked by the advance their team still owes today, biggest first.'],
  ['Who is counted', 'Qualifying agents are the agents Agent Ops counts. Main agents are the agent a sub-agent was first verified under. Accounts that have been deleted are left out everywhere.'],
  ['Map', 'The map shows every house with a recorded position in the part of the country you can see, not only the houses listed in the dates. It appears on larger screens; on a phone use the district list.'],
];

export function HowCounted() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="min-h-11 text-xs" data-testid="metrics-how-counted">
          <HelpCircle className="mr-1.5 h-4 w-4" />How these are counted
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[70vh] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto" data-testid="metrics-how-counted-body">
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
