/**
 * HR Payroll period and run data access (hr_pay_periods, hr_pay_runs,
 * hr_pay_run_events, hr_pay_rule_versions).
 *
 * Run status is NEVER written from this file. `hr_pay_runs.status` is
 * maintained by a database trigger on `hr_pay_run_events` — the only way to
 * move a run forward is to record an event.
 */
import { supabase, unwrap } from '../../api/client';

export interface PayPeriodRow {
  id: string;
  code: string;
  period_month: string;
  cut_off_date: string;
  pay_date: string;
  status: string;
  created_at: string;
}

export interface PayRuleVersionOption {
  id: string;
  code: string;
  effective_from: string;
  verified_at: string | null;
}

export interface PayRunRow {
  id: string;
  period_id: string;
  run_type: string;
  rule_version_id: string | null;
  rule_status_at_run: string | null;
  status: string;
  prepared_at: string | null;
  total_net: number | null;
  created_at: string;
  period_code: string | null;
  rule_version_code: string | null;
  /** Position title currently holding the run, derived from status. Null when locked. */
  holding_position_title: string | null;
  /** Timestamp of the most recent hr_pay_run_events row for this run. */
  last_event_at: string | null;
}

/** Which authority function holds a run at each status. Locked runs are with nobody. */
const STATUS_FUNCTION: Record<string, 'prepare' | 'approve' | 'release'> = {
  draft: 'prepare',
  calculated: 'prepare',
  returned: 'prepare',
  in_review: 'approve',
  approved: 'release',
  paid: 'release',
};

async function loadAuthorityTitles(): Promise<Record<string, string>> {
  const res = await supabase
    .from('hr_pay_authorities')
    .select('function_code, hr_positions(title)')
    .is('effective_to', null);
  const rows = (unwrap(res) ?? []) as Array<{
    function_code: string;
    hr_positions?: { title: string } | null;
  }>;
  const map: Record<string, string> = {};
  for (const row of rows) {
    if (row.hr_positions?.title) map[row.function_code] = row.hr_positions.title;
  }
  return map;
}

async function loadLastEventAt(runIds: string[]): Promise<Record<string, string>> {
  if (runIds.length === 0) return {};
  const res = await supabase
    .from('hr_pay_run_events')
    .select('run_id, created_at')
    .in('run_id', runIds)
    .order('created_at', { ascending: false });
  const rows = (unwrap(res) ?? []) as Array<{ run_id: string; created_at: string }>;
  const map: Record<string, string> = {};
  for (const row of rows) {
    if (!map[row.run_id]) map[row.run_id] = row.created_at;
  }
  return map;
}

export async function listPeriods(): Promise<PayPeriodRow[]> {
  const res = await supabase
    .from('hr_pay_periods')
    .select('id, code, period_month, cut_off_date, pay_date, status, created_at')
    .order('period_month', { ascending: false });
  return (unwrap(res) ?? []) as PayPeriodRow[];
}

export async function createPeriod(input: {
  code: string;
  periodMonth: string;
  cutOffDate: string;
  payDate: string;
}): Promise<PayPeriodRow> {
  const res = await supabase
    .from('hr_pay_periods')
    .insert({
      code: input.code,
      period_month: input.periodMonth,
      cut_off_date: input.cutOffDate,
      pay_date: input.payDate,
    })
    .select('id, code, period_month, cut_off_date, pay_date, status, created_at')
    .single();
  return unwrap(res) as PayPeriodRow;
}

export async function closePeriod(id: string): Promise<void> {
  const res = await supabase
    .from('hr_pay_periods')
    .update({ status: 'closed' })
    .eq('id', id)
    .select('id')
    .single();
  unwrap(res);
}

export async function listRuns(): Promise<PayRunRow[]> {
  const res = await supabase
    .from('hr_pay_runs')
    .select(
      'id, period_id, run_type, rule_version_id, rule_status_at_run, status, prepared_at, total_net, created_at, hr_pay_periods(code), hr_pay_rule_versions(code)',
    )
    .order('created_at', { ascending: false });
  const rows = (unwrap(res) ?? []) as Array<
    Record<string, unknown> & {
      hr_pay_periods?: { code: string } | null;
      hr_pay_rule_versions?: { code: string } | null;
    }
  >;
  const ids = rows.map((row) => row.id as string);
  const [titles, lastEvents] = await Promise.all([loadAuthorityTitles(), loadLastEventAt(ids)]);
  return rows.map((row) => {
    const status = row.status as string;
    const fn = STATUS_FUNCTION[status];
    return {
    id: row.id as string,
    period_id: row.period_id as string,
    run_type: row.run_type as string,
    rule_version_id: (row.rule_version_id as string | null) ?? null,
    rule_status_at_run: (row.rule_status_at_run as string | null) ?? null,
    status,
    prepared_at: (row.prepared_at as string | null) ?? null,
    total_net: (row.total_net as number | null) ?? null,
    created_at: row.created_at as string,
    period_code: row.hr_pay_periods?.code ?? null,
    rule_version_code: row.hr_pay_rule_versions?.code ?? null,
    holding_position_title: fn ? titles[fn] ?? null : null,
    last_event_at: lastEvents[row.id as string] ?? null,
    };
  });
}

export async function listRuleVersions(): Promise<PayRuleVersionOption[]> {
  const res = await supabase
    .from('hr_pay_rule_versions')
    .select('id, code, effective_from, verified_at')
    .order('effective_from', { ascending: false });
  return (unwrap(res) ?? []) as PayRuleVersionOption[];
}

export async function createRun(input: {
  periodId: string;
  runType: string;
  ruleVersionId: string;
  note: string;
}): Promise<PayRunRow> {
  const versions = await listRuleVersions();
  const version = versions.find((v) => v.id === input.ruleVersionId) ?? null;

  const insert = await supabase
    .from('hr_pay_runs')
    .insert({
      period_id: input.periodId,
      run_type: input.runType,
      rule_version_id: input.ruleVersionId,
      rule_status_at_run: version && version.verified_at ? 'verified' : 'provisional',
    })
    .select(
      'id, period_id, run_type, rule_version_id, rule_status_at_run, status, prepared_at, total_net, created_at',
    )
    .single();
  const run = unwrap(insert) as Omit<PayRunRow, 'period_code' | 'rule_version_code'>;

  const event = await supabase
    .from('hr_pay_run_events')
    .insert({ run_id: run.id, event_type: 'created', note: input.note })
    .select('id')
    .single();
  unwrap(event);

  return {
    ...run,
    period_code: null,
    rule_version_code: version?.code ?? null,
    holding_position_title: null,
    last_event_at: null,
  };
}