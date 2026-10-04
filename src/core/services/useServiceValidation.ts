/**
 * useServiceValidation — Phase 4
 * 
 * Conditionally runs new service layer validation before edge function calls.
 * When `useNewServices` flag is OFF (default), every method returns { shouldProceed: true }.
 * When ON, runs TransactionService / WalletService validation for fail-fast feedback.
 * 
 * Safety: if validation throws, fallback is always shouldProceed: true.
 * Edge functions remain the sole authority for executing transactions.
 */

import { useFeatureFlags } from '@/contexts/FeatureFlagsContext';
import { TransactionService, type WalletTransferRequest, type ValidationResult } from './transactionService';
import { WalletService } from './walletService';

export interface PreValidationResult {
  shouldProceed: boolean;
  errors?: string[];
}

const PASS: PreValidationResult = { shouldProceed: true };

export function useServiceValidation() {
  const { flags } = useFeatureFlags();
  const enabled = flags.useNewServices;

  const preValidateTransfer = (request: WalletTransferRequest): PreValidationResult => {
    if (!enabled) return PASS;
    try {
      const result: ValidationResult = TransactionService.validateWalletTransfer(request);
      if (!result.valid) {
        return { shouldProceed: false, errors: result.errors };
      }
      return PASS;
    } catch {
      return PASS; // Safe fallback — never block on service error
    }
  };

  const checkBalance = (currentBalance: number, amount: number): PreValidationResult => {
    if (!enabled) return PASS;
    try {
      const result = WalletService.validateSufficientBalance(currentBalance, amount);
      if (!result.valid) {
        return {
          shouldProceed: false,
          errors: [`Insufficient balance. You need ${result.shortfall.toLocaleString()} more.`],
        };
      }
      return PASS;
    } catch {
      return PASS;
    }
  };

  return { preValidateTransfer, checkBalance, enabled };
}
