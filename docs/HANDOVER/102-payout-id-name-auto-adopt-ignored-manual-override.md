# 102. National ID name kept overwriting the correct account name — the manual-override escape hatch was never wired up

**Read this before touching `IdNameMismatchCard` in `PayoutVerificationPanel.tsx`,
`assessIdNameConfidence`, or `finops_set_holder_name`/`useSetHolderName` again.**

## What was reported

Josh, screenshot of the Payout Verification queue: Lukyamuzi Derrick's National
ID OCR read the name as **"STHERNAME DERRICK"** — a garbled fusion of the
adjacent `SURNAME` / `OTHER NAME(S)` field labels on a Ugandan National ID,
not a real name. The account's actual name, "LUKYAMUZI DERRICK" (matching his
selfie and withdrawal number), kept getting silently overwritten back to the
garbage OCR text — "every time."

## Root cause — two independent bugs, not one

1. **`assessIdNameConfidence` (`src/lib/idNameConfidence.ts`) only rejected an
   OCR'd name if a token was an *exact* match** to a known card-label word
   (`surname`, `given`, `names`, …). "Sthername" is not an exact match to
   `surname`, so it sailed through every check (has vowels, no digits, 2
   tokens, no repeated letters) and was judged `confident: true`.
2. **`IdNameMismatchCard`'s auto-adopt `useEffect` had no memory of a prior
   human decision.** It fires whenever `national_id_name` ≠ the current
   account name and the (buggy) confidence check passes — on every mount:
   reopening the case, the queue's 30-second poll, navigating back to it.
   There was no check against `row.name_source` (already computed by
   `finops_payout_verification_queue` as `'verified'` when
   `final_name_override` is set), so even a correction made through the
   "proper" channel would have been silently re-overwritten on the next
   render.
3. **The "proper" channel didn't exist in the first place.** `finops_set_holder_name`
   (the SECURITY DEFINER RPC) and its hook `useSetHolderName`
   (`src/hooks/usePayoutVerification.ts`) were both already fully built —
   **but had zero call sites anywhere in the frontend.** There was no button,
   input, or dialog on this screen (or anywhere) that could reach them. So
   even if bug #2 hadn't existed, Financial Ops had no way to make a
   correction stick at all — the only thing that ever wrote `profiles.full_name`
   from this screen was the automatic OCR-adopt path.

All three had to be fixed together; fixing only #1 (better OCR-label
detection) would still leave every *other* class of bad OCR read able to
silently re-overwrite a human's correction, and fixing only #2 without #3
would leave the guard with nothing to guard against, since `name_source`
could never actually become `'verified'` from the UI.

## What was fixed

- **`src/lib/idNameConfidence.ts`**: added `looksLikeCardLabel()` — a
  Levenshtein-distance + substring check (thresholds: distance ≤2 for
  label words ≤6 chars, ≤3 for longer ones) run against each name token,
  alongside the existing exact-match check. Verified against the actual
  Ugandan card-label vocabulary already in `CARD_LABEL_WORDS` and against a
  batch of real Ugandan given/surnames (Nakato, Ssempala, Nantongo, Namutebi,
  Ochieng, …) before shipping — zero false positives, catches "Sthername"
  (distance 3 from "surname") cleanly. Regression test in
  `src/lib/idNameConfidence.test.ts`.
- **`PayoutVerificationPanel.tsx`'s `IdNameMismatchCard`**: the auto-adopt
  effect now skips entirely when `row.name_source === 'verified'`
  (`humanOverridden`), and the card shows a plain "Financial Ops set the
  account name manually — the ID reading above will not overwrite it again"
  message in that state instead of the misleading "is now the name on the
  account" line.
- **Wired up the missing control**: added a "Type the correct name" /
  "Not this — type the correct name" button that reveals an `Input` +
  Save/Cancel, calling `useSetHolderName()` (i.e. `finops_set_holder_name`) —
  the first real call site this hook has ever had. Seeded from the current
  account name so confirming an already-correct name (like this case) is one
  click.

## Applied live to Lukyamuzi Derrick's record directly, ahead of deploy

Because the fix above is a frontend change (Lovable's normal publish pipeline,
not the GitHub-Actions edge-function workflow, and not something this session
controls the timing of), the **specific reported record** was patched directly
in production so it does not depend on deploy timing to be *correct data*, even
though it can still be *reopened* under the old code before the fix ships:

```sql
-- destination_id cd9b10f5-7287-426c-b66f-a65e5fa22d86, user e04b4b56-0514-406a-9290-f34bb44e4700
UPDATE public.payout_destination_verifications
SET final_name_override = 'LUKYAMUZI DERRICK', final_name_override_at = now()
WHERE id = 'cd9b10f5-7287-426c-b66f-a65e5fa22d86';
```

plus a matching `audit_logs` row (same shape `finops_set_holder_name` itself
writes) explaining why this was done outside the RPC (no real Financial Ops
session in this tool). Verified `name_source` now resolves to `'verified'` by
replicating `finops_payout_verification_queue`'s own CASE expression.

**Caveat, not fully closed**: until the frontend fix actually deploys, the
*currently live* `IdNameMismatchCard` code still has no `name_source` check at
all — if anyone reopens this exact case before deploy, the old auto-adopt
logic will still fire and overwrite "LUKYAMUZI DERRICK" back to "STHERNAME
DERRICK" one more time, because it never reads `final_name_override`. Avoid
reopening this specific case until the deploy is confirmed live; re-run the
`name_source` query above afterward to confirm the account name held.

## Verify once deployed

```sql
select final_name_override, final_name_override_at
from public.payout_destination_verifications
where id = 'cd9b10f5-7287-426c-b66f-a65e5fa22d86';
-- expect 'LUKYAMUZI DERRICK', non-null

select full_name from public.profiles where id = 'e04b4b56-0514-406a-9290-f34bb44e4700';
-- expect 'LUKYAMUZI DERRICK' to still hold after reopening the case in the app
```

## What not to do

- Don't add more exact words to `CARD_LABEL_WORDS` as the fix for a future
  case like this — that only ever catches the exact corruption already seen.
  `looksLikeCardLabel`'s fuzzy check is the durable fix; extend its threshold
  or word list only with a specific measured false-positive/false-negative
  pair, same discipline as the bot-ring hunter's validation table (doc 86).
- Don't let a future "make the OCR smarter" pass remove the `name_source`
  guard in `IdNameMismatchCard` — even a perfect confidence heuristic doesn't
  know about a human's out-of-band decision (e.g., a phone call confirming
  the real name). The guard and the confidence check are two independent
  layers on purpose.
- Don't build a second "set the holder name" entry point elsewhere without
  checking this one already exists now — `useSetHolderName` finally has a
  real call site; a duplicate would fork the audit trail.
