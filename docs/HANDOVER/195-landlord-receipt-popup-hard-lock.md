# 195 — Landlord receipt pop-up is now a hard lock (2026-10-05)

**Frontend logic only. No migration, no edge function, no money movement.**

Ordered by the CEO: agents must not be able to do anything until they have
filed the landlord receipt for every payout that is `awaiting_agent_receipt`.

## Before
`ReceiptNumberCheckDialog` was lockable but gave an escape after 15 seconds
(`canDismiss`), and `AgentDashboard` only re-opened it every 5 minutes.
The on-demand "check a receipt" mode (nothing pending) was also locked until a
receipt was found, trapping the agent.

## After
- `locked = pendingCount > 0 && outstanding.length > 0`. No timer, no escape
  (close button, Escape and outside-click are all blocked while locked).
- The dialog opens whenever the agent has pending receipts and cannot be closed
  until each one is confirmed through `confirm-landlord-payout-receipt`.
- The on-demand check (nothing pending) is no longer locked.
- 5-minute re-open interval removed (it can no longer be closed, so unneeded).

## Scope — unchanged on purpose
`usePendingLandlordReceipts` still only counts payouts disbursed on/after
2026-09-21 (53 payouts on 2026-10-05). Live count of all
`awaiting_agent_receipt` rows is 978 (UGX 578,025,000, 81 agents, oldest
2026-06-04). The 925 older ones are NOT in the lock; including them would lock
agents out over payouts that may not be matchable. Needs a decision.

## Known limits
- The lock lives in `AgentDashboard` only. An agent can still reach other routes
  directly; a route-level gate has not been built.
- If a landlord's SMS never arrives, the agent has no in-app way out.
