// What a landlord rent receipt looks like when it is quoted in a message.
//
// The landlord's SMS (landlord-rent-receipt) and the agent's SMS and email
// (rent-plan-transition-notices) all quote the same receipt: its number, its
// code, the public page it is read at, and the moment it was paid. They live
// here so the three can never point at different pages or show different times.

/** The public page a receipt is read at: `${RECEIPT_BASE_URL}/${receipt_code}`. */
export const RECEIPT_BASE_URL = 'https://welileapp.com/r';

export const receiptUrl = (code: string): string => `${RECEIPT_BASE_URL}/${code}`;

/** "09 Oct 2026, 12:15" in Kampala time, whatever timezone the function runs in. */
export function formatReceiptDateTime(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Kampala',
  });
}
