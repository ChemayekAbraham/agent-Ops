# National ID & identity verification — what was built

Report covering 14–15 September 2026. Verified against the live production
database and the code on `origin/lovable`, not against migration files.

---

## The problem this set out to solve

A withdrawal was gated on "identity verified", and identity verification meant
two things a person typed into text boxes: a NIN and a name. The photos they
uploaded were stored and never read. Auto-verification then compared the typed
ID name against the account name — **both supplied by the same person** — and
passed anyone whose two entries agreed.

So `profiles.national_id` across 5,266 accounts was, structurally, unverified
typing, and the gate in front of the money was checking self-consistency rather
than identity.

---

## 1. The card is now actually read

`read-national-id` called a language model, which always returns *something*, so
a misread was indistinguishable from a good read. It now calls PassGate
**`POST /v1/id/read`** with `view=full`.

PassGate validates every field against its format and reports an unreadable one
as **missing** rather than guessing — a wrong NIN that parses cannot be caught
downstream, while a refusal can simply be retried.

Three outcomes the screen acts on:

| `status` | Behaviour |
| --- | --- |
| `invalid` | **Refused.** Not a Ugandan National ID — no prefill, cannot submit |
| `incomplete` | Names the fields that failed, asks for a better photo of the *same* card |
| `valid` | Prefills all six for confirmation |

**Six fields extracted**: surname, given name, NIN, date of birth, card number,
sex — plus `nationality` and `date_of_expiry` carried through.

Details specific to the contract: `date_of_birth` arrives ISO and is never
re-parsed; top-level `confidence` is the *lowest* field confidence, not an
average; failed `consistency` cross-checks are surfaced as *a human should look*,
never as proof of forgery, because the NIN's internal layout is inferred rather
than published by NIRA.

**Privacy**: the response is never logged (it carries name, NIN, date of birth
and card number in one object), and `debug` is never requested — it returns a
212 KB annotated copy of the card.

---

## 2. The six fields are editable, and both versions are kept

The reading prefills six inputs the person can correct. Each is shaped to its
field, and any field the reader refused is still prefilled from what it *saw*,
marked "not read — type it", so nobody types blind.

`national_id_readings` stores **what the reader saw and what the person
submitted, side by side**, with `edited_fields` naming every field they changed.

That divergence is the point. The prefill does not make review easier — the
difference does. A field someone overwrote is exactly where a reviewer should
look.

`submit_national_id_details` re-validates all six server-side and re-applies the
one-ID-one-account rule, so bypassing the screen gains nothing. The audit row
records **field names only, never values** — an ID must not be copied into a
second place.

---

## 3. The selfie is checked for a face

Before this, the selfie was scored only for sharpness, glare and contrast by
`imageQuality.ts`, which announced **"This photo is clear"** — a crisp photo of a
wall passed, and a reviewer read that as "this photo is fine".

`verify-passport-photo` already answered "is this a face" and was already used in
tenant onboarding and agent registration. It was never called on the one screen
whose entire purpose is identity. It is now: a definite **no face blocks
sending**, while an outage warns and lets the person through — a checker being
down must not stop withdrawals.

The selfie tile also opened the **rear** camera, under a hint reading "Face the
camera in good light". Fixed.

---

## 4. National ID group linking — the duplicate case

A duplicate NIN used to be a dead end: *"This National ID is already recorded on
another account."* It now offers a link request.

**Model.** First account to record a NIN keeps `profiles.national_id` — the FIFO
holder. Others join the group, and their profile receives only
`linked_national_id` (the NIN) plus `linked_national_id_request_id`. **The
holder's identity is never copied to them**, and the unique index on
`profiles.national_id` stays intact.

**Rules**, enforced in the `national_id_link_requests` RPCs:

- Maximum **20 accounts per NIN**, holder included
- Requests expire after **7 days**, lazily via `national_id_link_expire_stale`
- Statuses: `awaiting_owner`, `owner_approved`, `active`, `rejected_by_owner`,
  `rejected_by_staff`, `expired`
- Requester and holder screens expose **only the NIN** — never the other
  accounts' names or phone numbers. The group card shows "Account 2, 3, …" with
  join dates

**Consent.** An OTP goes to the **holder's** number, resolved server-side by the
`national-id-link-otp` edge function; the requester never sees that number. The
holder relays the code.

**A change worth flagging.** The original design had three gates — code, then a
separate in-app approval, then staff confirmation. Migration `20260915190000`
collapses this: a correct code now activates the link immediately. The stated
reason is 3,127 sub-agents with no National ID, 624 with money stuck, and the
argument that relaying the code already proves phone control and willingness.
Staff confirmation becomes an **audit step rather than a gate** — every
OTP-activated link is stamped with a distinctive `decision_reason` and remains
revocable. The three-step path is left intact for other entry points.

**Components**: `NationalIdLinkFlow` (requester), `NationalIdLinkGate` (holder,
non-dismissible), `NationalIdLinkStaffQueue` (Financial Ops),
`NationalIdGroupCard` (agent dashboard), hooks in `useNationalIdLink.ts`.

---

## 5. Identity binding and the locked payout number

`user_identity_bindings` ties a captured identity to **one locked mobile money
number**. `withdrawal_destination_gate` now lets a withdrawal through as
`identity_captured_pending_review` when the binding's number matches the
withdrawal's, and the binding carries a National ID (own **or linked**) plus both
photos.

This is what actually unblocks the stuck sub-agents: money can move while
Financial Ops still has the file to review, but only to the number bound to the
captured identity.

Note: `withdrawal_user_id_verified` — the merchant-visibility gate — was **not**
changed. A link does not make anyone "verified" there. The two gates remain
separate, which is the right shape.

---

## 6. Adjacent work in the same period

- **Payout number ownership** — durable auto-verify when the destination owner
  confirms by SMS, holder auto-verify, `payout_number_change_requests`, and a
  `notify-payout-number-change` edge function
- **Partner exemption** — a partner with no agent activity is exempt from the
  payout-destination gate (`20260915140000`), the fix behind yesterday's 82
  stranded Returns payouts
- **`20260915160000`** — stops a harmless name reordering triggering
  re-verification
- **`20260915180000`** — blocks deleted bot identifiers from re-signup
- **`0121`** — removes the weekly cap of three identity submissions
- **`0122`** — drops the back-of-card requirement from the verify gate

---

## Where things stand

| | |
| --- | ---: |
| Profiles carrying a NIN | 5,266 |
| Profiles with the full six fields | **4** |
| `national_id_readings` rows | **8** |
| Identity photo hashes | 66 |
| `user_identity_bindings` | **33**, all `identity_captured` |
| Link requests raised | **0** |
| Profiles with a linked NIN | **0** |
| Payout destinations verified | 58 |
| — of which auto-verified | 19 by name match, 4 by SMS confirmation, 3 partner-exempt |
| Awaiting review | **2,728** |
| Rejected | 576 |

The 576 rejections were a **bulk staff sweep at 15:49 today**, almost all reading
*"this mobile money number is registered to \<someone else\>"* — shared payout
numbers being cleared out. Worth knowing that is a deliberate action and not a
system fault.

---

## Open items

**The linking feature has never been exercised.** Zero requests, zero linked
profiles. Every rule above — the 20-account cap, the 7-day expiry, OTP relay,
the non-dismissible holder dialog — is untested against a real pair of accounts.
Worth walking one through end to end before it meets 3,127 sub-agents.

**The auto-verify rule still rewards the weaker evidence.** It scores the ID name
against the account name at a 0.90 threshold, which in practice means every token
must match. A *typed* ID name matches trivially; a *real card* name often does
not. The account that read nothing off a card was auto-verified in one second;
the account that read everything correctly is still `waiting`. Nothing yet
distinguishes a card-read submission from a typed one, though the reader already
records which it was.

**5,234 NIN records have no card image.** The entire `identity-verification`
bucket holds 163 objects, all created 14 September. A batch re-read would have
about 30 cards to work through. Those records cannot be backfilled by OCR — only
by collection, which the withdraw gate now does naturally for the ~180 accounts
with payout activity.

**`national_id_ocr_reads` holds `extracted_text`** — the raw OCR dump of the card,
13 rows, dormant since 14 September. It predates the no-logging rule. Under the
Data Protection and Privacy Act 2019 it needs a lawful basis and a retention
limit, and currently has neither.

**`national_id_declarations` is empty** — 0 rows, built and never written to.
Worth adopting or dropping rather than leaving a third half-named store.

**Deployment.** `read-national-id` and `verify-passport-photo` are live and
confirmed working. `national-id-link-otp` and `notify-payout-number-change` are
new and, unless separately deployed, are not — edge functions in this project do
not deploy on push.
