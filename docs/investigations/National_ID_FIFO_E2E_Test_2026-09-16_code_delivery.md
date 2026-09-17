# National ID FIFO — code delivery, holder approval and requester notice

**Date:** 2026-09-16 · **Database:** RentFlow (production) · **Data:** synthetic only, run inside
`BEGIN … ROLLBACK`. Nothing was saved, no real person was contacted, no real money touched.

## The reported problem: "the code is not being sent"

Confirmed, and it was the whole cause: the service that sends the code to the National ID
holder (`national-id-link-otp`) **had never been published**. It had no execution history at
all, so every attempt from the app failed before a message could be composed. It is now
deployed and live.

## Issues found and fixed in this run

1. **Code service never deployed** — deployed. Codes now go to the holder's own number, which
   is resolved on the server from the holder's record; the person asking never chooses it.
2. **"Code sent" was ticked before the message left** (migration
   `0143_national_id_link_code_sent_after_delivery`). The lookup that resolves the holder's
   number used to stamp the request as "code sent" straight away, so a failed text still showed
   the asker a code box for a code that never arrived. The stamp now happens only after the
   gateway accepts the message, through a separate service-only step
   (`national_id_link_mark_code_sent`). The old behaviour could not be retried honestly; this
   one can.
3. **The person asking was not told the outcome** (`NationalIdLinkFlow.tsx`). The screen polled
   the request but said nothing when the holder answered. It now raises a clear message the
   moment the status changes — allowed, refused, staff-confirmed, staff-refused, or closed after
   7 days — and unblocks the asker's own details as soon as the holder allows it.
4. **The holder could allow or refuse in one tap** (`NationalIdLinkGate.tsx`). A confirmation
   step now sits in front of both answers, so an accidental tap cannot hand an identity away.
   The dialog itself still cannot be dismissed until it is answered.

## Verified end to end (all pass)

| # | Scenario | Outcome |
|---|----------|---------|
| 1 | New ID registered | Saved and tied to that one account (FIFO); the ID name is taken onto it |
| 2 | Second person submits the same ID | Refused, naming the holder's **first name** and "1 of 20 accounts", offering to be added under them |
| 3 | Typing hint, before pressing anything | Returns holder first name and account count |
| 4 | Look-alike reading (letter O for digit 0) | Matched to the same ID, refused the same way |
| 5 | Link requested | Created, `awaiting_owner`, holder's first name returned |
| 6 | Code recipient | Resolved **server side** from the holder's record: `+2567…326` in the rehearsal |
| 7 | Holder approves **before** the code is entered | Refused: "The person asking has not yet entered the code sent to your number." |
| 8 | Before the text is accepted | Request reads "code not sent" — no code box shown |
| 9 | After the text is accepted | Request reads "code sent" — code box appears |
| 10 | Code entered, holder approves | `owner_approved`; the asker's screen sees it and says so |
| 11 | Asker submits under the approved link | Succeeds; recorded as a linked account, the first holder stays sole owner |
| 12 | Asker's own name | Kept and editable — only the first holder inherits the ID name |
| 13 | Holder refuses | `rejected_by_owner` with the written reason; a later submit is refused again |
| 14 | Request left 7 days | `expired` and unusable |
| 15 | ID already on 20 accounts | Submit, typing hint and new request all refused with the limit message |
| 16 | Reordered names ("Mata Pius" / "PIUS mata") | Both resolve to the same key `MATA PIUS` and are detected |
| 17 | Reported live ID `CM021191019AHJ` | Hint and submit both name the holder and offer the "be added under them" path |

## Text messages sent

- **Someone asking to join your National ID:** "Welile: {name} wants to link their Welile
  account to your National ID {NIN}. If you agree, share this code with them: {code}. You must
  also confirm it in the Welile app. If you did NOT authorise this, ignore this message."
- **Confirming a payout number:** "Welile: {name} wants to receive Welile payouts on a mobile
  money number ending {last4} registered in your name ({holder}). If you agree, share this code
  with them: {code}. If you did NOT authorise this, ignore this message."
- **Withdrawal code:** "Welile withdrawal code: {code}. Valid 10 min. Do not share it."
- **A number already tied to another account:** no message is sent to that other person on a
  mere attempt — nothing is disclosed until a request is actually raised.

## Notes (not defects)

- The holder's first name for the reported live account reads "Piuslubega" because the stored
  name has no space between the two words.
- The asker's screen checks every 25 seconds, so the holder's answer appears within about half a
  minute without any refresh.
