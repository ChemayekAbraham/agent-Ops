type CustomerWalletLedgerRow = {
  classification?: string | null;
  category?: string | null;
  source_table?: string | null;
  description?: string | null;
  reference_id?: string | null;
};

const INTERNAL_CATEGORIES = [
  'system_balance_correction',
  'admin_balance_correction',
  'administrative_balance_correction',
  'reconciliation_adjustment',
  'migration_adjustment',
  'rollback_correction',
  'backfill_correction',
  'wallet_projection_reversed_bonus_exclusion',
];

const INTERNAL_SOURCE_TABLES = new Set([
  'commission_engine_reversal',
  'wallet_projection_reversed_bonus_exclusion',
  'wallet_reconciliation',
  'admin_wallet_reconciliation',
  'migration',
  'migration_backfill',
  'backfill',
  'rollback',
  'admin_correction',
]);

const INTERNAL_DESCRIPTION_FRAGMENTS = [
  'internal accounting adjustment',
  'accounting adjustment',
  'reconciliation entry',
  'reconciliation adjustment',
  'migration entry',
  'migration adjustment',
  'rollback entry',
  'rollback correction',
  'backfill correction',
  'administrative balance correction',
  'admin balance correction',
  'balance correction',
  'reversal: erroneous',
];

const INTERNAL_REFERENCE_PREFIX = /^(ADMIN|ADJ|CORR|RECON|MIG|ROLLBACK|BACKFILL|WDR2FLT)-/i;

export function isCustomerWalletLedgerEntryVisible(row: CustomerWalletLedgerRow): boolean {
  const classification = (row.classification || '').toLowerCase();
  const category = (row.category || '').toLowerCase();
  const sourceTable = (row.source_table || '').toLowerCase();
  const description = (row.description || '').toLowerCase();
  const referenceId = row.reference_id || '';

  if (classification === 'admin_correction') return false;
  if (INTERNAL_CATEGORIES.includes(category)) return false;
  if (INTERNAL_SOURCE_TABLES.has(sourceTable)) return false;
  if (INTERNAL_DESCRIPTION_FRAGMENTS.some((fragment) => description.includes(fragment))) return false;
  if (description.includes('erroneous') && description.includes('backfill')) return false;
  if (INTERNAL_REFERENCE_PREFIX.test(referenceId)) return false;

  return true;
}

export function applyCustomerWalletLedgerFilters(query: any): any {
  return query
    .neq('classification', 'admin_correction')
    .not('category', 'in', `(${INTERNAL_CATEGORIES.join(',')})`);
}