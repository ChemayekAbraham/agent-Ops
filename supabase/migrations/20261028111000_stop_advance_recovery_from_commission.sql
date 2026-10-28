-- An agent's commission is no longer taken toward his advance the moment he earns it.
--
-- WHAT WAS HAPPENING: trigger trg_recover_advance_arrears_on_earning (on general_ledger, AFTER INSERT) fired on EVERY commission credit
-- (category agent_commission_earned or agent_commission, wallet scope, cash_in). If the agent had an advance with arrears it called
-- recover_agent_arrears_from_credit, which took up to the commission amount (capped at the arrears and the wallet balance) as an
-- 'agent_repayment' leg described "Missed advance repayment auto-recovered from new earning". So an agent collecting rent for tenants saw each
-- commission shrink as it landed. Over 14 to 28 Oct: 94 such legs on 27 Oct (8 agents, UGX 157,023), 86 on 26 Oct (UGX 171,547), 166 on 15 Oct
-- (UGX 409,855).
--
-- WHAT THIS DOES: drops that trigger. Commission now lands whole.
-- WHAT IT DOES NOT TOUCH: the advance is still recovered the way it is scheduled, from the withdrawable balance: the daily deduction, the
-- 15-minute sweep and the deduction taken at withdrawal, each capped at the day's installment plus arrears. recover_agent_arrears_from_credit
-- itself stays in place (unused). An advance whose recovery_source is 'roi' is unaffected. Pay now (20261028100500) is unaffected.
-- NOTE: the daily and sweep deductions work on the agent's whole withdrawable balance, which includes commission already paid into it. If commission
-- must be kept out of ALL advance recovery, those two need a separate change.
-- Roll back with 20261028111000_stop_advance_recovery_from_commission.rollback.sql.

DROP TRIGGER IF EXISTS trg_recover_advance_arrears_on_earning ON public.general_ledger;
