# 36 — National ID card number rejected new NIRA alphanumeric format

**Migration written but NOT yet deployed — `submit_national_id_details` on production still
rejects any card number containing a letter. Read this before assuming the fix is live, and
before touching `national_id_card_number` capture anywhere in the app.**

## The report

Josh: NIRA's newly issued ID cards print a card number that includes letters (example given:
`CA144787388` — 2 letters + 9 digits). The system only ever captured digits for this field.

## What "card number" is, and why it's different from the NIN

`profiles.national_id_card_number` is **not** the NIN (`profiles.national_id`). It's the number
printed on the physical card that changes every time the card is reissued — see the column
comment added in `20260915120000_national_id_read_and_confirm.sql`. The NIN field
(`src/lib/nationalId.ts`) already accepted alphanumeric values (10–14 chars, `C`/`A` + `M`/`F`
prefix rule) — that part of `/settings` was never broken. The card number field was the one
hard-coded to digits-only, in four independent places that all needed the same fix:

1. **`supabase/functions/read-national-id/index.ts`** (OCR reader response) — stripped
   `card_number` to `[^0-9]` before returning it to the client.
2. **`src/lib/nationalIdOcr.ts`** (`normaliseReading`) — re-stripped the same field to `[^0-9]`
   client-side as a defensive re-normalisation.
3. **`src/components/wallet/IdentityPhotoCapture.tsx`** (manual-entry fallback form) —
   `inputMode="numeric"` on the input plus an `onChange` handler stripping to `[^0-9]` on every
   keystroke, so a phone's numeric keypad couldn't even type a letter.
4. **`submit_national_id_details(...)`** (the `SECURITY DEFINER` RPC that actually persists the
   value) — normalised with `regexp_replace(..., '[^0-9]', '', 'g')` and validated
   `v_card !~ '^[0-9]{6,12}$'`, returning `'The card number is the row of digits on the card.'`
   for anything else. **This is the layer that matters** — even if every frontend layer above had
   accepted letters, this RPC would still have silently thrown away every non-digit character
   before saving. Confirmed against the live function definition via `query_database` before
   editing (`supabase/migrations/` is not guaranteed to reflect prod — see doc 06).

## The fix

All four normalise to uppercase alphanumeric (`[^A-Z0-9]`) instead of digits-only, and the RPC's
validation widened from `^[0-9]{6,12}$` to `^[A-Z0-9]{6,14}$` with an explicit `~ '[0-9]'` check
so a value that's all letters (garbage/mistyped) is still rejected — same philosophy
`validateNationalId` already uses for the NIN field. `IdentityPhotoCapture.tsx`'s manual-entry
input dropped `inputMode="numeric"` for this field since it can now contain letters.

Migration: `supabase/migrations/20260916150000_national_id_card_number_accepts_letters.sql` —
a full `CREATE OR REPLACE FUNCTION public.submit_national_id_details(...)`, identical to the live
version except the two lines above and the error copy. **Not yet applied to production** — every
other recent `supabase/migrations/` fix in this repo has needed a manual run via the Supabase SQL
editor (see doc 33, doc 34); this one will too. `query_database` DDL against prod is
auto-refused by the tool's classifier (see memory `project_query_database_ddl_blocked_migrations_only`),
so it could not be applied directly from this session.

## What to check before trusting this is live

```sql
select pg_get_functiondef(oid) from pg_proc where proname = 'submit_national_id_details';
```

If the body still contains `'[^0-9]'` for `v_card` or the message `'The card number is the row of
digits on the card.'`, the migration has not been run yet and new-format cards will still fail to
save even though the frontend now lets you type them.

## Scope note

Only `national_id_card_number` was touched. `national_id` (the NIN) was already alphanumeric end
to end and needed no change. No other table or RPC references `national_id_card_number` besides
`profiles`, `national_id_readings.ocr`/`field_verdicts` (JSON, untyped) and
`user_identity_bindings` (copied verbatim from `profiles`, no independent validation).
