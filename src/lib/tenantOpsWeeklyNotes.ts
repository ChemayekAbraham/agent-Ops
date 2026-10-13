/** Shown on the first week counted from the landlord-paid clock (page and PDF). */
export const WEEKLY_COUNTING_CHANGED_NOTE =
  'Counting changed this week - earlier weeks used the old start date';

/** Shown above the weekly figures (page and PDF). */
export const WEEKLY_CLOCK_NOTE = 'Counted from the day after the landlord was paid';

export const landlordNotPaidLine = (n: number) =>
  `Landlord not paid yet: ${n.toLocaleString('en-US')} plan${n === 1 ? '' : 's'} (not counted as owing)`;
