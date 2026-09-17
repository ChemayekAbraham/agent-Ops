# 65 — "Send my photos" ring spins then silently resets — a stale-closure bug swallowed the real error

**Read this before touching `saveDetails`/`handleSave` in `IdentityPhotoCapture.tsx`. Follows on
from doc 59 (same button, same account, different root cause).**

## What was reported

After doc 59's fix shipped (moving the blockers panel next to the Send button), Josh reported that
on Ssemanda's account the photos genuinely were all attached this time, but tapping "Send my photos
for verification" showed the loading ring spin, then reset back to normal with no message —
"failing silently," prompting another tap.

## What was found

`saveDetails()` calls `submit_national_id_details` and, on a server-side rejection, sets the
`fieldError` state (rendered far up the page, next to the six ID fields) and returns `false`.
`handleSave()` awaited it and branched:

```ts
const detailsOk = await saveDetails();
if (!detailsOk) {
  setSaving(false);
  return;   // no sendError, no toast — the spinner just stops
}
```

The plan was presumably that `fieldError` would already be visible. But `fieldError` is a `useState`
value read from `handleSave`'s own closure — the `setFieldError(...)` call inside `saveDetails()`
schedules a state update for the *next* render; it does not retroactively change the `fieldError`
variable `handleSave` is still holding in the current call. So even a caller that tried
`fieldError?.message` right after the `await` would see whatever `fieldError` held *before* this
attempt (`null`, on a fresh try) — not the new rejection. The net effect: the RPC call runs, gets
rejected (wrong NIN format, a fresh duplicate, a transient error, whatever), and the only visible
change is the button becoming tappable again. No `sendError`, no toast, nothing near the button.

Live, this is exactly what happened once for Ssemanda's account before a later retry succeeded (see
doc 58/59's audit-log timeline) — one attempt at `submit_national_id_details` presumably failed
first, resulting in this silent reset, before a subsequent tap actually went through.

## What was fixed

`saveDetails()` now returns `{ ok: boolean; message?: string }` instead of a bare `boolean`, so the
failure message travels back through the return value rather than through state the caller can't
freshly read. `handleSave()` uses that returned message to set `sendError` and fire a `toast.error`
on a `saveDetails()` failure, same as every other failure path in this function already did. Between
this and doc 59's panel relocation, every reason `handleSave` can stop — blockers, a details-save
rejection, or the try/catch's own failures — now shows up in the same place, right above the button.

No other behavior changed: `fieldError` is still set and still renders next to the six fields as
before, for anyone scrolled up to check the actual field values against the rejection.

## What not to do

- Don't reach for `fieldError` (or any other piece of `useState`) as "the result of the async call I
  just awaited" inside the same function — a state setter's effect isn't visible until the next
  render. Return the value you need directly from the function that set it.
- Don't assume a report of "fails silently" is a network/RPC problem before checking whether the
  call is even reaching the server (see doc 59) or whether it's reaching the server and getting
  rejected with the message just never displayed (this doc). Both look identical from a screenshot
  of the button alone.
