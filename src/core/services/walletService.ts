/**
 * Wallet Service (Phase 2 — Shadow Mode, Read-Only)
 * 
 * Provides read-only wallet/balance computation from ledger entries
 * plus shadow methods mirroring production balance-check logic.
 * Balances are NEVER stored directly — always derived from the ledger.
 * 
 * NOT connected to any data source. Future phases will wire this
 * behind feature flags.
 */

import type { LedgerEntry } from './transactionService';

// ── Types ─────────────────────────────────────────────────────────────

export interface WalletBalance {
  accountId: string;
  currency: string;
  balance: number;
  lastEntryAt: string | null;
}

export interface WalletSummary {
  accountId: string;
  balances: WalletBalance[];
  totalCredits: number;
  totalDebits: number;
}

/** Phase 2: Detailed balance validation result */
export interface BalanceValidation {
  valid: boolean;
  currentBalance: number;
  requestedAmount: number;
  shortfall: number;
}

/** Phase 2: Optimistic debit result (pure calculation) */
export interface OptimisticDebitResult {
  newBalance: number;
  originalBalance: number;
  amount: number;
  lockCondition: { userId: string; expectedBalance: number };
}

/** Phase 2: Typed representation of ensure-or-create wallet pattern */
export interface WalletExistenceCheck {
  exists: boolean;
  userId: string;
  currentBalance: number;
  requiresCreation: boolean;
}

// ── Service ───────────────────────────────────────────────────────────

export const WalletService = {
  // ─── Phase 1 methods (unchanged) ────────────────────────────────

  computeBalance(accountId: string, entries: LedgerEntry[]): WalletBalance {
    const accountEntries = entries.filter((e) => e.accountId === accountId);

    let balance = 0;
    let lastEntryAt: string | null = null;
    const currency = accountEntries[0]?.currency ?? 'UGX';

    for (const entry of accountEntries) {
      balance += entry.entryType === 'credit' ? entry.amount : -entry.amount;
      if (entry.createdAt && (!lastEntryAt || entry.createdAt > lastEntryAt)) {
        lastEntryAt = entry.createdAt;
      }
    }

    return { accountId, currency, balance, lastEntryAt };
  },

  computeSummary(accountId: string, entries: LedgerEntry[]): WalletSummary {
    const accountEntries = entries.filter((e) => e.accountId === accountId);

    const totalCredits = accountEntries
      .filter((e) => e.entryType === 'credit')
      .reduce((sum, e) => sum + e.amount, 0);

    const totalDebits = accountEntries
      .filter((e) => e.entryType === 'debit')
      .reduce((sum, e) => sum + e.amount, 0);

    const balance = this.computeBalance(accountId, entries);

    return { accountId, balances: [balance], totalCredits, totalDebits };
  },

  hasSufficientBalance(accountId: string, entries: LedgerEntry[], amount: number): boolean {
    const { balance } = this.computeBalance(accountId, entries);
    return balance >= amount;
  },

  // ─── Phase 2: Shadow methods ────────────────────────────────────

  /**
   * Mirrors: balance >= amount check used in wallet-transfer, agent-deposit,
   * fund-rent-pool edge functions.
   * Returns detailed result with shortfall instead of bare boolean.
   */
  validateSufficientBalance(
    currentBalance: number,
    requestedAmount: number
  ): BalanceValidation {
    const shortfall = Math.max(0, requestedAmount - currentBalance);
    return {
      valid: currentBalance >= requestedAmount,
      currentBalance,
      requestedAmount,
      shortfall,
    };
  },

  /**
   * Mirrors: optimistic locking pattern from wallet-transfer/agent-deposit
   * (backend-only) optimistic update: sets new balance = current minus amount,
   * gated by an equality check on the previously-read balance.
   * 
   * Pure calculation — returns the new balance and the lock condition
   * that would be used in the optimistic update query.
   */
  computeOptimisticDebit(
    userId: string,
    currentBalance: number,
    amount: number
  ): OptimisticDebitResult {
    return {
      newBalance: currentBalance - amount,
      originalBalance: currentBalance,
      amount,
      lockCondition: {
        userId,
        expectedBalance: currentBalance,
      },
    };
  },

  /**
   * Mirrors: ensure-wallet-exists pattern from wallet-transfer, agent-deposit,
   * cfo-direct-credit edge functions.
   * Pure type check — does NOT create wallets.
   */
  checkWalletExistence(
    userId: string,
    walletData: { balance: number } | null
  ): WalletExistenceCheck {
    if (walletData) {
      return {
        exists: true,
        userId,
        currentBalance: walletData.balance,
        requiresCreation: false,
      };
    }
    return {
      exists: false,
      userId,
      currentBalance: 0,
      requiresCreation: true,
    };
  },
};
