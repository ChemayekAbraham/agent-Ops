/**
 * Core Service Layer
 * 
 * Isolated business logic abstraction. These services are NOT connected
 * to any existing flows. They will be wired in future phases behind
 * feature flags.
 * 
 * Rules:
 * - No direct DB mutations without ledger entries
 * - All money movement must be append-only
 * - Services are stateless; state lives in the DB/ledger
 */

export { TransactionService } from './transactionService';
export { WalletService } from './walletService';
