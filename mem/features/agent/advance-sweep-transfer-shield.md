---
name: Advance sweep peer-transfer shield
description: Peer wallet_transfer credits are protected from agent advance auto-recovery via get_agent_sweepable_withdrawable
type: feature
---
Peer-to-peer `wallet_transfer` credits into an agent's wallet must NEVER be swept
into their outstanding advance. Both advance-recovery paths gate on
`get_agent_sweepable_withdrawable(agent_id)` instead of raw
`get_user_available_balance`:

- 15-min `public.sweep_agent_advance_recovery()` (DB function)
- Daily 17:50 EAT `process-agent-advance-deductions` edge function

`get_agent_sweepable_withdrawable` = `get_user_available_balance` minus a shield =
`GREATEST(0, Σ(cash_in wallet_transfer) − Σ(cash_out excl. agent_repayment))` from
the oldest ACTIVE/OVERDUE advance's `issued_at`. Any spending by the agent (send
money, withdrawal, rent payment, etc.) consumes the shield first; once the agent
has moved that money on, it's no longer shielded.

SMS on every sweep debit remains authoritative via `notify-advance-deduction`
(triggered by the DB sweep) and inline via `attemptYoolaPrimary` in the edge fn.

Do not read `get_user_available_balance` inside advance sweeps.