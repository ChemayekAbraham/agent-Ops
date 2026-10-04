---
name: Managed-Proxy Payout Routing
description: Wallet credits for partners with an active+approved is_managed_account=true proxy assignment route to the proxy's wallet; partner gets a notice naming the agent; the proxy receives a "proxy-managed-payout-notice" email.
type: feature
---
When a partner has a `proxy_agent_assignments` row with `is_active=true`, `approval_status='approved'`, AND `is_managed_account=true`:
- The wallet-leg of any partner ROI payout (enforced in `process-supporter-roi`, `approve-wallet-operation`, and `cfo-direct-credit`) MUST credit `user_id = proxy.agent_id`, NEVER the partner. The ledger leg must set `linked_party = partner_id` so FinOps can debit the proxy agent wallet for that exact partner later. The platform-leg still references the partner for accounting.
- Managed-proxy ROI cannot be split between cash/reinvestment from the COO payout UI. If the partner is managed by a proxy agent, the full ROI amount must be sent to the proxy agent wallet.
- Helper: `resolveManagedProxy(supabase, partnerId)` in `supabase/functions/_shared/partnership-emails.ts` is the single source of truth for this check.
- Partner email: `returns-disbursement-confirmation` is sent with `isManagedByAgent=true` + `agentName` so the body explicitly names the proxy agent who received the funds. The `payoutMethod` label becomes `Proxy Agent Wallet (<name>)`.
- Proxy email: a new template `proxy-managed-payout-notice` is sent to the agent via `buildProxyManagedPayoutRequest`. Idempotency key: `proxy-managed-payout-<agentId>-<partnerId>-<txGroupId>`.
- In-app notifications: partner gets "Monthly Reward Sent to Your Proxy Agent" with metadata `routed_to_proxy_agent_id` + `proxy_assignment_id`; proxy gets "Proxy Payout Received" with metadata `on_behalf_of_partner_id`.
- Auto-reinvest branch is unaffected — those funds stay in the portfolio principal, never touching a wallet.

Withdrawal rule:
- Once the proxy agent submits the partner withdrawal, `approve-withdrawal` must debit the assigned proxy agent wallet only, using the partner-linked ROI ledger basis. It must not debit or require withdrawable money on the partner wallet/dashboard.

Funding rule (Partner Ops & COO dashboards):
- For a partner with an active+approved+`is_managed_account=true` proxy assignment the proxy wallet is the funding DEFAULT, but the operator's explicit wallet selection wins. As of 2026-06-04, `coo-create-portfolio` honours the operator's choice: if the operator selects the partner's own wallet (`payment_method=wallet` + `source_wallet_user_id=partner_id`) it funds from the partner wallet; if they select the proxy card (`payment_method=proxy_agent` + source=managed proxy `agentId`) it funds from the proxy wallet. Only an ambiguous/unspecified selection defaults to the managed proxy. Both paths stay independently validated (proxy assignment must be approved; wallet source must equal the partner), so honouring the selection bypasses no control.
- `coo-wallet-to-portfolio` still hard-overrides to the proxy agent wallet (unchanged). If operator-selection-wins is desired there too, apply the same pattern.
- `manager-portfolio-topup` (Portfolio Top-Up dialog, `FundInvestmentAccountDialog`) honours the operator's explicit "Partner Wallet + Personal Deposit" selection as of 2026-06-15: when `payment_method='wallet'` AND `fund_source='withdrawable'` the managed-proxy override is SKIPPED and the deduction comes from the PARTNER wallet, never the proxy agent wallet. All other combinations (proxy_agent, or float bucket on a managed partner) still hard-override to the proxy agent wallet. `user_wallet` remains exempt as before.
