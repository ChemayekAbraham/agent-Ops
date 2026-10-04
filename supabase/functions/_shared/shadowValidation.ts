/**
 * Shadow Validation — Phase 3 Dual Execution
 * 
 * Pure validation functions mirroring edge function business rules.
 * These are standalone (no DB, no Supabase client) and used only
 * for shadow audit comparison against primary validation paths.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TRANSFER_AMOUNT = 100_000_000;
const MAX_CFO_AMOUNT = 50_000_000;

export interface ShadowValidationResult {
  valid: boolean;
  errors: string[];
}

// ── wallet-transfer ──────────────────────────────────────────────

export interface ShadowWalletTransferInput {
  senderId: string;
  recipientId: string;
  amount: number;
  description?: string;
}

export function shadowValidateWalletTransfer(input: ShadowWalletTransferInput): ShadowValidationResult {
  const errors: string[] = [];

  if (!input.recipientId || !UUID_REGEX.test(input.recipientId)) {
    errors.push('Invalid recipient UUID');
  }

  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount <= 0 || input.amount > MAX_TRANSFER_AMOUNT) {
    errors.push(`Amount must be between 1 and ${MAX_TRANSFER_AMOUNT.toLocaleString()}`);
  }

  if (input.senderId === input.recipientId) {
    errors.push('Cannot transfer to yourself');
  }

  return { valid: errors.length === 0, errors };
}

// ── cfo-direct-credit ────────────────────────────────────────────

export interface ShadowCfoAdjustmentInput {
  targetUserId: string;
  amount: number;
  reason: string;
  operation: string;
  callerRoles: string[];
}

export function shadowValidateCfoAdjustment(input: ShadowCfoAdjustmentInput): ShadowValidationResult {
  const errors: string[] = [];

  const allowedRoles = ['cfo', 'manager', 'super_admin'];
  const hasPermission = input.callerRoles.some(r => allowedRoles.includes(r));
  if (!hasPermission) {
    errors.push('Insufficient permissions');
  }

  if (!input.targetUserId || typeof input.targetUserId !== 'string') {
    errors.push('Invalid target user');
  }

  if (!input.amount || typeof input.amount !== 'number' || input.amount <= 0 || input.amount > MAX_CFO_AMOUNT) {
    errors.push(`Invalid amount (1 - ${MAX_CFO_AMOUNT.toLocaleString()})`);
  }

  if (!input.reason || typeof input.reason !== 'string' || input.reason.length < 10) {
    errors.push('Reason must be at least 10 characters');
  }

  return { valid: errors.length === 0, errors };
}

// ── fund-rent-pool ───────────────────────────────────────────────

export interface ShadowPoolFundingInput {
  amount: number;
  callerRoles: string[];
}

export function shadowValidatePoolFunding(input: ShadowPoolFundingInput): ShadowValidationResult {
  const errors: string[] = [];

  if (!input.callerRoles.includes('supporter')) {
    errors.push('Only supporter accounts can fund rent requests');
  }

  if (!input.amount || input.amount <= 0) {
    errors.push('Invalid amount');
  }

  return { valid: errors.length === 0, errors };
}
