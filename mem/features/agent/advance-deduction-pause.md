---
name: Agent advance deduction pause
description: Agent Ops / CFO can pause an individual agent advance's deductions during a dispute; all auto-recovery paths honour deduction_paused
type: feature
---
- `agent_advances.deduction_paused` (+ `paused_at/paused_by/pause_reason/resumed_at/resumed_by`) is the single switch that stops collection on ONE advance. Status stays `active`/`overdue` so exposure, arrears and interest reporting are unaffected — only collection stops.
- Actions: `pause_agent_advance(p_advance_id, p_reason)` / `resume_agent_advance(p_advance_id, p_reason)`. Gated by `can_pause_agent_advance` (cfo, agent_ops, manager, coo, ceo, super_admin), reason min 10 chars, every action logged to `agent_advance_pause_events` + `audit_logs` + `system_events` (`repayment_paused` / `repayment_resumed`).
- **Constraint:** EVERY new or edited auto-recovery path must filter `COALESCE(deduction_paused,false) = false`. Currently honoured by: `sweep_agent_advance_recovery`, `apply_roi_advance_recovery`, `recover_agent_arrears_from_credit`, `tg_recover_advance_arrears_on_earning`, and the `process-agent-advance-deductions` edge function.
- Resuming restarts the schedule from today; paused days are NOT back-charged (the sweep's expected-to-date logic will still see the shortfall as arrears — do not add a separate catch-up charge).
- UI: `AdvancePauseDialog` (shared) used from CFO `AgentAdvancesOutstandingPanel` and Agent Ops `AgentAdvanceRepaymentMonitor`; agents see a plain "on hold while under review" notice on `AgentMyAdvancesCard`.
