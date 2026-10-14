import { formatUGX } from '@/lib/rentCalculations';

export type RdCashField = 'customers' | 'cashIn' | 'cashOut';
export interface RdProjectCashRow {
  id: string; customers: number; cashIn: number; cashOut: number;
}

export function rdProjectCashValue(rows: RdProjectCashRow[], id: string, field: RdCashField): string {
  const row = rows.find((r) => r.id === id);
  if (!row) return '—';
  return field === 'customers' ? row.customers.toLocaleString('en-US') : formatUGX(row[field]);
}