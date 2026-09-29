# 155 — Fred Muwanguzi: 13 Aug advance cancelled, the 23 Sep top-up is his only advance

**Status: LIVE 2026-09-29.** CFO decision, instructed by Joshua Wanda and carried out by Claude against production.

**Agent:** FRED MUWANGUZI, +256708778540, `9bb21b14-cf97-428d-960a-abdd244e80b8`

## Why

The 13 Aug advance (`19c74e2a`, 1,000,000 principal) was settled at the top-up:

| When (Kampala) | Event | Old advance balance |
|---|---|---|
| 20 Sep | after ordinary deductions | 974,006.42 |
| 21 Sep 14:24 | CFO Record Payment **487,003** (entry 12 in handover 137) | 487,003.42 |
| 23 Sep 13:47 | top-up `1ad14342` of 700,000 credited to his wallet | |
| 23 Sep 13:55 | ECW-E53519D256: FinOps moved **485,452** from his wallet, "Repayment of Advance" | (not on the statement) |
| 23 Sep 15:01 / 15:22 | duplicate cron deduction of 215,318, refunded | |
| 23 Sep 15:24 | old advance closed | 0 |
| 27 Sep | handover 139 reinstated the 487,003 as a fake clearance | 487,003 |

487,003 + 485,452 = 972,455, essentially the whole 974,006. Josh confirmed the 21 Sep entry was recorded deliberately at the top-up. **This overrides handover 139's reading of entry 12 for Fred.** The 27 Sep reinstatement had made him owe 482,022 on the old advance on top of 825,000 on the top-up.

## What was done

1. **Old advance cancelled.** `cancel_agent_advance('19c74e2a…', p_recoup => false)` was called as Joshua. The old advance is `cancelled / write_off`. `pre_cancel_outstanding` is **491,010**: the recalculated statement end, which includes its own penalty.
2. **The 8 wallet deductions taken for it from 27 to 29 Sep (8,988) were moved onto the top-up.** The 28 Sep row mixed a 4,007 penalty with a 580 deduction. It was split so the penalty stays on the old advance as its own row, and only the 580 moved. Both statements were recalculated.
3. **Top-up `1ad14342`: 825,000 → 816,012.** The Wallet check shows it **reconciled** (8 deductions = 8 wallet debits = 8,988). It still recovers from returns (`recovery_source = 'roi'`) in one monthly instalment due 23 Oct, with a daily instalment of 0.
4. **Correction SMS sent** (Africa's Talking, `ATXid_00f98f9a…`): "…UGX 825,000 less UGX 8,988 already recovered = balance UGX 816,012, due 23 Oct…".

Audit entries: `agent_advance_cancelled`, `agent_advance_deductions_reattributed`. No wallet or `general_ledger` rows were changed.

## Cost

This writes off the old advance, 491,010 including penalty. The top-up's 825,000 does not include the 487,003 recorded on 21 Sep, so that amount is forgiven, not moved to the top-up.

## Still open

The old advance's statement still jumps from 274,144 (23 Sep 15:01) to 0 (the 15:24 close, which wrote no row). That's historical, on a cancelled advance, and left as it is.
