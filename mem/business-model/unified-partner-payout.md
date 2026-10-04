---
name: Unified Partner Payout Flow
description: All partner payouts (ROI, capital, profit share) flow through one channel — CFO approves, credits proxy agent wallet (managed-proxy routing), proxy agent initiates withdrawal, merchant claims. No separate "ROI Payments" merchant category.
type: feature
---
Single merchant payout category for partner money: `proxy_partner_withdrawal` (label "Partner Withdrawal (Proxy Initiated)"). The old `roi_payments` config category, its queue def, and the "Investment returns (ROI)" withdrawal reason option were removed on 2026-07-21.

Canonical pipeline: CFO Approval → Proxy Agent Wallet Credit (`cfo-direct-credit` with managed-proxy routing — see managed-proxy-payout-routing.md) → Proxy Agent Withdraw (AgentProxyWithdrawalDialog inserts `withdrawal_requests` with reason containing "proxy") → Merchant Agent claim/pay/complete → Partner receives funds.

The `proxy_partner_withdrawal` queue matcher also accepts legacy rows whose reason contains "roi" or "return" so historical direct-ROI `withdrawal_requests` still route to the same merchant desk. Do NOT re-introduce a distinct ROI merchant category — from the merchant's perspective every partner payout is a Partner Withdrawal.

`process-supporter-roi` stays paused (see Proxy Partner Custody v2). CFO drives disbursement manually via cfo-direct-credit, which is the sole way partner money enters a wallet.
