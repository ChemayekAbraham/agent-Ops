# National ID capture + FIFO identity linking — what exists, what is missing

Gap analysis against the proposed flow, 15 September 2026. Verified against the
live production database and the code on `origin/lovable` — not against the
migration folder, which does not reflect production.

---

## Verdict in one line

**Roughly half of this already exists.** The ID reader, the face checker, the
duplicate detector and the SMS pipeline are all built and running. What is
missing is the *linking model itself* — and the reason it is missing is that
the system today is deliberately built to do the **opposite** of what you are
asking for.

That conflict is the most important thing in this document, so it comes first.

---

## The one thing to decide before anything is built

Today, **one National ID may belong to exactly one account.** That is not a
convention, it is enforced in four places:

| Where | What it does |
| --- | --- |
| `profiles_national_id_unique` | Unique index on `national_id` |
| `profiles_national_id_unique_norm` | Unique index on the normalised value, so `CM123-456` and `cm123456` collide |
| `submit_national_id()` | Refuses: *"This National ID is already recorded on another account."* |
| `auto_reject_duplicate_national_id` trigger | Auto-rejects the payout verification and raises an `account_flagged` event |

Current data: **5,253 profiles carry a National ID and there are zero
duplicates.** The rule has held. There is no backlog to migrate — whatever you
build here is forward-only, which makes it much cheaper.

Your proposal replaces "refuse" with "allow and link". That is a real change to
the identity model of a regulated lender, and it deserves a conscious decision
rather than being absorbed as a feature. Specifics are in *Risks* below. The
design in this document assumes you still want it, and tries to make it as safe
as it can be.

---

## Step 1 — Capture the ID and extract the details

### What exists

`supabase/functions/read-national-id/index.ts` already does this. The browser
posts a photo, the function sends it to `google/gemini-3.8-flash` through the
Lovable AI gateway, and returns:

```json
{ "full_name": "", "surname": "", "given_names": "",
  "id_number": "", "date_of_birth": "",
  "is_national_id": true, "readable": true }
```

`src/lib/nationalIdOcr.ts` wraps it and never throws — a failure returns
`{ error }` so the person can still type their details by hand. `idNameVerdict()`
scores the ID name against the account name (match / partial / mismatch).

So **surname, given names, NIN number and date of birth are already extracted.**

### What is missing

| Missing | Notes |
| --- | --- |
| **Sex** | Not in the prompt, not in the response shape. One-line change to the prompt + the parser. |
| **Card number** | Same. Note this is the *card* number (the one that changes when a card is reissued), not the NIN — they must be stored as separate fields or they will be confused forever. |
| **Storage for any of it** | `profiles` has `national_id`, `national_id_name`, `national_id_photo_path`, `national_id_back_photo_path`, `selfie_photo_path`, `selfie_image_hash`. There is **nowhere to put date of birth, sex, card number, or surname and given names separately.** Today the OCR result is used on screen and thrown away. |
| **An editable confirm screen** | The reading is shown, but there is no "these are the details we read — correct them if wrong" step that then becomes the record of what the user asserted. |

Worth keeping: store both **what the OCR read** and **what the user confirmed**,
in separate columns. When they differ, that difference is a signal worth having.

---

## Step 2 — Live selfie, no upload

### What exists

The face check is done. `supabase/functions/verify-passport-photo/index.ts`
sends the photo to PassGate and returns `is_face`, a verdict, quality failures
and a SHA-256 of the exact bytes, then records it in
`identity_photo_fingerprints`. It answers clearly in both directions, which is
what you asked for.

`src/lib/passportFaceCheck.ts` already wraps it with the rule that only a
definite "no face" blocks, while an outage warns and lets the person continue.

### What is missing

**There is no live camera capture anywhere in the product.** `getUserMedia` does
not appear once in `src/`. Every photo — selfie, ID, house, passport — is
captured with:

```html
<input type="file" accept="image/*" capture="user">
```

On a phone that usually opens the camera, but the user can still choose a
gallery image in many Android browsers, and on desktop it is a plain file
picker. **So "no upload" is not currently enforced anywhere, and cannot be
enforced with this input.**

Doing it properly needs a new component: `getUserMedia` → video preview → canvas
grab → immediate submit, with no file input fallback on the selfie step. Budget
for the awkward parts: permission denial, no camera on the device, iOS Safari
requiring a user gesture, and low-end Android where the video stream is slow.

Also worth knowing: a live capture proves the photo came from the camera **now**.
It does not prove a live *person* — someone can hold up a printed photo. Real
liveness (blink, turn head, depth) is a separate product and PassGate may or may
not offer it. Worth asking them before promising "liveness" to anyone.

---

## Step 3 — What happens on Confirm

### 3.1 Does this NIN already exist?

**Exists.** `duplicate_national_id_owner(p_user_id, p_national_id)` already
answers exactly this question, and does it well — it normalises punctuation and
case, and checks both `profiles.national_id` and verified
`payout_destination_verifications`. It returns the owner's user id.

Nothing new needed here. What changes is what you *do* with the answer.

### 3.2 Fresh NIN → attach to this user (FIFO)

**Exists.** `submit_national_id()` already writes the NIN to the caller's own
profile when it is unused, with an audit entry. First writer wins, enforced by
the unique index. That *is* FIFO.

### 3.3 Existing NIN → link the newcomer under the first holder

**Missing entirely.** There is no table, no RPC, no concept.

On naming: **"promote" is the wrong word** — the second person is not being
promoted, they are being made dependent on someone else. Calling it a promotion
in the UI will confuse agents and, worse, make it sound like a reward for
reusing someone's ID. Suggested vocabulary:

| Concept | Suggested name |
| --- | --- |
| The account that used the NIN first | **ID Holder** |
| An account attached to that NIN afterwards | **Linked Member** |
| The act | **Linking to an ID Holder** |
| The dashboard section | **Accounts linked to your National ID** |

Deliberately *not* "parent agent" / "sub-agent" — `agent_subagents` and
`agent_relationships` already mean a commercial supervision relationship with
commission consequences. Identity linkage is a different thing and reusing that
vocabulary will cause someone to pay commission on it by accident.

The design that fits the existing constraints: the Linked Member's profile
**never receives the NIN**. It stays unique to the ID Holder, both indexes keep
working untouched, and the relationship lives in its own table:

```
identity_links
  id, holder_user_id, member_user_id, national_id_norm,
  status (pending | approved | rejected | withdrawn),
  requested_at, decided_at, decided_by, decision_channel,
  request_ip, request_user_agent
```

### 3.4 The approval notification

**Mostly missing.**

| Piece | Status |
| --- | --- |
| Notification storage | Exists — `notifications` has `title`, `message`, `metadata`, `link_path`, `dismissed_at`, `expires_at` |
| **"Cannot be dismissed until answered"** | **Missing.** There is no required-action flag, and `dismissed_at` means the opposite |
| **Yes / No answer capture** | **Missing.** Notifications have no response field |
| Rejection SMS | Infrastructure exists — `supabase/functions/_shared/sendSmsMultiProvider.ts`, with idempotency and delivery logging. The message itself is not written |
| Approval notice back to the requester | Missing |

There is a good precedent to copy rather than invent:
`src/components/payouts/MerchantPayoutDisputeAlarm.tsx` — an unmissable alarm at
the top of the payout dashboard, backed by its own table, which the merchant must
acknowledge and then resolve. Same shape as what you want, already proven in the
field.

### 3.5 The agent dashboard section

**Missing.** Nothing lists accounts sharing your National ID. It is a small
component once `identity_links` exists.

---

## Summary table

| # | Capability | Status |
| --- | --- | --- |
| 1 | Photograph the ID and read it automatically | **Exists** |
| 2 | Extract surname, given names, NIN, date of birth | **Exists** |
| 3 | Extract **sex** | Missing — prompt change |
| 4 | Extract **card number** | Missing — prompt change |
| 5 | Show extracted details for the user to correct | Partial — shown, not editable-and-recorded |
| 6 | Store DOB / sex / card number / name parts | **Missing — no columns exist** |
| 7 | Face check on a selfie, reports both ways | **Exists** |
| 8 | **Live camera only, no gallery upload** | **Missing — no live capture anywhere in the product** |
| 9 | Detect that a NIN is already in use | **Exists** |
| 10 | Attach a fresh NIN to the user (FIFO) | **Exists** |
| 11 | Link a later user under the first holder | **Missing** |
| 12 | Non-dismissible approve/reject notification | **Missing** |
| 13 | Capture the holder's Yes/No answer | **Missing** |
| 14 | SMS the requester on rejection | Pipeline exists, message not written |
| 15 | Notify the requester on approval | Missing |
| 16 | Dashboard: accounts linked to my National ID | **Missing** |
| 17 | Staff override / dispute path | **Missing** |

---

## Risks I would want answered before building

**1. This weakens KYC, and it should be a decision, not a side effect.**
Today one NIN means one account. Afterwards, one NIN can mean many accounts —
so one person can operate several wallets under a single identity, with the
approval of nobody but themselves if they control both accounts. For a lender
this is the kind of change a regulator asks about. It may still be the right
call for real households sharing an ID; it should just be chosen knowingly.

**2. FIFO rewards whoever typed it first, not the rightful owner.**
If someone registers with a stolen or mistyped NIN, they become the ID Holder —
and the genuine owner then has to ask *them* for permission. Worth adding: a
staff-resolvable dispute path, and a rule that an ID Holder who has never been
verified by Financial Ops cannot approve anyone.

**3. A user becomes the KYC gatekeeper.**
Your flow has the existing user approve. That is good for consent but it is not
identity assurance — two colluding people approve each other instantly. My
recommendation: peer approval is necessary but not sufficient, and Financial Ops
should co-approve any link where either account can move money.

**4. The non-closable notification can be turned into a weapon.**
An unclosable prompt on someone's dashboard is, from the wrong angle, a way to
disable that person's account. Needed alongside it: a cap on open requests per
holder, an expiry, a rate limit per requester, and a "this is not me — report"
button that routes to staff instead of forcing a Yes/No.

**5. The interaction with the withdrawal gate — this is the one that bites.**
We have just spent two days on partner payouts blocked by exactly this gate. If
a Linked Member inherits the ID Holder's verified status, then *linking becomes
a way to bypass ID verification entirely*: attach yourself to a verified person
and inherit their standing. **Recommendation: a link must not confer
`withdrawal_user_id_verified`.** Linking records a relationship. Verification
stays personal.

**6. OCR is a reading, not a verification.**
Gemini reading a card tells you what is printed on the photo. It does not tell
you the card is genuine or that NIRA agrees. Date of birth and sex captured this
way should be stored as *asserted*, not *verified*, and should not be used for
anything with legal weight until there is a real NIRA check behind it.

---

## Suggested build order

1. **Columns first** — DOB, sex, card number, name parts, and both the OCR
   reading and the user-confirmed value. Cheap, unblocks everything else.
2. **Prompt change** — add sex and card number to `read-national-id`. Half a day.
3. **Editable confirm screen** — show the reading, let the user correct it,
   record both.
4. **Live selfie component** — the largest single piece of frontend work here.
5. **`identity_links` + RPCs** — request, approve, reject, withdraw, all
   server-side with the conditions proved against `auth.uid()`.
6. **The alarm** — modelled on `MerchantPayoutDisputeAlarm`, plus the rate
   limits and the report path.
7. **SMS + approval notice.**
8. **Dashboard section.**

Steps 1–3 are genuinely small and deliver value on their own: better ID data on
every new account, whether or not the linking model is ever approved. Steps 5–6
are where the policy questions live, and are worth settling before any code.
