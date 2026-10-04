/**
 * HR data contracts — Shared UI shapes
 * Part of the HR module contract. Do not add, rename or remove fields.
 */
import type {
  MetricDirection,
  MetricPeriodType,
  MetricUnit,
  SnapshotStatus,
} from './metrics';

export interface PeriodRef {
  period_type: MetricPeriodType;
  period_start: string;
  period_end: string;
  label: string;                     // "Week 30, 2026" / "July 2026"
}

export interface ScorecardRow {
  metric_definition_id: string;
  metric_name: string;
  unit: MetricUnit;
  direction: MetricDirection;
  value: number;
  target_value: number | null;
  attainment_pct: number | null;
  trend_vs_previous: number | null;  // percentage point change
  snapshot_status: SnapshotStatus;
}
