# Redemption Approvals in the CFO dashboard

## What you will see
- A new **Redemptions** page in the CFO sidebar (Accounting group), listing every portfolio redemption that is closed but not yet paid.
- Lillian Nabwire (WIP2604024329, UGX 9,818,988) appears there as the first item, status **Awaiting CFO approval**.
- Each row: partner name, phone, portfolio code, principal redeemed, date closed, who closed it, note.
- **Approve & Pay** opens a confirm box with the amount and a required reason (10+ characters). On confirm:
  1. The full principal is credited to the partner's **withdrawable** wallet.
  2. The partner gets a "Your redemption has been paid" email (amount, portfolio code, date).
  3. The row moves to **Paid** history with who approved and when.
- **Reject** (with reason) keeps the money unpaid and records the decision; nothing moves.
- Paid and rejected items stay visible in a history tab; nothing is ever deleted.

## Safety rules
- Only CFO approvers (CFO office + the two named super admins) can approve, checked on the server.
- Each redemption can be paid **once only**; a second press is refused.
- The person who closed the redemption cannot also approve it.
- Amount paid always equals the recorded redeemed principal; it cannot be edited at approval.
- Books stay balanced: one ledger group, partner wallet in, platform out.
- No email is sent when the portfolio is closed; the only email is the payment one.

## Technical details
- Migration (after checking the live schema):
  - Add payout fields to the existing redemption record table: `payout_status` (`awaiting_cfo` default / `paid` / `rejected`), `payout_decided_by`, `payout_decided_at`, `payout_reason`, `payout_ledger_ref`. Backfill existing rows (Lillian) to `awaiting_cfo`.
  - Add a new allowlisted ledger category `partner_principal_return` (wallet leg `recipient_type='user'` → withdrawable; platform leg against the partner capital liability).
  - SECURITY DEFINER RPCs, `search_path = public`, gated by `is_cfo_approver`: `cfo_list_redemptions(p_status)`, `cfo_approve_redemption(p_id, p_reason)` (locks row FOR UPDATE, checks status/separation, posts via `create_ledger_transaction` with idempotency key `redemption-<id>`, emits `system_events`, writes `audit_logs`), `cfo_reject_redemption(p_id, p_reason)`. Grants: authenticated execute, anon revoked.
- Email: new app email template `redemption-paid`, sent via `send-transactional-email` after a successful approval, idempotency key `redemption-paid-<id>`.
- UI: `src/components/cfo/RedemptionApprovalsPanel.tsx`, wired into `src/pages/cfo/Dashboard.tsx` and `executiveSidebarConfig.ts`.
- Run `guard:all`; verify Lillian shows in the list. Approval itself is left for the CFO to press — I will not pay her during testing. Edge function deploy for the email needs your go-ahead (this plan's approval counts). Nothing published.
