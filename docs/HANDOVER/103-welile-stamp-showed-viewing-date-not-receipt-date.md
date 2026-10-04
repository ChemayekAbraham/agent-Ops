# WelileStamp watermark showed today's date, not the receipt's date

**Fixed 2026-09-22.**

## Symptom

A customer opened an old payout receipt (transaction dated 11 Sept 2026, WhatsApp
screenshot from Josh) and the blue "WELILE TECHNOLOGIES LIMITED" authenticity
e-stamp watermarked across it showed **22 SEPT 2026** — the day the page happened
to be opened, not the day the payout was made. Every past receipt drifts to
whatever "today" is each time it's reopened, on the web page and in the
downloaded PDF alike.

## Root cause

`src/components/receipts/WelileStamp.tsx` — `stampDate()` called `new Date()`
unconditionally:

```ts
export function stampDate(): string {
  const today = new Date();
  return today.toLocaleDateString('en-GB', { ... }).toUpperCase();
}
```

Both call sites re-render the stamp on demand, long after the transaction:
- `src/pages/PayoutReceipt.tsx` renders `<WelileStamp watermark scale={0.62} />`
  every time `/r/:token` or `/receipt/:id` is loaded (customer reopening an old
  SMS/email/WhatsApp link, an agent pulling receipt history, etc.).
- `src/lib/payoutReceiptPdf.ts` `drawStampWatermark()` calls `stampDate()`
  every time `downloadPayoutReceiptPdf()` runs, i.e. every time anyone clicks
  "Download PDF" — including from `src/pages/agent/PayoutReceiptHistory.tsx`
  for a payout processed weeks earlier.

Note: a prior `mem/features/financial-ops/payout-proof-receipt.md` entry
(2026-07-07) recorded this as intentional — "the date is intentionally today's
viewing date (user requirement: keep the date dynamic)." That requirement was
reversed here: for a *proof-of-payment* document the stamp date must match the
transaction, not the viewing session, otherwise the same receipt shows a
different date every time it's opened, which undermines the "authenticity"
the stamp exists to convey.

## Fix

`stampDate()` now takes an optional `date` (string | Date | null) and only
falls back to `new Date()` when none is given:

```ts
export function stampDate(date?: string | Date | null): string {
  const d = date ? new Date(date) : new Date();
  return d.toLocaleDateString('en-GB', { ... }).toUpperCase();
}
```

`WelileStamp` takes the same optional `date` prop and passes it through.
Both call sites now pass the receipt's own `processed_at`:
- `PayoutReceipt.tsx`: `<WelileStamp watermark scale={0.62} date={data.processed_at} />`
- `payoutReceiptPdf.ts`: `drawStampWatermark(doc, cx, cy, data.processed_at)` →
  `stampDate(date)`

`PayoutReceiptHistory.tsx` needed no change — it calls the same
`downloadPayoutReceiptPdf(data)` used by the public page, so it inherited the
fix automatically.

## Files touched

- `src/components/receipts/WelileStamp.tsx`
- `src/pages/PayoutReceipt.tsx`
- `src/lib/payoutReceiptPdf.ts`

No migration, no edge function, no RPC — purely frontend/PDF rendering. No
data was ever wrong; only the stamp's displayed date was.
