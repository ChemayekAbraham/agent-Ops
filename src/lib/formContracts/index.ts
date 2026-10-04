// FormContract System — Schema-Driven, Fintech-Grade Validation
export type { FormContract, FieldContract, FieldType, ValidationResult, ValidationError } from './types';
export { validateFormPayload, assertValid } from './validator';
export {
  RENT_REQUEST_CONTRACT,
  LANDLORD_CONTRACT,
  LC1_CONTRACT,
  DEPOSIT_REQUEST_CONTRACT,
  USER_LOAN_CONTRACT,
  LOAN_REPAYMENT_CONTRACT,
  GENERAL_LEDGER_CONTRACT,
  WALLET_TRANSACTION_CONTRACT,
  SUPPORTER_INVITE_CONTRACT,
  AGENT_PAYOUT_CONTRACT,
  MONEY_REQUEST_CONTRACT,
} from './contracts';
