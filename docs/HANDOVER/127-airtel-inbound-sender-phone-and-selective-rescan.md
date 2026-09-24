# 127 — Airtel inbound sender phone never parsed; selective rescan; TID-fragment phone match

**Status (2026-09-24):** code committed; deploy + Martha's recovery pending at time of writing
(see "Recovery" for what was run).

Follows handover 125 (the same-second cutoff drop) and 126 (tenant direct payments settle via
`settle_tenant_rent_from_deposit`).

## 1. Airtel "RECEIVED" emails never carried the sender phone

Airtel's inbound SMS shape is `RECEIVED. TID157162005754 UGX 21445 from 752251576 …`, a bare
9-digit subscriber number with no `0`/`256` prefix. The parser's last-resort phone capture
required the prefix, so **all 659 Airtel RECEIVED emails in the previous 14 days had
`counterparty = null`**. They were only matched when the payer had already submitted a deposit
request with the TID (599 via `auto_match_method = 'tid'`); 37 sat unmatched.

For a tenant paying the till directly with no deposit request (the whole point of handover 126's
path), the only remaining route to their profile was the looser body scan.

**Fix:** also accept `from 7XXXXXXXX` (inbound only). The bare form is deliberately not accepted
after `to`/`by`, so outbound Airtel shapes, which feed the payout auto-debit, are unchanged.

## 2. The body scan matched phone numbers inside TIDs

The body-phone fallback collected `(?:\+?256|0)?7\d{8}` with no digit boundaries, so in Martha's
email it also found `716200575` inside `TID157162005754`. If such a fragment equals a real
user's number while the actual sender is unknown, the payment is auto-credited to the wrong person.
**0 of 451** historical body-phone matches were affected (checked: the matched last-9 always
appears standalone in the body). Fixed with `(?<!\d)…(?!\d)`.

## 3. `only_message_ids` for rescan

Handover 125's rescan replays everything in a window. The four messages its dropped-message bug
lost all share one second (2026-09-23 11:05:52 UTC):

| Gmail id | What | Replay? |
|---|---|---|
| `1a0cdf18ac0479f7` | Martha Namigadde, UGX 21,445 in, TID157162005754 | **yes** |
| `1a0cdf18b3a628aa` | duplicate IFTTT copy of the same | yes (dedupes on TID) |
| `1a0cdf1865e4dd7e` | UGX 1,000,000 float send to **Babrah Tusingwire**'s merchant float phone 0741386321, 157162078664 | **held for FinOps** |
| `1a0cdf18b57bb8f7` | UGX 1,000,000 float send to **Shamirah Nakajjubi**'s merchant float phone 0706196246, 157162130828 | **must not replay** |

The four sibling sends ingested normally in those same minutes were all credited as merchant
float (`merchant_float_credited`), so a replay would credit Babrah's and Shamirah's float.
**Shamirah's desk was reset by an absolute "Merchant desk float set to 1,482,666 (books showed
0)" reconciliation at 2026-09-24 07:05 UTC**, which already absorbed the unbooked 1M. Replaying
would credit it a second time (the float "set to" vs. "add" over-credit pattern). Babrah has no
reconciliation since the send, so a replay is probably right, but it's FinOps' call.

`only_message_ids` (JSON body, ≤25 ids) restricts a rescan to the listed messages.

## Verification

- Parser test on real shapes: Martha's email → `cp 752251576` (was null); Airtel float send →
  `cp 0706196246` (unchanged); MTN `from (NAME) 256…` unchanged; outbound `to 752…` → `cp null`
  (unchanged). Body scan on Martha's email: old `[716200575, 752251576]`, new `[752251576]`.
- `deno check`: 46 pre-existing errors before and after. `guard:all` passes.

## Recovery

After deploy:

```json
POST /functions/v1/gmail-poll-transactions
{"rescan_from":"2026-09-23T11:00:00Z","rescan_to":"2026-09-23T11:10:00Z",
 "only_message_ids":["1a0cdf18ac0479f7","1a0cdf18b3a628aa"]}
```

Then check `tenant_self_repayment_attempts` for tenant `41383cef-a13c-456e-861d-01aa797f192c`.

## Open

- Babrah's 1M: replay `1a0cdf1865e4dd7e` the same way if FinOps confirms her books are short by it.
- Shamirah's 1M: leave it; her float was set absolutely afterwards. The email stays out of
  `gmail_transactions`, so the TID isn't reconciled anywhere; FinOps may want to note it.
- The 37 unmatched Airtel RECEIVED emails from the last 14 days predate this fix and aren't
  re-parsed automatically (`reparse` mode could refresh their counterparty; matching them would
  then still need the linked-pending / manual routing path).
