
-- Fix all NO ACTION FK constraints on profiles to SET NULL
-- This allows auth.users deletion to cascade to profiles without being blocked

-- tenant_transfers
ALTER TABLE tenant_transfers DROP CONSTRAINT IF EXISTS tenant_transfers_tenant_id_fkey;
ALTER TABLE tenant_transfers ADD CONSTRAINT tenant_transfers_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE tenant_transfers DROP CONSTRAINT IF EXISTS tenant_transfers_from_agent_id_fkey;
ALTER TABLE tenant_transfers ADD CONSTRAINT tenant_transfers_from_agent_id_fkey FOREIGN KEY (from_agent_id) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE tenant_transfers DROP CONSTRAINT IF EXISTS tenant_transfers_to_agent_id_fkey;
ALTER TABLE tenant_transfers ADD CONSTRAINT tenant_transfers_to_agent_id_fkey FOREIGN KEY (to_agent_id) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE tenant_transfers DROP CONSTRAINT IF EXISTS tenant_transfers_transferred_by_fkey;
ALTER TABLE tenant_transfers ADD CONSTRAINT tenant_transfers_transferred_by_fkey FOREIGN KEY (transferred_by) REFERENCES profiles(id) ON DELETE SET NULL;

-- agent_tasks
ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_assigned_by_fkey;
ALTER TABLE agent_tasks ADD CONSTRAINT agent_tasks_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_tenant_id_fkey;
ALTER TABLE agent_tasks ADD CONSTRAINT agent_tasks_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES profiles(id) ON DELETE SET NULL;

-- agent_escalations
ALTER TABLE agent_escalations DROP CONSTRAINT IF EXISTS agent_escalations_resolved_by_fkey;
ALTER TABLE agent_escalations ADD CONSTRAINT agent_escalations_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE agent_escalations DROP CONSTRAINT IF EXISTS agent_escalations_tenant_id_fkey;
ALTER TABLE agent_escalations ADD CONSTRAINT agent_escalations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES profiles(id) ON DELETE SET NULL;

-- financial_agents
ALTER TABLE financial_agents DROP CONSTRAINT IF EXISTS financial_agents_assigned_by_fkey;
ALTER TABLE financial_agents ADD CONSTRAINT financial_agents_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES profiles(id) ON DELETE SET NULL;

-- proxy_agent_assignments
ALTER TABLE proxy_agent_assignments DROP CONSTRAINT IF EXISTS proxy_agent_assignments_assigned_by_fkey;
ALTER TABLE proxy_agent_assignments ADD CONSTRAINT proxy_agent_assignments_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES profiles(id) ON DELETE SET NULL;

-- platform_expense_transfers
ALTER TABLE platform_expense_transfers DROP CONSTRAINT IF EXISTS platform_expense_transfers_agent_id_fkey;
ALTER TABLE platform_expense_transfers ADD CONSTRAINT platform_expense_transfers_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE platform_expense_transfers DROP CONSTRAINT IF EXISTS platform_expense_transfers_approved_by_fkey;
ALTER TABLE platform_expense_transfers ADD CONSTRAINT platform_expense_transfers_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES profiles(id) ON DELETE SET NULL;

-- payroll
ALTER TABLE payroll_batches DROP CONSTRAINT IF EXISTS payroll_batches_created_by_fkey;
ALTER TABLE payroll_batches ADD CONSTRAINT payroll_batches_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE payroll_items DROP CONSTRAINT IF EXISTS payroll_items_employee_id_fkey;
ALTER TABLE payroll_items ADD CONSTRAINT payroll_items_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES profiles(id) ON DELETE SET NULL;

-- cashout_agents
ALTER TABLE cashout_agents DROP CONSTRAINT IF EXISTS cashout_agents_assigned_by_fkey;
ALTER TABLE cashout_agents ADD CONSTRAINT cashout_agents_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES profiles(id) ON DELETE SET NULL;

-- payout_codes
ALTER TABLE payout_codes DROP CONSTRAINT IF EXISTS payout_codes_user_id_fkey;
ALTER TABLE payout_codes ADD CONSTRAINT payout_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE payout_codes DROP CONSTRAINT IF EXISTS payout_codes_claimed_by_fkey;
ALTER TABLE payout_codes ADD CONSTRAINT payout_codes_claimed_by_fkey FOREIGN KEY (claimed_by) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE payout_codes DROP CONSTRAINT IF EXISTS payout_codes_paid_by_fkey;
ALTER TABLE payout_codes ADD CONSTRAINT payout_codes_paid_by_fkey FOREIGN KEY (paid_by) REFERENCES profiles(id) ON DELETE SET NULL;

-- agent_landlord_payouts
ALTER TABLE agent_landlord_payouts DROP CONSTRAINT IF EXISTS agent_landlord_payouts_agent_id_fkey;
ALTER TABLE agent_landlord_payouts ADD CONSTRAINT agent_landlord_payouts_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES profiles(id) ON DELETE SET NULL;

-- agent_float_funding
ALTER TABLE agent_float_funding DROP CONSTRAINT IF EXISTS agent_float_funding_funded_by_fkey;
ALTER TABLE agent_float_funding ADD CONSTRAINT agent_float_funding_funded_by_fkey FOREIGN KEY (funded_by) REFERENCES profiles(id) ON DELETE SET NULL;

-- agent_float_withdrawals
ALTER TABLE agent_float_withdrawals DROP CONSTRAINT IF EXISTS agent_float_withdrawals_tenant_id_fkey;
ALTER TABLE agent_float_withdrawals ADD CONSTRAINT agent_float_withdrawals_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE agent_float_withdrawals DROP CONSTRAINT IF EXISTS agent_float_withdrawals_manager_reviewed_by_fkey;
ALTER TABLE agent_float_withdrawals ADD CONSTRAINT agent_float_withdrawals_manager_reviewed_by_fkey FOREIGN KEY (manager_reviewed_by) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE agent_float_withdrawals DROP CONSTRAINT IF EXISTS agent_float_withdrawals_agent_ops_reviewed_by_fkey;
ALTER TABLE agent_float_withdrawals ADD CONSTRAINT agent_float_withdrawals_agent_ops_reviewed_by_fkey FOREIGN KEY (agent_ops_reviewed_by) REFERENCES profiles(id) ON DELETE SET NULL;

-- suspense_ledger
ALTER TABLE suspense_ledger DROP CONSTRAINT IF EXISTS suspense_ledger_matched_to_user_id_fkey;
ALTER TABLE suspense_ledger ADD CONSTRAINT suspense_ledger_matched_to_user_id_fkey FOREIGN KEY (matched_to_user_id) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE suspense_ledger DROP CONSTRAINT IF EXISTS suspense_ledger_written_off_by_fkey;
ALTER TABLE suspense_ledger ADD CONSTRAINT suspense_ledger_written_off_by_fkey FOREIGN KEY (written_off_by) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE suspense_ledger DROP CONSTRAINT IF EXISTS suspense_ledger_matched_by_fkey;
ALTER TABLE suspense_ledger ADD CONSTRAINT suspense_ledger_matched_by_fkey FOREIGN KEY (matched_by) REFERENCES profiles(id) ON DELETE SET NULL;

-- default_recovery_ledger
ALTER TABLE default_recovery_ledger DROP CONSTRAINT IF EXISTS default_recovery_ledger_tenant_id_fkey;
ALTER TABLE default_recovery_ledger ADD CONSTRAINT default_recovery_ledger_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE default_recovery_ledger DROP CONSTRAINT IF EXISTS default_recovery_ledger_agent_id_fkey;
ALTER TABLE default_recovery_ledger ADD CONSTRAINT default_recovery_ledger_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE default_recovery_ledger DROP CONSTRAINT IF EXISTS default_recovery_ledger_write_off_approved_by_fkey;
ALTER TABLE default_recovery_ledger ADD CONSTRAINT default_recovery_ledger_write_off_approved_by_fkey FOREIGN KEY (write_off_approved_by) REFERENCES profiles(id) ON DELETE SET NULL;

-- supporter_capital_ledger
ALTER TABLE supporter_capital_ledger DROP CONSTRAINT IF EXISTS supporter_capital_ledger_supporter_id_fkey;
ALTER TABLE supporter_capital_ledger ADD CONSTRAINT supporter_capital_ledger_supporter_id_fkey FOREIGN KEY (supporter_id) REFERENCES profiles(id) ON DELETE SET NULL;

-- commission_accrual_ledger
ALTER TABLE commission_accrual_ledger DROP CONSTRAINT IF EXISTS commission_accrual_ledger_agent_id_fkey;
ALTER TABLE commission_accrual_ledger ADD CONSTRAINT commission_accrual_ledger_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE commission_accrual_ledger DROP CONSTRAINT IF EXISTS commission_accrual_ledger_tenant_id_fkey;
ALTER TABLE commission_accrual_ledger ADD CONSTRAINT commission_accrual_ledger_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE commission_accrual_ledger DROP CONSTRAINT IF EXISTS commission_accrual_ledger_approved_by_fkey;
ALTER TABLE commission_accrual_ledger ADD CONSTRAINT commission_accrual_ledger_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES profiles(id) ON DELETE SET NULL;

-- fee_revenue_ledger
ALTER TABLE fee_revenue_ledger DROP CONSTRAINT IF EXISTS fee_revenue_ledger_tenant_id_fkey;
ALTER TABLE fee_revenue_ledger ADD CONSTRAINT fee_revenue_ledger_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES profiles(id) ON DELETE SET NULL;

-- settlement_reconciliation_ledger
ALTER TABLE settlement_reconciliation_ledger DROP CONSTRAINT IF EXISTS settlement_reconciliation_ledger_reconciled_by_fkey;
ALTER TABLE settlement_reconciliation_ledger ADD CONSTRAINT settlement_reconciliation_ledger_reconciled_by_fkey FOREIGN KEY (reconciled_by) REFERENCES profiles(id) ON DELETE SET NULL;

-- funder_visits
ALTER TABLE funder_visits DROP CONSTRAINT IF EXISTS funder_visits_agent_id_fkey;
ALTER TABLE funder_visits ADD CONSTRAINT funder_visits_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE funder_visits DROP CONSTRAINT IF EXISTS funder_visits_funder_id_fkey;
ALTER TABLE funder_visits ADD CONSTRAINT funder_visits_funder_id_fkey FOREIGN KEY (funder_id) REFERENCES profiles(id) ON DELETE SET NULL;

-- Also make the columns nullable where they aren't already
ALTER TABLE tenant_transfers ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE tenant_transfers ALTER COLUMN from_agent_id DROP NOT NULL;
ALTER TABLE tenant_transfers ALTER COLUMN to_agent_id DROP NOT NULL;
ALTER TABLE tenant_transfers ALTER COLUMN transferred_by DROP NOT NULL;
ALTER TABLE agent_landlord_payouts ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE agent_float_funding ALTER COLUMN funded_by DROP NOT NULL;
ALTER TABLE agent_float_withdrawals ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE commission_accrual_ledger ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE payout_codes ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE funder_visits ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE funder_visits ALTER COLUMN funder_id DROP NOT NULL;
