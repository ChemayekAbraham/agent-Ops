---
name: Cash-Out Claim Comments
description: Immutable per-claim comment timeline for cash-out (merchant) withdrawals, surfaced on the CFO Cash-Out Agents tab and the Merchant Claims Log
type: feature
---
Table `cashout_claim_comments` (withdrawal_id → withdrawal_requests, author_id, author_name, author_role, comment, status, created_at). Append-only: GRANT SELECT+INSERT only (no UPDATE/DELETE) so the timeline is a permanent audit trail. RLS: finance/ops roles (cfo, coo, manager, operations, super_admin) OR the cash-out agent assigned to the claim can read + insert; insert requires author_id = auth.uid().

Hooks in `src/hooks/useCashoutClaimComments.ts`:
- `useCashoutClaimComments(withdrawalId)` — timeline + `addComment` (stamps author name/primary role).
- `useLatestClaimComments(ids[])` — batch latest-comment-per-claim map for inline list display.

UI:
- `src/components/cfo/ClaimCommentTimeline.tsx` — reusable timeline + composer (comment + optional status: Verified/Paid/Charges confirmed/Failed/etc.).
- `MerchantClaimsLog` (financial-ops): inline latest comment on each row + Comments section + withdrawal-charge breakdown in the claim detail drawer.
- `CashoutAgentManager` drill-down: each processed-payout card is clickable → `ClaimCommentDialog` (charge breakdown + timeline); inline latest comment shown on the card.

Withdrawal charges are COMPANY-borne and auto-computed via `getTelecomSendingCharge` (cashoutCharges.ts). Net paid = requested amount (company absorbs the fee). Bearer label always "Company".
