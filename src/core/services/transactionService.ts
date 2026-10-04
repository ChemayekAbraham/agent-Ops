/**
 * Transaction Service (Phase 2 — Shadow Mode)
 * 
 * Mirrors validation and ledger-entry construction logic from production
 * edge functions. Pure functions only — no DB calls, no side effects.
 * 
 * NOT connected to any existing flows. Will be wired in future phases
 * behind feature flags.
 * 
 * Mapping:
 *   wallet-transfer        → validateWalletTransfer, buildTransferLedgerEntries
 *   agent-deposit           → validateAgentDeposit, calculateRepaymentSplit, buildDepositLedgerEntries
 *   fund-rent-pool          → validatePoolFunding, buildPoolFundingEntries
 *   cfo-direct-credit       → validateCfoAdjustment, buildCfoAdjustmentEntries
 *   approve-wallet-operation→ buildApprovalLedgerEntry
 */

// ── Constants (mirrored from edge functions) ──────────────────────────

export const AGENT_COMMISSION_RATE = 0.05;
export const MAX_TRANSFER_AMOUNT = 100_000_000;
export const MAX_CFO_AMOUNT = 50_000_000;
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Core Types ────────────────────────────────────────────────────────

export interface LedgerEntry {
  id?: string;
  transactionId: string;
  accountId: string;
  entryType: 'debit' | 'credit';
  amount: number;
  currency: string;
  description: string;
  createdAt?: string;
}

export interface TransactionRequest {
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  currency: string;
  description: string;
  metadata?: Record<string, unknown>;
}

export interface TransactionResult {
  success: boolean;
  transactionId?: string;
  entries?: LedgerEntry[];
  error?: string;
}

// ── Shadow Types (mirroring edge function inputs) ─────────────────────

export interface WalletTransferRequest {
  senderId: string;
  recipientId?: string;
  recipientPhone?: string;
  amount: number;
  description?: string;
}

export interface AgentDepositRequest {
  agentId: string;
  userId?: string;
  userPhone?: string;
  amount: number;
}

export interface PoolFundingRequest {
  userId: string;
  amount: number;
  summaryId?: string;
  roles: string[];
}

export interface CfoAdjustmentRequest {
  operatorId: string;
  targetUserId: string;
  amount: number;
  reason: string;
  operation: 'credit' | 'debit';
  operatorRoles: string[];
}

export interface RepaymentSplit {
  repaymentAmount: number;
  commission: number;
  landlordPayment: number;
  remainingDeposit: number;
}

export interface GeneralLedgerShape {
  userId: string | null;
  amount: number;
  direction: 'cash_in' | 'cash_out';
  category: string;
  description: string;
  sourceTable?: string;
  sourceId?: string;
  transactionGroupId: string;
  ledgerScope?: 'wallet' | 'platform' | 'bridge';
  linkedParty?: string;
  referenceId?: string;
}

export interface ApprovalLedgerInput {
  userId: string;
  amount: number;
  direction: 'cash_in' | 'cash_out';
  category: string;
  description: string;
  sourceTable?: string;
  sourceId?: string;
  transactionGroupId?: string;
  linkedParty?: string;
  referenceId?: string;
  account?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ── Utility Functions ─────────────────────────────────────────────────

export function validateUUID(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  if (!UUID_REGEX.test(cleaned)) return null;
  return cleaned;
}

export function validatePhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  if (cleaned.length < 7 || cleaned.length > 20) return null;
  if (!/^[0-9+\-\s()]+$/.test(cleaned)) return null;
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return null;
  return cleaned;
}

export function validateAmount(value: unknown, max: number = MAX_TRANSFER_AMOUNT): number | null {
  let num = value;
  if (typeof num === 'string') {
    const parsed = parseFloat(num);
    if (isNaN(parsed)) return null;
    num = parsed;
  }
  if (typeof num !== 'number') return null;
  if (!Number.isFinite(num)) return null;
  if (num <= 0) return null;
  if (num > max) return null;
  return Math.round(num);
}

export function normalizePhone(phone: string): string[] {
  const digits = phone.replace(/\D/g, '');
  const last9 = digits.slice(-9);
  return [`0${last9}`, `+256${last9}`, `256${last9}`];
}

export function generateReferenceId(prefix: string = 'WRF'): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const seq = String(Math.floor(1000 + Math.random() * 9000));
  return `${prefix}${yy}${mm}${dd}${seq}`;
}

// ── Service ───────────────────────────────────────────────────────────

export const TransactionService = {
  // ─── Phase 1 methods (unchanged) ────────────────────────────────

  validateRequest(request: TransactionRequest): ValidationResult {
    const errors: string[] = [];
    if (!request.fromAccountId) errors.push('Source account is required');
    if (!request.toAccountId) errors.push('Destination account is required');
    if (request.fromAccountId === request.toAccountId) {
      errors.push('Source and destination accounts must differ');
    }
    if (!request.amount || request.amount <= 0) {
      errors.push('Amount must be a positive number');
    }
    if (!request.currency) errors.push('Currency is required');
    if (!request.description) errors.push('Description is required');
    return { valid: errors.length === 0, errors };
  },

  buildLedgerEntries(transactionId: string, request: TransactionRequest): LedgerEntry[] {
    return [
      {
        transactionId,
        accountId: request.fromAccountId,
        entryType: 'debit',
        amount: request.amount,
        currency: request.currency,
        description: request.description,
      },
      {
        transactionId,
        accountId: request.toAccountId,
        entryType: 'credit',
        amount: request.amount,
        currency: request.currency,
        description: request.description,
      },
    ];
  },

  buildReversalEntries(
    reversalTransactionId: string,
    originalEntries: LedgerEntry[],
    reason: string
  ): LedgerEntry[] {
    return originalEntries.map((entry) => ({
      transactionId: reversalTransactionId,
      accountId: entry.accountId,
      entryType: entry.entryType === 'debit' ? 'credit' as const : 'debit' as const,
      amount: entry.amount,
      currency: entry.currency,
      description: `REVERSAL: ${reason} (orig: ${entry.transactionId})`,
    }));
  },

  // ─── Phase 2: Shadow methods (wallet-transfer) ─────────────────

  /**
   * Mirrors: wallet-transfer edge function validation
   * Amount range 1–100M, self-transfer check, UUID/phone resolution
   */
  validateWalletTransfer(request: WalletTransferRequest): ValidationResult {
    const errors: string[] = [];

    const amount = validateAmount(request.amount);
    if (amount === null) {
      errors.push('Amount must be between 1 and 100,000,000');
    }

    if (!request.recipientId && !request.recipientPhone) {
      errors.push('Either recipient ID or phone is required');
    }

    if (request.recipientId && !UUID_REGEX.test(request.recipientId)) {
      errors.push('Invalid recipient ID format');
    }

    if (request.recipientPhone) {
      const cleaned = request.recipientPhone.replace(/\D/g, '');
      if (cleaned.slice(-9).length < 9) {
        errors.push('Invalid phone number');
      }
    }

    if (request.recipientId && request.senderId === request.recipientId) {
      errors.push('Cannot transfer to yourself');
    }

    return { valid: errors.length === 0, errors };
  },

  /**
   * Mirrors: wallet-transfer general_ledger insert (paired in/out entries)
   */
  buildTransferLedgerEntries(
    senderId: string,
    recipientId: string,
    amount: number,
    description: string,
    transactionGroupId: string
  ): GeneralLedgerShape[] {
    const safeDesc = typeof description === 'string' ? description.trim().slice(0, 500) : 'Wallet transfer';
    return [
      {
        userId: senderId,
        amount,
        direction: 'cash_out',
        category: 'wallet_transfer',
        description: `Transfer to user: ${safeDesc}`,
        sourceTable: 'wallet_transactions',
        transactionGroupId,
        referenceId: transactionGroupId,
      },
      {
        userId: recipientId,
        amount,
        direction: 'cash_in',
        category: 'wallet_transfer',
        description: `Transfer from user: ${safeDesc}`,
        sourceTable: 'wallet_transactions',
        transactionGroupId,
        referenceId: transactionGroupId,
      },
    ];
  },

  // ─── Phase 2: Shadow methods (agent-deposit) ───────────────────

  /**
   * Mirrors: agent-deposit edge function validation
   */
  validateAgentDeposit(request: AgentDepositRequest): ValidationResult {
    const errors: string[] = [];

    if (!request.userId && !request.userPhone) {
      errors.push('Either user_id or user_phone is required');
    }

    if (request.userId && !validateUUID(request.userId)) {
      errors.push('Invalid user ID format');
    }

    if (request.userPhone && !validatePhone(request.userPhone)) {
      errors.push('Invalid phone number format');
    }

    const amount = validateAmount(request.amount);
    if (amount === null) {
      errors.push('Invalid amount. Must be a positive number up to 100,000,000');
    }

    return { valid: errors.length === 0, errors };
  },

  /**
   * Mirrors: agent-deposit 5% commission split logic
   * Pure calculation — no side effects.
   */
  calculateRepaymentSplit(depositAmount: number, remainingBalance: number): RepaymentSplit {
    const repaymentAmount = Math.min(depositAmount, remainingBalance);
    const commission = Math.round(repaymentAmount * AGENT_COMMISSION_RATE);
    const landlordPayment = repaymentAmount - commission;
    const remainingDeposit = depositAmount - repaymentAmount;

    return { repaymentAmount, commission, landlordPayment, remainingDeposit };
  },

  /**
   * Mirrors: agent-deposit general_ledger entries
   * Agent debit (rent_payment_for_tenant) + tenant credit (rent_repayment)
   */
  buildDepositLedgerEntries(
    agentId: string,
    tenantId: string,
    amount: number,
    repaymentAmount: number,
    transactionGroupId: string,
    rentRequestId?: string
  ): GeneralLedgerShape[] {
    const entries: GeneralLedgerShape[] = [
      {
        userId: agentId,
        amount,
        direction: 'cash_out',
        category: 'rent_payment_for_tenant',
        description: `Agent paid UGX ${amount.toLocaleString()} for tenant`,
        sourceTable: 'wallet_deposits',
        linkedParty: tenantId,
        transactionGroupId,
      },
    ];

    if (repaymentAmount > 0) {
      entries.push({
        userId: tenantId,
        amount: repaymentAmount,
        direction: 'cash_in',
        category: 'rent_repayment',
        description: `Rent repayment via agent (UGX ${repaymentAmount.toLocaleString()})`,
        sourceTable: 'repayments',
        sourceId: rentRequestId,
        linkedParty: agentId,
        transactionGroupId,
      });
    }

    return entries;
  },

  // ─── Phase 2: Shadow methods (fund-rent-pool) ──────────────────

  /**
   * Mirrors: fund-rent-pool edge function validation
   * Supporter role required, positive amount, wallet balance check
   */
  validatePoolFunding(request: PoolFundingRequest): ValidationResult {
    const errors: string[] = [];

    if (!request.roles.includes('supporter')) {
      errors.push('Only supporter accounts can fund rent requests');
    }

    if (!request.amount || request.amount <= 0) {
      errors.push('Invalid amount');
    }

    return { valid: errors.length === 0, errors };
  },

  /**
   * Mirrors: fund-rent-pool general_ledger insert + reference ID generation
   */
  buildPoolFundingEntries(
    userId: string,
    amount: number,
    summaryId: string | undefined,
    payoutDay: number,
    firstPayoutDate: string,
    transactionGroupId: string
  ): { entry: GeneralLedgerShape; referenceId: string } {
    const referenceId = generateReferenceId('WRF');
    return {
      referenceId,
      entry: {
        userId,
        amount,
        direction: 'cash_out',
        category: 'supporter_rent_fund',
        description: `Supporter rent funding: UGX ${amount.toLocaleString()} to Rent Management Pool. Payout day: ${payoutDay}th. First payout: ${firstPayoutDate}`,
        sourceTable: 'opportunity_summaries',
        sourceId: summaryId,
        referenceId,
        linkedParty: 'Rent Management Pool',
        transactionGroupId,
      },
    };
  },

  // ─── Phase 2: Shadow methods (cfo-direct-credit) ───────────────

  /**
   * Mirrors: cfo-direct-credit edge function validation
   * CFO/manager/super_admin roles, amount 1–50M, reason ≥ 10 chars
   */
  validateCfoAdjustment(request: CfoAdjustmentRequest): ValidationResult {
    const errors: string[] = [];

    const allowedRoles = ['cfo', 'manager', 'super_admin'];
    if (!request.operatorRoles.some((r) => allowedRoles.includes(r))) {
      errors.push('Insufficient permissions');
    }

    if (!request.targetUserId || typeof request.targetUserId !== 'string') {
      errors.push('Invalid target user');
    }

    if (!request.amount || typeof request.amount !== 'number' || request.amount <= 0 || request.amount > MAX_CFO_AMOUNT) {
      errors.push('Invalid amount (1 - 50,000,000)');
    }

    if (!request.reason || typeof request.reason !== 'string' || request.reason.length < 10) {
      errors.push('Reason must be at least 10 characters');
    }

    return { valid: errors.length === 0, errors };
  },

  /**
   * Mirrors: cfo-direct-credit dual ledger entries with ledger_scope
   * Credit: bridge (user) + platform (debit)
   * Debit: bridge (user) + platform (credit)
   */
  buildCfoAdjustmentEntries(
    targetUserId: string,
    targetName: string,
    amount: number,
    reason: string,
    operation: 'credit' | 'debit',
    transactionGroupId: string
  ): GeneralLedgerShape[] {
    if (operation === 'credit') {
      return [
        {
          userId: targetUserId,
          amount,
          direction: 'cash_in',
          category: 'cfo_direct_credit',
          description: `CFO Credit: ${reason}`,
          transactionGroupId,
          ledgerScope: 'bridge',
        },
        {
          userId: null,
          amount,
          direction: 'cash_out',
          category: 'platform_expense',
          description: `Platform → ${targetName}: ${reason}`,
          transactionGroupId,
          ledgerScope: 'platform',
        },
      ];
    } else {
      return [
        {
          userId: targetUserId,
          amount,
          direction: 'cash_out',
          category: 'cfo_direct_debit',
          description: `CFO Debit: ${reason}`,
          transactionGroupId,
          ledgerScope: 'bridge',
        },
        {
          userId: null,
          amount,
          direction: 'cash_in',
          category: 'platform_income',
          description: `${targetName} → Platform: ${reason}`,
          transactionGroupId,
          ledgerScope: 'platform',
        },
      ];
    }
  },

  // ─── Phase 2: Shadow methods (approve-wallet-operation) ────────

  /**
   * Mirrors: approve-wallet-operation ledger insert for approved operations
   * Converts a pending_wallet_operations row into a general_ledger entry
   */
  buildApprovalLedgerEntry(input: ApprovalLedgerInput): GeneralLedgerShape {
    return {
      userId: input.userId,
      amount: input.amount,
      direction: input.direction,
      category: input.category,
      description: input.description,
      sourceTable: input.sourceTable,
      sourceId: input.sourceId,
      transactionGroupId: input.transactionGroupId || crypto.randomUUID(),
      linkedParty: input.linkedParty,
      referenceId: input.referenceId,
    };
  },
};
