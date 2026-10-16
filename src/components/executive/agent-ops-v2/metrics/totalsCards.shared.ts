import type { useMetricsTotals } from '@/hooks/useAgentOpsMetrics';
import type { CardControls } from './MetricsShared';

export type TotalsState = ReturnType<typeof useMetricsTotals>;
export interface TotalsCardProps {
  controls: CardControls;
  totals: TotalsState;
  from: string;
  to: string;
}
export const FALLBACK_BASIS = 'Kampala days; figures as the server returns them.';
