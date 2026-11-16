import { Clock } from 'lucide-react';
import { BOOKED_BY_ME_TEXT } from './funderListRefresh';

/**
 * In place of "Fund this House" on a Rent Plan that is already funded or
 * claimed. The funder who funded it sees "Booked — waiting for landlord
 * payment"; anyone else sees it is taken.
 */
export function BookedNotice({ mine }: { mine: boolean }) {
  return (
    <p
      data-testid="fv3-booked-notice"
      data-mine={mine ? 'true' : undefined}
      className="flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded-xl bg-blue-500/10 px-3 text-[13px] font-semibold leading-snug text-blue-700 ring-1 ring-blue-500/30 dark:text-blue-300"
      style={{ margin: 0 }}
    >
      <Clock className="h-4 w-4 flex-none" aria-hidden />
      <span className="min-w-0">{mine ? BOOKED_BY_ME_TEXT : 'Booked by a funder — view only'}</span>
    </p>
  );
}

export default BookedNotice;
