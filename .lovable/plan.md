# Fix forwarded concerns visibility

## What will change
- Replace the circular read rules between forwarded concerns and their history with a non-recursive access check.
- Preserve access for the sender, current recipient, original recipient, prior recipients, participants, HR, CEO, COO, Tenant Ops, managers, and super admins.
- Keep forwarding writes and the append-only history unchanged.
- Make the forward action confirm the saved concern identifier before showing success, then refresh the concern lists and statistics.

## Verification
- Confirm a selected staff member remains visibly chosen.
- Forward a test concern and verify it appears in Issues Review, sender views, recipient My Space, and forwarded statistics.
- Run the project guards and check the preview for errors.

## Technical details
- Add one additive database migration using SECURITY DEFINER membership helpers to avoid policy recursion.
- Update only the forwarding hook/dialog where needed; no calling, tenant, payment, eligibility, or financial logic changes.
