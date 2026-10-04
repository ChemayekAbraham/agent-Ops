---
name: ROI Disbursement Report (CFO)
description: Read-only CFO Returns disbursement report replicating the ROI_Disbursement_Report_2026-08-10_v9 template, with daily/weekly/monthly/yearly windows
type: feature
---
`get_roi_disbursement_report(p_start timestamptz, p_end timestamptz)` (SECURITY DEFINER, STABLE, search_path=public, execute granted to authenticated + service_role, gated to cfo/ceo/coo/manager/super_admin) returns the whole report as jsonb. It ONLY reads `general_ledger` (`roi_wallet_credit`, `roi_reinvestment`, `roi_expense`), `investor_portfolios`, `profiles` and `audit_logs` — it never writes and must never be extended to mutate.

Sections (mirroring the v9 PDF template, terminology preserved):
1. Cash Returns disbursed to wallets — #, portfolio phone, partner, paid to (wallet), principal, returns paid, time EAT
2. Returns compounded into principal — new principal, returns compounded, executed by
3. Approval chain — actor names from `audit_logs` actions `roi_payout_requested` (Partner Ops), `coo_roi_approval` (COO), `cfo_roi_payout_approved` (CFO), `roi_compounded`
4. Ledger reconciliation — wallet credits + reinvestments must equal platform `roi_expense`
5. Payout routing note — managed-proxy wallets that received partner Returns
6. Exceptions — same portfolio compounded AND paid the same amount in the window

UI: `src/components/cfo/RoiDisbursementReportPanel.tsx`, CFO sidebar id `roi-disbursement-report` ("Returns Disbursement Report" under Reports & Audit). Periods are computed on EAT (UTC+3) boundaries; weeks start Monday. Exports: print, PDF via `downloadAuditPdf`, CSV per table.
