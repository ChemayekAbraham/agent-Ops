/**
 * HR data access — Metrics (hr_metric_definitions, hr_metric_snapshots)
 */
import type { MetricDefinition, MetricSnapshot, PerformanceFlag } from '../types';
import { supabase, unwrap } from './client';

type DefinitionRow = {
  id: string;
  department_id: string | null;
  key: string;
  name: string;
  description: string | null;
  unit: string;
  direction: string;
  measurement_mode: string;
  target_value: number | null;
  amber_at: number | null;
  red_at: number | null;
  version: number;
  active: boolean;
  created_at: string;
};

type SnapshotRow = {
  id: string;
  staff_id: string | null;
  department_id: string | null;
  metric_key: string;
  metric_version: number;
  period_start: string;
  period_end: string;
  value: number | null;
  subject_kind: string;
  computed_at: string;
  inputs_snapshot: Record<string, number | string>;
  locked: boolean;
};

function mapDefinition(row: DefinitionRow): MetricDefinition {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description ?? '',
    department_id: row.department_id,
    unit: row.unit as MetricDefinition['unit'],
    direction: row.direction as MetricDefinition['direction'],
    target_value: row.target_value,
    amber_at: row.amber_at,
    red_at: row.red_at,
    target_basis: 'target',
    period_type: 'monthly',
    source: row.measurement_mode === 'output' ? 'derived_task' : 'manual_entry',
    source_key: 'manual',
    version: row.version,
    active: row.active,
    created_at: row.created_at,
    created_by_employee_id: '',
  };
}

export async function getMetricDefinitions(
  departmentId?: string,
): Promise<MetricDefinition[]> {
  let query = supabase
    .from('hr_metric_definitions')
    .select(
      'id, department_id, key, name, description, unit, direction, measurement_mode, target_value, amber_at, red_at, version, active, created_at',
    )
    .eq('active', true)
    .order('display_order', { ascending: true, nullsFirst: true })
    .order('name', { ascending: true });
  if (departmentId) {
    // null department_id means universal — always included.
    query = query.or(`department_id.is.null,department_id.eq.${departmentId}`);
  }
  const rows = unwrap(await query) as unknown as DefinitionRow[];
  return rows.map(mapDefinition);
}

async function definitionIdByKey(): Promise<Record<string, string>> {
  const rows = unwrap(
    await supabase.from('hr_metric_definitions').select('id, key'),
  ) as { id: string; key: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.id]));
}

export async function getMetricSnapshots(params: {
  subjectType: 'employee' | 'department';
  subjectId: string;
  periodStart?: string;
  periodEnd?: string;
}): Promise<MetricSnapshot[]> {
  let query = supabase
    .from('hr_metric_snapshots')
    .select(
      'id, staff_id, department_id, metric_key, metric_version, period_start, period_end, value, subject_kind, computed_at, inputs_snapshot, locked',
    )
    .order('period_start', { ascending: true });

  if (params.subjectType === 'employee') query = query.eq('staff_id', params.subjectId);
  else query = query.eq('department_id', params.subjectId);
  if (params.periodStart) query = query.gte('period_start', params.periodStart);
  if (params.periodEnd) query = query.lte('period_end', params.periodEnd);

  const rows = unwrap(await query) as unknown as SnapshotRow[];
  const idByKey = await definitionIdByKey();

  return rows.map((row) => ({
    id: row.id,
    metric_definition_id: idByKey[row.metric_key] ?? row.metric_key,
    metric_definition_version: row.metric_version,
    subject_type: row.subject_kind === 'org' ? 'org' : params.subjectType,
    subject_id:
      row.subject_kind === 'staff'
        ? row.staff_id
        : row.subject_kind === 'department'
          ? row.department_id
          : row.subject_kind === 'org'
            ? null
            : row.staff_id,
    assignment_id: null,
    period_type: 'monthly',
    period_start: row.period_start,
    period_end: row.period_end,
    value: row.value === null || row.value === undefined ? null : Number(row.value),
    target_value: null,
    attainment_pct: null,
    status: row.locked ? 'locked' : 'open',
    computed_at: row.computed_at,
    inputs_snapshot: row.inputs_snapshot ?? {},
    supersedes_snapshot_id: null,
    correction_reason: null,
  }));
}

/** Direct snapshot read for a period, across subjects. */
export async function getSnapshots(params: {
  periodStart?: string;
  periodEnd?: string;
  staffId?: string;
  departmentId?: string;
  metricKey?: string;
} = {}): Promise<MetricSnapshot[]> {
  let query = supabase
    .from('hr_metric_snapshots')
    .select(
      'id, staff_id, department_id, metric_key, metric_version, period_start, period_end, value, subject_kind, computed_at, inputs_snapshot, locked',
    )
    .order('period_start', { ascending: true });
  if (params.periodStart) query = query.gte('period_start', params.periodStart);
  if (params.periodEnd) query = query.lte('period_end', params.periodEnd);
  if (params.staffId) query = query.eq('staff_id', params.staffId);
  if (params.departmentId) query = query.eq('department_id', params.departmentId);
  if (params.metricKey) query = query.eq('metric_key', params.metricKey);

  const rows = unwrap(await query) as unknown as SnapshotRow[];
  const idByKey = await definitionIdByKey();

  return rows.map((row) => ({
    id: row.id,
    metric_definition_id: idByKey[row.metric_key] ?? row.metric_key,
    metric_definition_version: row.metric_version,
    subject_type:
      row.subject_kind === 'staff'
        ? 'employee'
        : row.subject_kind === 'department'
          ? 'department'
          : row.subject_kind === 'org'
            ? 'org'
            : 'employee',
    subject_id:
      row.subject_kind === 'staff'
        ? row.staff_id
        : row.subject_kind === 'department'
          ? row.department_id
          : row.subject_kind === 'org'
            ? null
            : row.staff_id,
    assignment_id: null,
    period_type: 'monthly',
    period_start: row.period_start,
    period_end: row.period_end,
    value: row.value === null || row.value === undefined ? null : Number(row.value),
    target_value: null,
    attainment_pct: null,
    status: row.locked ? 'locked' : 'open',
    computed_at: row.computed_at,
    inputs_snapshot: row.inputs_snapshot ?? {},
    supersedes_snapshot_id: null,
    correction_reason: null,
  }));
}

/** Runs the database computation for the period. Returns rows written. */
export async function computeSnapshots(
  periodStart: string,
  periodEnd: string,
): Promise<number> {
  const { data, error } = await supabase.rpc('hr_compute_snapshots' as never, {
    _period_start: periodStart,
    _period_end: periodEnd,
  } as never);
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

/**
 * No performance-flag table exists yet. Returns an empty list rather than a
 * mock so no screen ever shows invented data.
 */
export async function getPerformanceFlags(_params: {
  subjectType?: 'employee' | 'department';
  subjectId?: string;
}): Promise<PerformanceFlag[]> {
  return [];
}
