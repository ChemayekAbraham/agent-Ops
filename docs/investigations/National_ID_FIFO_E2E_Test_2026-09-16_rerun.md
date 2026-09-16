# National ID FIFO — creation, duplication, linking and verification E2E re-run

**Date:** 2026-09-16 · **Database:** RentFlow (production) · **Data:** synthetic only, every
scenario ran inside `BEGIN … ROLLBACK`, so nothing was saved. Two live IDs were only *read*
(hint lookups), never written.

## Why this re-run happened

Reported: "the ID of 0701355245 already exists but when I try to enter the same ID and name I
get no feedback." Confirmed. The duplicate check only ran when the user pressed **Send my
photos for verification**, and that button is disabled until both photos and the payout code
are done. So a person typing an ID that already belongs to someone saw nothing at all.

## Fixes made during this run

1. **Live duplicate feedback while typing** (`src/components/wallet/IdentityPhotoCapture.tsx`)
   A debounced check (500 ms) now calls `national_id_holder_hint` as the National ID is typed
   and shows, immediately:
   - "This National ID is already on **Joseph**'s Welile account. You can be added under
     Joseph, but they must agree first." plus "1 of 20 accounts are on it."
   - or, when full: "This National ID has reached its limit of 20 accounts. No more accounts
     can be added to it."
2. **Holder name in the older prompt** (`NationalIdPrompt.tsx`) — the generic refusal now
   looks up and names the holder's first name too.
3. **Approved link was still blocked** — found by this test, fixed in migration
   `0142_national_id_link_owner_approved_unblocks_submit.sql`. After the holder entered the
   code and pressed **Approve**, the request sat at `owner_approved`, but
   `submit_national_id_details` only accepted a *staff-confirmed* link, so the joining person
   was refused with the exact message they had just resolved — a dead end. Staff confirmation
   belongs to verification, not to whether someone may record their own details. Nothing else
   in the function changed.

## Results — every scenario

| # | Scenario | Outcome |
|---|----------|---------|
| 1 | New ID registered | Saved, tied to the first account (FIFO). Its ID name is recorded on that account. |
| 2 | Same ID registered by a second person | Refused with the holder's **first name** and "1 of 20 accounts", offering to be added under them. |
| 3 | Typing hint (before pressing anything) | Returns holder first name + accounts-on-ID. Also matches look-alike IDs (letter O vs digit 0). |
| 4 | Link requested | Created, status `awaiting_owner`; holder named back to the requester. |
| 5 | Holder presses Approve **before** the code is entered | Refused: "The person asking has not yet entered the code sent to your number." |
| 6 | Code recipient | Resolved **server side** from the request — the requester cannot choose who gets it. |
| 7 | Code entered, then holder approves | `owner_approved`; requester's poll sees it. |
| 8 | Requester submits under the approved link | **Now succeeds** (was the defect). Recorded as a linked account; the first holder stays sole owner of the ID. |
| 9 | Requester keeps their own name | Yes — their profile name is unchanged; only the first holder inherits the ID name. |
| 10 | Holder rejects | `rejected_by_owner` with the written reason; a later submit is refused again. |
| 11 | Request left 7 days | `expired`; cannot be used. |
| 12 | ID already on 20 accounts | Submit, typing hint and new link request all refused: "reached its limit of 20 accounts." |
| 13 | Reordered names ("Mata Pius" vs "PIUS mata") | Both resolve to the same key `MATA PIUS` and are detected as the same name. |
| 14 | Reported live ID `CM021191019AHJ` | Hint and submit both now return the holder's first name and the "be added under them" path. |

## Text messages sent

- **Confirming a payout number:** "Welile: {name} wants to receive Welile payouts on a mobile
  money number ending {last4} registered in your name ({holder}). If you agree, share this
  code with them: {code}. If you did NOT authorise this, ignore this message."
- **Someone asking to join your National ID:** "Welile: {name} wants to link their Welile
  account to your National ID {NIN}. If you agree, share this code with them: {code}. You
  must also confirm it in the Welile app. If you did NOT authorise this, ignore this message."
- **Withdrawal code:** "Welile withdrawal code: {code}. Valid 10 min. Do not share it."
- **A number already tied to another account:** deliberately **no** message is sent to that
  other person on a mere attempt — nothing is disclosed until a request is actually raised.

## Note (not a defect)

The holder's first name for the reported live account reads "Piuslubega" because the name
stored on that account has no space between the two words. It comes straight from the stored
name; no code change was made for it.
