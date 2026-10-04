/**
 * FormContract definitions for all financial forms in Welile.
 * 
 * Each contract mirrors the database schema exactly.
 * Values ≠ Labels. Derived fields are never user-editable.
 */

import { FormContract } from './types';

// ═══════════════════════════════════════════
// RENT REQUEST
// ═══════════════════════════════════════════
export const RENT_REQUEST_CONTRACT: FormContract = {
  tenant_id: { type: 'uuid', required: true, label: 'Tenant ID' },
  agent_id: { type: 'uuid', required: false, label: 'Agent ID' },
  landlord_id: { type: 'uuid', required: true, label: 'Landlord ID' },
  lc1_id: { type: 'uuid', required: true, label: 'LC1 Chairperson ID' },
  rent_amount: { type: 'numeric', required: true, label: 'Rent Amount', min: 10000, max: 10000000 },
  duration_days: { type: 'integer', required: true, label: 'Duration (days)', allowedValues: [7, 14, 30, 60, 90, 120] },
  access_fee: { type: 'numeric', required: true, label: 'Access Fee', min: 0, derived: true },
  request_fee: { type: 'numeric', required: true, label: 'Request Fee', min: 0, derived: true },
  total_repayment: { type: 'numeric', required: true, label: 'Total Repayment', min: 0, derived: true },
  daily_repayment: { type: 'numeric', required: true, label: 'Daily Repayment', min: 0, derived: true },
  request_latitude: { type: 'numeric', required: false, label: 'Latitude' },
  request_longitude: { type: 'numeric', required: false, label: 'Longitude' },
  request_city: { type: 'text', required: false, label: 'City', maxLength: 100 },
  request_country: { type: 'text', required: false, label: 'Country', maxLength: 100 },
  tenant_electricity_meter: { type: 'text', required: false, label: 'Electricity Meter', maxLength: 50 },
  tenant_water_meter: { type: 'text', required: false, label: 'Water Meter', maxLength: 50 },
};

// ═══════════════════════════════════════════
// LANDLORD
// ═══════════════════════════════════════════
export const LANDLORD_CONTRACT: FormContract = {
  name: { type: 'text', required: true, label: 'Landlord Name', minLength: 2, maxLength: 200 },
  phone: { type: 'text', required: true, label: 'Phone Number', minLength: 10, maxLength: 15 },
  property_address: { type: 'text', required: true, label: 'Property Address', minLength: 3, maxLength: 500 },
  mobile_money_number: { type: 'text', required: false, label: 'Mobile Money Number', maxLength: 15 },
  bank_name: { type: 'text', required: false, label: 'Bank Name', maxLength: 100 },
  account_number: { type: 'text', required: false, label: 'Account Number', maxLength: 50 },
  monthly_rent: { type: 'numeric', required: false, label: 'Monthly Rent', min: 0 },
  registered_by: { type: 'uuid', required: false, label: 'Registered By' },
  tenant_id: { type: 'uuid', required: false, label: 'Tenant ID' },
};

// ═══════════════════════════════════════════
// LC1 CHAIRPERSON
// ═══════════════════════════════════════════
export const LC1_CONTRACT: FormContract = {
  name: { type: 'text', required: true, label: 'LC1 Name', minLength: 2, maxLength: 200 },
  phone: { type: 'text', required: true, label: 'LC1 Phone', minLength: 10, maxLength: 15 },
  village: { type: 'text', required: true, label: 'Village', minLength: 2, maxLength: 200 },
};

// ═══════════════════════════════════════════
// DEPOSIT REQUEST
// ═══════════════════════════════════════════
export const DEPOSIT_REQUEST_CONTRACT: FormContract = {
  user_id: { type: 'uuid', required: true, label: 'User ID' },
  amount: { type: 'numeric', required: true, label: 'Amount', min: 1000, max: 50000000 },
  provider: { type: 'text', required: false, label: 'Provider', allowedValues: ['mtn', 'airtel', 'bank'] },
  transaction_id: { type: 'text', required: false, label: 'Transaction ID', maxLength: 100 },
  transaction_date: { type: 'timestamp', required: false, label: 'Transaction Date' },
  agent_id: { type: 'uuid', required: false, label: 'Agent ID' },
  notes: { type: 'text', required: false, label: 'Notes', maxLength: 500 },
};

// ═══════════════════════════════════════════
// USER LOAN
// ═══════════════════════════════════════════
export const USER_LOAN_CONTRACT: FormContract = {
  borrower_id: { type: 'uuid', required: true, label: 'Borrower ID' },
  lender_id: { type: 'uuid', required: true, label: 'Lender ID' },
  amount: { type: 'numeric', required: true, label: 'Loan Amount', min: 1000, max: 10000000 },
  interest_rate: { type: 'numeric', required: true, label: 'Interest Rate', min: 0, max: 100 },
  total_repayment: { type: 'numeric', required: true, label: 'Total Repayment', min: 0, derived: true },
  due_date: { type: 'text', required: true, label: 'Due Date' },
};

// ═══════════════════════════════════════════
// LOAN REPAYMENT
// ═══════════════════════════════════════════
export const LOAN_REPAYMENT_CONTRACT: FormContract = {
  loan_id: { type: 'uuid', required: true, label: 'Loan ID' },
  borrower_id: { type: 'uuid', required: true, label: 'Borrower ID' },
  amount: { type: 'numeric', required: true, label: 'Repayment Amount', min: 100, max: 50000000 },
  payment_method: { type: 'text', required: false, label: 'Payment Method', allowedValues: ['wallet', 'mobile_money'] },
};

// ═══════════════════════════════════════════
// GENERAL LEDGER (manual entry)
// ═══════════════════════════════════════════
export const GENERAL_LEDGER_CONTRACT: FormContract = {
  amount: { type: 'numeric', required: true, label: 'Amount', min: 1 },
  direction: { type: 'text', required: true, label: 'Direction', allowedValues: ['cash_in', 'cash_out'] },
  category: {
    type: 'text',
    required: true,
    label: 'Category',
    allowedValues: [
      'tenant_access_fee', 'tenant_request_fee', 'rent_repayment',
      'supporter_facilitation_capital', 'agent_remittance', 'platform_service_income',
      'rent_facilitation_payout', 'supporter_platform_rewards',
      'agent_commission_payout', 'transaction_platform_expenses', 'operational_expenses',
    ],
  },
  linked_party: { type: 'text', required: false, label: 'Linked Party', allowedValues: ['tenant', 'agent', 'supporter', 'platform'] },
  reference_id: { type: 'text', required: false, label: 'Reference ID', maxLength: 50 },
  description: { type: 'text', required: false, label: 'Description', maxLength: 500 },
  source_table: { type: 'text', required: true, label: 'Source Table' },
};

// ═══════════════════════════════════════════
// WALLET TRANSACTION  
// ═══════════════════════════════════════════
export const WALLET_TRANSACTION_CONTRACT: FormContract = {
  sender_id: { type: 'uuid', required: true, label: 'Sender ID' },
  recipient_id: { type: 'uuid', required: true, label: 'Recipient ID' },
  amount: { type: 'numeric', required: true, label: 'Amount', min: 100, max: 50000000 },
  description: { type: 'text', required: false, label: 'Description', maxLength: 500 },
};

// ═══════════════════════════════════════════
// SUPPORTER INVITE
// ═══════════════════════════════════════════
export const SUPPORTER_INVITE_CONTRACT: FormContract = {
  full_name: { type: 'text', required: true, label: 'Full Name', minLength: 2, maxLength: 200 },
  phone: { type: 'text', required: true, label: 'Phone', minLength: 10, maxLength: 15 },
  email: { type: 'text', required: true, label: 'Email', maxLength: 255 },
  role: { type: 'text', required: true, label: 'Role', allowedValues: ['supporter', 'agent', 'tenant'] },
  created_by: { type: 'uuid', required: true, label: 'Created By' },
  temp_password: { type: 'text', required: true, label: 'Temporary Password', minLength: 6 },
};

// ═══════════════════════════════════════════
// AGENT COMMISSION PAYOUT
// ═══════════════════════════════════════════
export const AGENT_PAYOUT_CONTRACT: FormContract = {
  agent_id: { type: 'uuid', required: true, label: 'Agent ID' },
  amount: { type: 'numeric', required: true, label: 'Payout Amount', min: 1000, max: 50000000 },
  mobile_money_provider: { type: 'text', required: true, label: 'Provider', allowedValues: ['mtn', 'airtel'] },
  mobile_money_number: { type: 'text', required: true, label: 'Mobile Money Number', minLength: 10, maxLength: 15 },
};

// ═══════════════════════════════════════════
// MONEY REQUEST
// ═══════════════════════════════════════════
export const MONEY_REQUEST_CONTRACT: FormContract = {
  requester_id: { type: 'uuid', required: true, label: 'Requester ID' },
  recipient_id: { type: 'uuid', required: true, label: 'Recipient ID' },
  amount: { type: 'numeric', required: true, label: 'Amount', min: 100, max: 50000000 },
  description: { type: 'text', required: false, label: 'Description', maxLength: 500 },
};

// ═══════════════════════════════════════════
// INVESTOR PORTFOLIO
// ═══════════════════════════════════════════
export const INVESTOR_PORTFOLIO_CONTRACT: FormContract = {
  investor_id: { type: 'uuid', required: false, label: 'Investor ID' },
  agent_id: { type: 'uuid', required: true, label: 'Agent ID' },
  invite_id: { type: 'uuid', required: false, label: 'Invite ID' },
  investment_amount: { type: 'numeric', required: true, label: 'Investment Amount', min: 1000, max: 50000000 },
  duration_months: { type: 'integer', required: true, label: 'Duration (months)', allowedValues: [3, 6, 12] },
  roi_percentage: { type: 'numeric', required: true, label: 'Monthly ROI %', min: 1, max: 100 },
  roi_mode: { type: 'text', required: true, label: 'ROI Mode', allowedValues: ['monthly_payout', 'monthly_compounding'] },
  payment_method: { type: 'text', required: false, label: 'Payment Method', allowedValues: ['mobile_money', 'bank'] },
  mobile_network: { type: 'text', required: false, label: 'Mobile Network', allowedValues: ['mtn', 'airtel'] },
  mobile_money_number: { type: 'text', required: false, label: 'Mobile Money Number', maxLength: 20 },
  bank_name: { type: 'text', required: false, label: 'Bank Name', maxLength: 100 },
  account_name: { type: 'text', required: false, label: 'Account Name', maxLength: 200 },
  account_number: { type: 'text', required: false, label: 'Account Number', maxLength: 50 },
  portfolio_pin: { type: 'text', required: true, label: 'Portfolio PIN', minLength: 4, maxLength: 4 },
};
