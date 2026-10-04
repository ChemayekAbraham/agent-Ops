export const SHOPPING_ADVANCE_BASE_LIMIT = 30_000;
export const SHOPPING_ADVANCE_LIMIT_CAP = 30_000_000;

export function shoppingAdvanceAccessLimit(receivedTransferTotal: number): number {
  const received = Number.isFinite(receivedTransferTotal) ? Math.max(0, receivedTransferTotal) : 0;
  return Math.min(SHOPPING_ADVANCE_LIMIT_CAP, SHOPPING_ADVANCE_BASE_LIMIT + received * 2);
}

export function maskSensitiveValue(value: string | null | undefined): string {
  const clean = value?.trim();
  if (!clean) return '—';
  if (clean.includes('@')) {
    const [name, domain] = clean.split('@');
    return `${name?.slice(0, 2) || '••'}•••@${domain || '•••'}`;
  }
  const compact = clean.replace(/\s/g, '');
  if (compact.length <= 4) return '••••';
  return `${compact.slice(0, 2)}••••${compact.slice(-3)}`;
}

export function maskMoney(revealed: boolean, formatted: string): string {
  return revealed ? formatted : 'UGX ••••••';
}
