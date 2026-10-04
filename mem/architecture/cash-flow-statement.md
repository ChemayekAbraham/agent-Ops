---
name: Statement of Cash Flows architecture
description: CFO Cash Flow report is ledger-derived via get_statement_of_cash_flows + cash_flow_line_map; cash = A1 + A2 only
type: feature
---
- CFO Dashboard → Financial Reports → Cash Flow renders `public.get_statement_of_cash_flows(p_from, p_to)` only. No wallet cache, operational table or hard-coded figure may feed it.
- Cash and cash equivalents = `A1` (Cash and Bank) + `A2` (Cash at Hand — Float with Agents) from `ledger_account_catalog`. A1↔A2 transfers are eliminated.
- Classification lives in `cash_flow_line_map` (section / group_label / line_label, keyed on counterpart account_code + category). `display_only` rows keep a line visible at zero. Add new business lines by seeding that table, never by editing the RPC.
- Structure is corporate style: Operating (Tenant, Agent, Partner, Landlord, Marketing, Other), Investing, Financing, then exchange-rate effect, net change, opening cash, closing cash.
- Historic single-sided ledger postings land on one disclosed line "Unreconciled single-sided historic postings" inside Other Operating Activities so Opening + Net = Closing always holds and closing cash equals the Balance Sheet cash accounts.
- Frontend: `src/hooks/useStatementOfCashFlows.ts` (+ `flattenCashFlowStatement` shared by screen, CSV and PDF) and `CashFlowSection` in `src/components/manager/FinancialStatementsPanel.tsx`.
