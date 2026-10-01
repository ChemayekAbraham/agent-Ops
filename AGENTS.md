# Architecture Decisions

- Requisition approval errors are normalized only in the client; server authorization remains the sole permission authority.
- Four-part repayment validation reconciles Returns + Agent Commission + Platform Fee to Access Fee + Registration Fee, because those two stored fee components form the approved Platform Fee pool.
- CFO 7-day reporting labels and day buckets use Kampala (EAT, UTC+3) calendar days through `src/lib/kampalaDays.ts`, because the reporting RPCs (`get_cfo_seven_day_lines`, `get_*_predictive_forecast`) anchor "today" to Africa/Kampala; browser-local dates shifted the cards by a day.
- Agent Ops opens on 14 business-area entry panels, while all legacy views remain reachable through the collapsible desktop sections menu or mobile sections menu, so reorganizing the landing view never removes management data.
- Agent Ops Shopping Advance qualification counts distinct outbound peer-transfer senders across historical wallet transactions and current wallet-ledger records via a role-gated read-only RPC, so legacy transfers count without mistaking a displayed access limit for issued credit.
- Supporter/partner support capacity and the funding debit use operational float only (`funder_support_capacity` = `funder_float_available`); withdrawable money is never used to fund support, so Returns stay withdrawable and support never drains them.
- Balance Sheet (`sofp_ledger_legs`) reads advance top-up company legs as Agent Advance Receivable (A10) and emits no synthetic X4 lines for bucket_reclass_in/out pairs, because top-ups move no bank cash and reclass pairs already balance (CFO approved 2026-10-01).
- `v_agent_daily_eligibility` falls back to LEAST(daily_repayment, outstanding) for counted daily/lapsed-weekly plans only when the agent has no pinned bill today/yesterday, because counted plans with no bill row showed a UGX 0 target.

- The CRM call drawer paints directory identity immediately, then loads the full dossier through one cached server function, `crm_callee_dossier`, which decides partner visibility (partner_ops / super_admin / hr only); this prevents duplicate reads without moving role enforcement into the browser.
- CFO bulk rent payments use a local selection-only review screen and revalidate every selected request before the existing payment function is called, so opening bulk review can never move money or change workflow state.
- Agent Ops Shopping Advance opens each qualified user's complete read-only dossier through one role-gated server function, so financial, Rent Plan, partnership, share, and AI ID details stay consistent without duplicate client reads.
- The CFO staff TIN/NSSF list is derived per paid payroll run (`cfo_statutory_consent_list`) and its push fires from the `paid` payroll event, because the list must reappear after each survey-and-payment cycle without polling.
