export interface TppoZoneAReport {
  period_start: string | null;
  period_end: string | null;
  granularity: string | null;
  status: string | null;
  report_id: string | null;
  collected_ugx: number | null;
  scheduled_due_ugx: number | null;
  collection_rate_pct: number | null;
  threshold_pct: number | null;
  below_threshold: boolean | null;
  provisional: boolean | null;
  rate_variance_pp: number | null;
  collected_delta_ugx: number | null;
  scheduled_delta_ugx: number | null;
  prior: {
    period_start: string | null;
    period_end: string | null;
    collected_ugx: number | null;
    scheduled_due_ugx: number | null;
    collection_rate_pct: number | null;
  } | null;
}
