/**
 * Returns a semantic CSS class for wallet balance traffic-light coloring.
 * 🟢 Green: >= UGX 50,000
 * 🟡 Yellow/Warning: 1 - 49,999
 * 🔴 Red: 0
 */
export function getBalanceColorClass(balance: number): string {
  if (balance >= 50000) return 'text-success';
  if (balance > 0) return 'text-warning';
  return 'text-destructive';
}

export function getBalanceGlowClass(balance: number): string {
  if (balance >= 50000) return 'shadow-success/20';
  if (balance > 0) return 'shadow-warning/20';
  return 'shadow-destructive/20';
}

export function getBalanceDotClass(balance: number): string {
  if (balance >= 50000) return 'bg-success';
  if (balance > 0) return 'bg-warning';
  return 'bg-destructive';
}

/**
 * Formats "last synced" time for display.
 */
export function formatSyncTime(date: Date | null): string {
  if (!date) return 'syncing...';
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  return `${Math.floor(diffMin / 60)}h ago`;
}
