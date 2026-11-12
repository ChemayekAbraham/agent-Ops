# Signage shop-owner cross-check

## What to build
- Add **Applications** and **Shop owners** tabs in Agent Ops signages; leave COO and existing review actions unchanged.
- List attached owners with their phone, signage references and locations. Default to owners with existing company records, with an option to show all owners.
- Flag matches as **Tenant**, **Landlord**, or **Registered user**, and show matched names, registered roles and associated Rent Plan references/statuses. Flag multiple account matches for review rather than assuming they are the same person.
- Include search, loading, unavailable, empty and refresh states, plus paged results so owners are not silently omitted.

## Technical approach
- Add one read-only, staff-authorized RPC using the existing signage operations authorization and staff MFA checks. Match the stored owner phone using the existing Uganda phone normalizer against profiles and landlord records, then link their Rent Plans. Do not use payout or alternate phone numbers as proof of ownership.
- Group applications by normalized owner phone; retain unmatchable numbers separately and mark them for review. Include historical Rent Plans and label their recorded status without changing any financial or approval definitions.
- Keep matching and flags server-owned; fetch only when the Shop owners tab is open. No account merges, payments, approvals or account changes.

## Verification
- Test phone-format equivalence, tenant/landlord/other-user matches, multiple matches, unmatched owners, paging and staff-only access.
- Run signage regression tests and all project guards, and check automatic compilation. Signed-in live checks depend on available authorized access.