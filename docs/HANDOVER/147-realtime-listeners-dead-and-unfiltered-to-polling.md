# 147 — Realtime listeners: 36 dead, several unfiltered → polling

**Date:** 2026-09-28
**Follows:** doc 142 (CTO report triage) and `143-withdrawal-settlement-reconciler-infinite-recheck-loop.md` (the reconciler loop behind most of the `withdrawal_requests` Realtime traffic). Note that two docs share the number 143, and two others share 144, because parallel sessions wrote them on 2026-09-28.
**Agreed with Gemini** (UI owner) via the Realtime brief of 2026-09-28. Their per-table decisions are applied here. The UI changes that go with it (for example "Live" badges → "Auto-refreshes") are Gemini's follow-up.

## What was wrong

1. **36 tables had `postgres_changes` listeners but are not in the `supabase_realtime` publication.** Those listeners have never fired. Screens looked live but only refreshed on reload. The ones that mattered most:
   - **Kill-switch hooks** (`treasury_controls`): `useWithdrawalsPaused`, `usePayoutsUiEnabled`, `useLandlordPayoutsBlocked`, `useLandlordPayoutPriority`, `useProxyPayoutPriority`, plus the treasury part of `useWithdrawContext`. A switch flipped during an incident only reached open tabs after a reload.
   - **`useBusinessAdvanceRealtime`:** the channel never reached SUBSCRIBED. Every viewer got a "Taking longer than usual to connect" toast after 10 s, then fell back to a 15 s poll anyway.
   - Backoffice deposit queues (`TidVerification`, `DepositRequestsManager`, `ManagerDepositsWidget`), the ticket queue's new-ticket chime (`TicketsPage`), house-listing rejection alerts, and the agent unblock toast.
2. **Unfiltered listeners on busy published tables** re-ran heavy queries on every change to *any* row:
   - `useCfoApprovalNotifications`: 12 tables, and every change re-ran all 14 count queries.
   - `SmsFailoverAlerts` (`sms_delivery_log`): each insert also forced `SmsDeliveryLogViewer` to refetch up to 1,000 rows.
   - `PhoneMoneyCard` and `useEmailTransactionsPanel` (`gmail_transactions`, about 1 row per minute).
   - `FinOpsWithdrawalVerification`, `CashoutPendingWithdrawalsDialog` and `useMerchantFloat` (`withdrawal_requests`).

## Fix

New shared hook **`src/hooks/usePolling.ts`**: `usePolling(load, ms, { enabled, immediate })` returns `{ lastUpdatedAt, refresh }`.
- It skips ticks while the tab is hidden and refreshes when the tab or window becomes active again.
- It never overlaps loads and always calls the latest `load`.
- Tests: `src/hooks/tests/usePolling.test.ts` (7).

Per screen:

| Change | Files |
|---|---|
| Poll 60 s + on focus (kill switches) | `useWithdrawalsPaused`, `usePayoutsUiEnabled`, `useLandlordPayoutsBlocked`, `useLandlordPayoutPriority`, `useProxyPayoutPriority` (return types widened with `lastUpdatedAt` / `refresh`) |
| Dead listener removed; gate still re-checked by the forced refetch before submit | `useWithdrawContext` (treasury listener only) |
| Poll 30 s | `CashoutPendingWithdrawalsDialog` (while open), `FinOpsWithdrawalVerification`, `DepositRequestsManager`, `ManagerDepositsWidget`, `useMerchantFloat` (board invalidation; per-merchant projection channels stay live), `useBusinessAdvanceRealtime` (now always `'polling'`, no toasts) |
| Poll 30 s, first page only | `TidVerification`: reloads page 1 fully; once the operator has scrolled further, it only prunes rows that are no longer pending (chunked `in()` status check) so their loaded pages survive |
| Poll 30 s, new rows only | `useEmailTransactionsPanel`: fetches `gmail_transactions` inserted since a server `created_at` cursor and prepends them, as the INSERT listener did. It uses a cursor rather than `internal_date` so late-ingested emails still appear. The dead `email_routing_history` listener is removed; routing history still reloads whenever `rows` changes |
| Poll 20 s (auto-refresh on) / 60 s (off) | `PhoneMoneyCard` (it used to stay live even with the toggle off) |
| Poll 60 s | `SmsFailoverAlerts` (failover toasts kept: each poll analyses only rows newer than the last one), `SmsDeliveryLogViewer` (new `refetchInterval`), `useCfoApprovalNotifications` (already had one; now exposes `lastUpdatedAt` / `refresh`), `Requisitions`, `StaffRequisitionQueue`, `AgentsSpacePanel` (requisitions), `RequisitionUsageReportGate`, `MerchantFloatRequisitionPanel`, `OfflineSubmissionsQueue`, `ManualRequisitionQueuePanel`, `SubscriptionMonitorWidget`, `pages/hr/Dashboard` (leave beacon), `useBikeLeaseRepayment`, `ConcernAssignmentGate`, `useAgentUnblockToast` (de-duped by event id), `RejectionAlertGate` (lookback re-run; `enqueue` de-dupes by key; the landlord-rejection listener stays live because that table is published), `TicketsPage` (new-ticket toast + chime kept by diffing the queue ids; skipped on first load), `EmptyHouseOpportunitiesSheet` / `SupportedHouseReturnsSection` (the `promissory_notes` listener stays live) |
| Dead listener removed; the screen already polled | `AgentBulkOpsConsole`, `AnalyticsExportJobsPanel`, `GrowthCommissionCard`, `MyWork`, `PlatformSalesOfficers` (the `promissory_commission_events` listener stays), `ProxyPartnerFunds` (only the `proxy_payout_settlements` listener removed) |
| Dead listener removed; loads on mount + manual refresh | `UserProfilesTable`, `PaidAgentsHistory`, `DepositDecisionAuditPanel`, `EmailMatchAuditLogPanel`, `EmailTransactionsPanel` (reconnect audit), `RecruitmentHub` (`job_applications` only), `useOpportunitySummary`, `useFunderAccountsRealtime` (the `wallets` view listener only), `BulkBankPayoutPanel` |

**Deviation from Gemini's table:** `BulkBankPayoutPanel` was marked "polling is fine", but its loader auto-expands the newest batch, so a timer would keep collapsing whatever the operator had open. It loads on mount only, and `load` is there for a refresh button.

**Kept live on purpose:** `AgentCashPayoutsTab` and `MerchantDispatchListener`, where agents wait at cashout. The reconciler fix (`143-withdrawal-settlement-reconciler-…`) removed most of the `withdrawal_requests` churn that made them expensive.

## Verification

- Re-audit after the change: the only remaining listeners on unpublished tables are the three **user-filtered** `deposit_requests` ones (`AgentPendingReceiptPanel`, `useAgentLandlordFloat`, `useWalletRequests`). They go live when that table is published (below).
- `tsc` on the 50 changed files and everything they import, using `tsconfig.app.json` settings with `types: []` (a full-project tsc can't complete locally): **exit 0, 0 errors**.
- esbuild syntax check of all 50 files: clean.
- `usePolling` unit tests: **7/7 pass**.
- `vitest related` on the changed files: 18 pass, 8 fail in `SettingsName.test.tsx` and `ExecutiveDashboardLayout.nesting.test.tsx`. **The same 8 fail on a clean `HEAD` checkout** (missing `QueryClientProvider` for `Settings.tsx`'s own `useQueryClient`; a missing "Call Center" sidebar item). They were already failing and are unrelated to this change.

## Not done: needs Josh

Changes to the Realtime **publication** were blocked by the tool permission check as shared-resource changes. They are low-risk, and verified to have **zero** listeners and zero live `realtime.subscription` rows:

```sql
-- 1) remove tables nobody listens to
ALTER PUBLICATION supabase_realtime DROP TABLE
  public.lc1_verification_requests, public.property_viewings, public.referrals,
  public.user_reviews, public.user_risk_scores, public.welile_homes_subscriptions;
-- 2) make agents' own deposit receipts live (only after this commit is deployed,
--    so the three backoffice screens are already polling)
ALTER PUBLICATION supabase_realtime ADD TABLE public.deposit_requests;
```
