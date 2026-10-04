# Declutter the tenant menu drawer: remove duplicated cards

## What the selected div actually is

The block you selected is not its own component. It is the `extraContent` payload that `TenantDashboard` passes into `TenantMenuDrawer` (`src/components/dashboards/TenantDashboard.tsx`, lines 535-597). The drawer renders it in one bordered slab above the WhatsApp-style menu list, so everything inside it appears before "Money / Home / Profile / Support".

It currently stacks, in order:

```text
TrustBoostBanner            -> "Boost your Welile Trust Score"
VerificationChecklist       -> "Score: 6/100 · Rising Star · 1/4 verified"
SubscriptionStatusCard
RentHistoryRecordCTA        -> "Limit unlock · Starter · UGX 50,000 · Next unlock Building"
Actions + RentRequestButton -> "Request Rent Assistance"
RentProcessTracker / RentCalculator / RentRequestForm / RepaymentSection (conditional)
TenantBusinessAdvancesPanel -> "No business advances yet."
WalletDisclaimer
```

## Duplication found

1. **Access limit shown twice, with different numbers.** The main dashboard already renders `CreditAccessCard` (line 365), which reads `useCreditAccessLimit` and headlines the same idea ("% unlocked", "Access X Now", up to UGX 30M). The drawer's `RentHistoryRecordCTA` computes its own tier ladder from recorded rent months (Starter 50,000 -> Building 200,000 -> ... -> Welile Trusted 10M). Two surfaces, two sources, so a tenant can read UGX 50,000 in the menu and a different figure on home.
2. **Business advances shown twice.** `BusinessAdvanceStatusHero` (line 362) already sits at the top of home and queries `business_advances` for the live approval timeline. `TenantBusinessAdvancesPanel` in the drawer queries the same table again and, for a tenant with none, only prints "No business advances yet." — pure noise for most users.
3. **Trust score shown twice inside the same slab.** `TrustBoostBanner` states the score as a nudge; `VerificationChecklist` restates "Score: 6/100 · 1/4 verified" directly under it. The main dashboard also has `AiIdButton` (line 358), which is the real entry point to the AI ID / trust detail.
4. **Rent assistance overlaps existing menu rows.** The "Actions -> Request Rent Assistance" button plus the inline `RentCalculator` / `RentRequestForm` live above a menu list that already has "Rent Calculator", "My Loans" and "My Repayment Schedule" rows wired to the same flows.

## Proposed declutter

Keep the drawer slab for status that is genuinely menu-scoped, and delete what home already owns.

- Remove `RentHistoryRecordCTA` from `extraContent`; `CreditAccessCard` on home stays the single limit surface. (Component file kept, no other caller affected.)
- Remove `TenantBusinessAdvancesPanel` from `extraContent`; `BusinessAdvanceStatusHero` on home stays the single advances surface. Repayment entry moves nowhere new — it is reachable from the hero.
- Collapse the trust pair: keep `VerificationChecklist` (actionable, shows what is unverified) and drop `TrustBoostBanner` from the drawer, since the banner is a nudge that duplicates the score line right below it and `AiIdButton` on home.
- Keep `SubscriptionStatusCard`, `RentProcessTracker`, the conditional `RentCalculator` / `RentRequestForm` / `RepaymentSection` (these are driven by the drawer's own menu rows) and `WalletDisclaimer`.
- Keep the "Actions -> Request Rent Assistance" button: it is the only place the request flow starts, and the "My Loans" row is a history view, not a request action.

Net effect: the slab goes from 8 blocks to 4 in the empty state, and no number appears in two places with two sources.

## Technical detail

Single file edited: `src/components/dashboards/TenantDashboard.tsx`.
- Delete the `<TrustBoostBanner />`, `<RentHistoryRecordCTA />` and `<TenantBusinessAdvancesPanel />` lines from `extraContent`.
- Drop the now-unused imports at lines 57, 58 and 48.
No component files are deleted, no data layer, RPC, query or business logic changes. `RentHistoryRecordCTA` and `TenantBusinessAdvancesPanel` remain in the repo for reuse.
