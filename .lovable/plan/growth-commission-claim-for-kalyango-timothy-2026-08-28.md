# Growth commission claim for Kalyango Timothy

A new card on My Space that shows, live, how many new platform users have signed up since his last paid claim, what that is worth at UGX 50 each, and a button to claim it. A claim becomes a requisition reviewed first by the CEO, then by the CFO, and on final CFO approval his wallet is auto-credited and the counter restarts from that moment.

Visible only to Kalyango Timothy (matched on his user id). Nobody else sees the card or can raise this claim type.

## What counts

- Every new user profile created on the platform, regardless of role.
- The window for a claim starts at the end of the previously paid window and ends at the moment the claim is raised.
- First claim seeds the window start at 30 days before the claim, so the opening claim covers the past 30 days (currently 5,946 new users ≈ UGX 297,300).
- Multiple claims may be in flight at once. Each claim locks its own window, so a second claim starts counting from where the first one ended — no overlap and no double payment even before the first one is approved.
- If a claim is declined, its window is released and those users are counted again on the next claim.

## Flow

```text
My Space -> "Growth commission" card
   live: N new users since <date>  =  UGX N x 50
        | Claim
        v
CEO dashboard (Requisitions tab)  -- review + approve/decline/send back
        | approve
        v
CFO dashboard (Requisitions tab)  -- review + approve
        v
Wallet auto-credited  ->  counter restarts from the claim's end time
```

The requisition notice carries a short built-in report: number of new platform users being paid for, the exact window (from - to), the rate (UGX 50), and the total. It shows at both CEO and CFO stages and in his own claim list.

## My Space card

- Headline: live commission total (e.g. `UGX 297,300`), with `5,946 new users since 29 Jul 2026` underneath.
- Refreshes on open and on a short interval, so the figure is current.
- "Claim commission" button, disabled when the countable total is zero.
- Below it, his claim history: window, user count, amount, current stage (CEO / CFO / Approved / Declined), and credited date.

## Technical details

**Database (one migration)**

- `public.growth_commission_claims`: `claim_code` (`GCM-00001` via sequence), `user_id`, `window_start`, `window_end`, `user_count`, `rate_per_user` (default 50), `amount`, `status` (`pending|approved|rejected|released`), `requisition_id` -> `staff_requisitions(id)`, timestamps + update trigger. Unique partial index so windows cannot overlap per user. GRANT to `authenticated` (select own) and `service_role`; RLS: owner reads own rows, all writes through service-role edge functions only.
- `public.growth_commission_eligible_users(_user_id uuid)` SECURITY DEFINER, `SET search_path = public`: returns `window_start`, `window_end`, `user_count`, `amount` for the next claimable window — window start = max(end of last non-rejected claim, now() - 30 days on first claim), count = `profiles` rows created in the window. Single query, no N+1.
- `public.growth_commission_beneficiaries` config table holding the single allowed user id (his uuid), so the entitlement is server-side, not a hard-coded client check. Both the RPC and the submit function gate on it.
- Add `ceo_decided_by / ceo_decided_at / ceo_note` to `staff_requisitions` so a CEO decision is recorded in its own columns rather than reusing the supervisor slots.

**Requisition routing (CEO -> CFO)**

The existing engine routes supervisor -> COO -> final stage. This claim needs CEO -> CFO, so:

- `staff-requisition-submit` gains an internal claim path (or a sibling function `growth-commission-claim`) that inserts the requisition at `stage = 'ceo'`, `current_approver_role = 'ceo'`, `final_stage = 'cfo'`, category `growth_commission`, with the report stored in the reason/metadata and linked to the claim row.
- `staff-requisition-decide` gains: CEO-stage decision columns; when `stage = 'ceo'` and `final_stage = 'cfo'`, the next stage is `cfo` (today only `supervisor` advances). Everything else — role ownership check, self-approval block, reject/return, 10-character comment rule — is untouched.
- On final CFO approval the existing `_shared/requisitionWalletCredit.ts` credit path runs unchanged (idempotent, ledger-backed, rolled back on failure). A `credited` event then marks the claim `released` and stamps its `window_end` as the new counter baseline, and emits a `system_events` row.
- `requisition-credit-retry` already supports `staff_requisitions`, so retries work with no change.

**Frontend**

- `src/components/me/GrowthCommissionCard.tsx`: live figures from the RPC, claim button, claim history; rendered in `src/pages/me/PersonalHub.tsx` only when the signed-in user is the configured beneficiary.
- `StaffRequisitionQueue` detail view renders the growth-commission report block (users, window, rate, total) when `category = 'growth_commission'`; no other queue behaviour changes.
- Realtime subscription on `growth_commission_claims` so his card and the queues update without polling.
