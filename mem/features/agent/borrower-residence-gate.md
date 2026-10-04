---
name: Borrower Residence Gate for Lending Loan Requests
description: Borrowers must complete a residence profile (linked landlord with GPS + LC1 chairperson) before requesting a lending-agent loan
type: feature
---
Before a borrower can request any lending-agent offer (browse offer "Borrow this offer" OR direct request by AI ID) in `BorrowLoanSheet.tsx`, they must pass `BorrowerResidenceGate.tsx`.

Storage: `profiles.borrower_landlord_id` → `landlords(id)`, `profiles.borrower_lc1_id` → `lc1_chairpersons(id)` (both nullable, ON DELETE SET NULL).

Completeness rule (`isResidenceComplete`): linked landlord that is `verified=true` AND has latitude+longitude (GPS), AND a linked LC1 chairperson that is `verified=true`. Loan requests are HARD-BLOCKED until both are verified (pending/rejected both block).

3-state verification status (pending/verified/rejected) is now authoritative on the entity: `landlords.verification_status` / `lc1_chairpersons.verification_status` (text, default 'pending', CHECK in (pending,verified,rejected)), with rejection reason in `verification_reason`. Helpers `landlordVerifStatus`/`lc1VerifStatus` read the column, falling back to the legacy `verified` boolean. The gate displays `verification_reason` for rejected records; a leftover `*_verification_requests` lookup only flags whether the borrower has an open pending request. Rendered via `StatusBadge` (Clock/amber pending, BadgeCheck/emerald verified, XCircle/destructive rejected).

**Ops verification (Landlord Ops → "GPS & LC1 Verification" view, `ResidenceVerificationPanel.tsx`)**: ops team sets landlord GPS / LC1 status to pending/verified/rejected with a MANDATORY reason (≥10 chars). Backed by SECURITY DEFINER RPCs `set_landlord_verification(p_landlord_id,p_status,p_reason)` and `set_lc1_verification(p_lc1_id,p_status,p_reason)` — gated by `is_ops_role(auth.uid())`, they update `verification_status`+`verification_reason`, keep `verified`/`verified_at`/`verified_by` in sync, resolve open `*_verification_requests` rows, and write an `audit_logs` entry. Panel: entity toggle (Landlord/LC1), status filter chips (pending default), name/phone search, 50-row cap.

**Notifications on status change**: the two RPCs also insert in-app `notifications` rows for every borrower linked to the entity (`profiles.borrower_landlord_id` / `borrower_lc1_id`), with the rejection reason embedded. After a successful RPC, `ResidenceVerificationPanel` also invokes edge function `notify-verification-change` (best-effort, fire-and-forget) which fans out OPTIONAL email + SMS alerts. The function verifies the caller is ops (`admin.auth.getUser` + `is_ops_role`), then per linked borrower: sends email via `send-transactional-email` template `residence-verification-status` when `profiles.verification_notify_email` and an email exist; sends Africa's Talking SMS (sender WELILE) when `profiles.verification_notify_sms` and a phone exist and the phone is not in `sms_opt_outs`. Both prefs default true and are toggled by the borrower in the "Alerts for verification updates" card inside `BorrowerResidenceGate`.

Pending/rejected cards show a "Request verification" button that inserts a `*_verification_requests` row (status pending; handles 23505 unique-pending as "already requested"); ops resolve it in the Landlord Ops dashboard which flips the `verified` flag. The gate shows: landlord name, GPS coords, status badge, and the registering agent (`landlords.registered_by` → profile full_name). LC1 shows name + status badge.

Self-service: if the borrower's landlord isn't registered they add it via `LandlordRegistrationForm` (registeredByRole='tenant', captures GPS). If their LC1 isn't listed they add one inline → inserts `lc1_chairpersons` with `registered_by=auth.uid()`, `verified=false`.

RLS: added policy "Users can insert their own lc1" on `lc1_chairpersons` (WITH CHECK registered_by = auth.uid()) so non-agent borrowers can self-add LC1. Borrowers update their own profile links via the existing "Users can update own profile" policy.

Borrower-facing loan form never shows this requirement to the lender; it's a pre-request gate on the borrower side only.
