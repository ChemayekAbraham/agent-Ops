# 264. Withdrawal PIN: the first-PIN code can go to a non-Ugandan registered phone (2026-11-06)

**Status (2026-11-06):** CODE CHANGE ON `dev/withdrawal-pin`, NOT DEPLOYED, NOT TESTED AGAINST A REAL SEND. Asked for by Josh (CTO) after Grace Paul Ochieng could not set a PIN.
**Companion to:** doc 263 (first PIN needs a phone code).

## 1. What happened

Grace Paul Ochieng (`99890a2e-b842-4d44-8516-e2eafe0711ff`, withdrawable UGX 584,836.70, registered phone `+254733803035`, no PIN yet) tried to withdraw UGX 100,000. The PIN screen said "We have no valid registered phone number for this account, so we cannot text you a code." Cause: `withdrawal-pin-reset` action `setup_send_code` answered `no_phone` unless `isUgandanPhone(profiles.phone)`; the shared sender `sendSmsMultiProvider.ts` also refuses any non-Ugandan number. The number was real, only not Ugandan.

Other accounts with a balance and no PIN that fail the same gate (checked 2026-11-06): three with 9-digit numbers (`075999766`, `075106601`, `075296850`), which are bad data, not foreign numbers, and stay rejected.

## 2. The change

| Piece | Behaviour |
|---|---|
| `isInternationalPhone(phone)` (new, `_shared/sendSmsMultiProvider.ts`) | True for a Ugandan number, or a non-Ugandan one written in full as `+<country code>...` (10-15 digits, country code not starting 0). The `+` is required so a short local number is never mistaken for a foreign one. |
| `SmsLogCtx.allowInternational` (new, off by default) | When set and the number is foreign: the profile-phone gate is skipped and the send goes through **Africa's Talking only** (Yoola and Lana are Uganda routes). Every other caller keeps the Ugandan-only rule unchanged. |
| `withdrawal-pin-reset` `setup_send_code` | Checks `isInternationalPhone` instead of `isUgandanPhone` and passes `allowInternational: true`. `no_phone` still returned for an empty, short or malformed number. |

No migration, no frontend change. The screen text is unchanged and still correct for a truly unusable number.

## 3. Verified and not verified

- Verified: the validator logic on sample numbers (Node re-implementation, no Deno available locally): `+254733803035` accepted; `254733803035` without the `+`, `075999766` and an empty value rejected; Ugandan formats unchanged.
- **Not verified:** a real SMS to a +254 number. It depends on the Africa's Talking account being enabled for Kenya and on how the `WELILE` sender ID is treated there (Kenyan networks may replace or block an unregistered alphanumeric sender). If the send fails the screen shows "Could not send the code" (`send_failed`) and `sms_delivery_log` carries the `africastalking` error.
- Not run: any Deno test, `npm run guard:all`.

## 4. Deploy and next steps

1. Merge to `lovable` only when Lovable's agent is idle, then ask Lovable to deploy `withdrawal-pin-reset` (the shared sender is bundled with it).
2. Have Grace press "Text me a code" and check `sms_delivery_log` for source `withdrawal_pin_setup`.
3. If Africa's Talking will not deliver to Kenya, the fallback is manual: Financial Ops pays her 100,000 after verifying her another way.
