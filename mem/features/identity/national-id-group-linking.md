---
name: National ID group linking (duplicate NIN)
description: Duplicate National ID no longer refuses submission — requester joins the first holder's ID group after holder OTP + in-app approval + staff confirmation
type: feature
---
# National ID group linking

First account to record a National ID keeps `profiles.national_id` (FIFO holder).
Anyone else photographing the same card gets `submit_national_id_details` →
`{success:false, duplicate:true}` and is offered a link request instead of a dead end.

Rules (all enforced in `national_id_link_requests` RPCs, migration 0115):
- Max **20 accounts per NIN**, holder included.
- Request expires after **7 days** (lazy expiry via `national_id_link_expire_stale`).
- Order: OTP sent to the **holder's** number (`national-id-link-otp` edge fn resolves the
  number server-side; requester never sees it) → requester enters code →
  holder approves in a non-dismissible in-app dialog (`NationalIdLinkGate`) →
  staff confirm with a 10+ char reason. Approval before `code_verified_at` is refused.
- Statuses: `awaiting_owner`, `owner_approved`, `active`, `rejected_by_owner`,
  `rejected_by_staff`, `expired`. Active link writes `profiles.linked_national_id`
  (NIN only — never the holder's identity) + `linked_national_id_request_id`.
- Requester screen polls every 25s (`LINK_POLL_INTERVAL_MS`).
- Requester/holder UI must expose **only the NIN**, never names or phone numbers of the
  other accounts. Group card shows "Account 2, 3, …" with join dates.

Components: `NationalIdLinkFlow` (requester, inside `IdentityPhotoCapture`),
`NationalIdLinkGate` (holder, mounted in `GlobalOnboardingGates`),
`NationalIdLinkStaffQueue` (inside `PayoutVerificationPanel`),
`NationalIdGroupCard` (agent dashboard, Sub Agents tab). Hooks in `useNationalIdLink.ts`.
SMS wording lives in `sms-otp` under `purpose: 'national_id_link'`.
