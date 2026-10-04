---
name: Angel Pool dual-funding
description: Agent Angel Pool registration supports funding_source 'investor'|'agent'; agent wallet funds gated by get_user_available_balance; funded_by column on angel_pool_investments
type: feature
---
- `agent-angel-pool-invest` accepts `funding_source` ('investor' default | 'agent'). Investor-wallet path is unchanged for backward compat.
- Funding wallet check uses strict `get_user_available_balance(funding_user_id)` RPC (never trusts cached `wallets.balance`).
- Wallet `cash_out` ledger leg's `user_id` = funding user (agent or investor); platform `cash_in` (`pool_capital_received`) always tagged with investor as beneficiary; descriptions annotated with `funded_by=...`.
- Shares are always allocated to the investor regardless of who paid.
- Agent commission (1%) credits the agent in both modes.
- `angel_pool_investments.funded_by` ('investor'|'agent', default 'investor', CHECK + index) records audit truth.
- Confirmation email includes "Funded By" row to inform the investor when the agent paid on their behalf.
