/**
 * Payroll run workflow (approval chain) and the payroll register document.
 *
 * `hr_pay_runs.status` is NEVER written from this file. A database trigger on
 * `hr_pay_run_events` moves the run forward, so every action here records an
 * event and nothing else.
 */
import { supabase, unwrap } from '../../api/client';

export interface RegisterDoc {
  run_id: string;
  run_reference: string;
  status: string;
  rule_status_at_run: string | null;
  rule_version_code: string | null;
  period_code: string | null;
  pay_date: string | null;
  prepared_at: string | null;
  approved_at: string | null;
  release_armed_at: string | null;
  prepared_position_title: string | null;
  prepared_by_name: string | null;
  approved_position_title: string | null;
  approved_by_name: string | null;
  released_position_title: string | null;
  released_by_name: string | null;
  rows: Array<{
    id: string;
    staff_ref: string | null;
    staff_name: string | null;
    department_name: string;
    gross: number;
    paye: number;
    nssf_employee: number;
    nssf_employer: number;
    lst: number;
    other_deductions: number;
    net: number;
    employer_cost: number;
  }>;
  enrolled_count: number;
  omissions_count: number;
  omissions: Array<{
    staff_id: string;
    staff_ref: string | null;
    staff_name: string | null;
    reason: string;
  }>;
}

async function recordEvent(runId: string, eventType: string, note: string | null): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  const res = await supabase
    .from('hr_pay_run_events')
    .insert({
      run_id: runId,
      event_type: eventType,
      note: note && note.trim() ? note.trim() : null,
      actor: auth?.user?.id ?? null,
    })
    .select('id')
    .single();
  unwrap(res);
}

export async function submitRun(runId: string, note: string): Promise<void> {
  await recordEvent(runId, 'submitted', note);
}

export async function approveRun(runId: string, note: string): Promise<void> {
  await recordEvent(runId, 'approved', note);
}

export async function returnRun(runId: string, reason: string): Promise<void> {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length < 10) {
    throw new Error('A reason of at least 10 characters is required to return a run.');
  }
  await recordEvent(runId, 'returned', trimmed);
}

export async function lockRun(runId: string, note: string): Promise<void> {
  await recordEvent(runId, 'locked', note);
}

export async function cancelRun(runId: string, note: string): Promise<void> {
  const trimmed = (note ?? '').trim();
  if (trimmed.length < 10) {
    throw new Error('A note of at least 10 characters is required to cancel a run.');
  }
  await recordEvent(runId, 'cancelled', trimmed);
}

export async function myApprovals(): Promise<
  Array<{
    item_type: string;
    item_id: string;
    title: string;
    detail: string | null;
    raised_by: string | null;
    raised_at: string | null;
    action_required: string | null;
    route: string | null;
  }>
> {
  const res = await (supabase.rpc as any)('hr_my_approvals');
  return (unwrap(res) ?? []) as any[];
}

export interface RunException {
  severity: string;
  staff_ref: string | null;
  issue: string;
  detail: string | null;
}

/** Pre-run checks for a payroll run, straight from the database. */
export async function listExceptions(runId: string): Promise<RunException[]> {
  const res = await (supabase.rpc as any)('hr_pay_exceptions', { _run_id: runId });
  return (unwrap(res) ?? []) as RunException[];
}

export async function getRegister(runId: string): Promise<RegisterDoc> {
  const run = unwrap(
    await supabase
      .from('hr_pay_runs')
      .select(
        'id, status, rule_status_at_run, prepared_at, prepared_by, prepared_position_id, approved_at, approved_by, approved_position_id, release_armed_at, release_armed_by, hr_pay_periods(code, pay_date, period_month, cut_off_date), hr_pay_rule_versions(code)',
      )
      .eq('id', runId)
      .single(),
  ) as Record<string, any>;

  const slips = (unwrap(
    await supabase
      .from('hr_pay_payslips')
      .select(
        'id, gross, paye, nssf_employee, nssf_employer, lst, other_deductions, net, employer_cost, hr_staff(staff_ref, user_id), hr_departments(name)',
      )
      .eq('run_id', runId)
      .eq('is_current', true),
  ) ?? []) as Array<Record<string, any>>;

  // Every active enrolled staff member, so the register can name anyone the run
  // did not calculate instead of silently omitting them.
  const allStaff = (unwrap(
    await supabase.from('hr_staff').select('id, staff_ref, user_id').eq('active', true),
  ) ?? []) as Array<{ id: string; staff_ref: string | null; user_id: string | null }>;

  const slipStaffRefs = new Set(
    slips.map((s) => (s.hr_staff?.staff_ref as string | undefined) ?? '').filter(Boolean),
  );
  const missingStaff = allStaff.filter((s) => !s.staff_ref || !slipStaffRefs.has(s.staff_ref));

  const periodMonth = (run.hr_pay_periods?.period_month as string | null) ?? null;
  const cutOff = (run.hr_pay_periods?.cut_off_date as string | null) ?? null;

  let compRows: Array<{ staff_id: string; effective_from: string; effective_to: string | null }> = [];
  if (missingStaff.length > 0) {
    compRows = (unwrap(
      await supabase
        .from('hr_pay_compensation')
        .select('staff_id, effective_from, effective_to')
        .in(
          'staff_id',
          missingStaff.map((s) => s.id),
        ),
    ) ?? []) as typeof compRows;
  }

  // Names live on profiles, keyed by the staff member's user id.
  const userIds = Array.from(
    new Set(
      [
        ...slips.map((s) => s.hr_staff?.user_id as string | undefined),
        ...missingStaff.map((s) => s.user_id ?? undefined),
        run.prepared_by as string | undefined,
        run.approved_by as string | undefined,
        run.release_armed_by as string | undefined,
      ].filter(Boolean) as string[],
    ),
  );
  const nameById = new Map<string, string | null>();
  if (userIds.length > 0) {
    const profiles = (unwrap(
      await supabase.from('profiles').select('id, full_name').in('id', userIds),
    ) ?? []) as Array<{ id: string; full_name: string | null }>;
    profiles.forEach((p) => nameById.set(p.id, p.full_name ?? null));
  }

  const positionIds = Array.from(
    new Set(
      [run.prepared_position_id as string | undefined, run.approved_position_id as string | undefined].filter(
        Boolean,
      ) as string[],
    ),
  );
  const positionById = new Map<string, string | null>();
  if (positionIds.length > 0) {
    const positions = (unwrap(
      await supabase.from('hr_positions').select('id, title').in('id', positionIds),
    ) ?? []) as Array<{ id: string; title: string | null }>;
    positions.forEach((p) => positionById.set(p.id, p.title ?? null));
  }

  // The releasing step records no position on the run, so the position holding
  // release authority is read from the authority register.
  const releaseAuthority = (unwrap(
    await supabase
      .from('hr_pay_authorities')
      .select('function_code, hr_positions(title)')
      .eq('function_code', 'release')
      .is('effective_to', null)
      .limit(1),
  ) ?? []) as Array<Record<string, any>>;

  const rows = slips
    .map((s) => {
      const userId = s.hr_staff?.user_id as string | undefined;
      return {
        id: s.id as string,
        staff_ref: (s.hr_staff?.staff_ref as string | null) ?? null,
        staff_name: userId ? nameById.get(userId) ?? null : null,
        department_name: (s.hr_departments?.name as string | null) ?? 'Unassigned',
        gross: Number(s.gross ?? 0),
        paye: Number(s.paye ?? 0),
        nssf_employee: Number(s.nssf_employee ?? 0),
        nssf_employer: Number(s.nssf_employer ?? 0),
        lst: Number(s.lst ?? 0),
        other_deductions: Number(s.other_deductions ?? 0),
        net: Number(s.net ?? 0),
        employer_cost: Number(s.employer_cost ?? 0),
      };
    })
    .sort(
      (a, b) =>
        a.department_name.localeCompare(b.department_name) ||
        (a.staff_name ?? '').localeCompare(b.staff_name ?? ''),
    );

  const formatPayStart = (value: string): string => {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  const omissions = missingStaff
    .map((s) => {
      const rows = compRows.filter((c) => c.staff_id === s.id);
      const coversPeriod = rows.some(
        (c) =>
          (!cutOff || c.effective_from <= cutOff) &&
          (!c.effective_to || !periodMonth || c.effective_to >= periodMonth),
      );
      const future = rows
        .filter((c) => cutOff && c.effective_from > cutOff)
        .sort((a, b) => a.effective_from.localeCompare(b.effective_from))[0];

      let reason = 'Not calculated';
      if (!coversPeriod && rows.length === 0) reason = 'No pay recorded for this period';
      else if (!coversPeriod && future) reason = `Pay starts ${formatPayStart(future.effective_from)}`;
      else if (!coversPeriod) reason = 'No pay recorded for this period';

      return {
        staff_id: s.id,
        staff_ref: s.staff_ref ?? null,
        staff_name: s.user_id ? nameById.get(s.user_id) ?? null : null,
        reason,
      };
    })
    .sort((a, b) => (a.staff_ref ?? '').localeCompare(b.staff_ref ?? ''));

  return {
    run_id: run.id as string,
    run_reference: String(run.id).slice(0, 8),
    status: run.status as string,
    rule_status_at_run: (run.rule_status_at_run as string | null) ?? null,
    rule_version_code: run.hr_pay_rule_versions?.code ?? null,
    period_code: run.hr_pay_periods?.code ?? null,
    pay_date: run.hr_pay_periods?.pay_date ?? null,
    prepared_at: (run.prepared_at as string | null) ?? null,
    approved_at: (run.approved_at as string | null) ?? null,
    release_armed_at: (run.release_armed_at as string | null) ?? null,
    prepared_position_title: run.prepared_position_id
      ? positionById.get(run.prepared_position_id) ?? null
      : null,
    prepared_by_name: run.prepared_by ? nameById.get(run.prepared_by) ?? null : null,
    approved_position_title: run.approved_position_id
      ? positionById.get(run.approved_position_id) ?? null
      : null,
    approved_by_name: run.approved_by ? nameById.get(run.approved_by) ?? null : null,
    released_position_title: (releaseAuthority[0]?.hr_positions?.title as string | null) ?? null,
    released_by_name: run.release_armed_by ? nameById.get(run.release_armed_by) ?? null : null,
    rows,
    enrolled_count: allStaff.length,
    omissions_count: omissions.length,
    omissions,
  };
}

export interface PayrollAuthority {
  preparer: boolean;
  approver: boolean;
  releaser: boolean;
}

export interface StatutoryReturnRow {
  staff_ref: string | null;
  employee_name: string | null;
  tin: string | null;
  nssf_number: string | null;
  lst_district: string | null;
  gross: number;
  paye: number;
  nssf_employee: number;
  nssf_employer: number;
  nssf_total: number;
  lst: number;
  missing: string | null;
}

/** URA / NSSF / LST filing lines for a run, straight from the database. */
export async function getStatutoryReturn(runId: string): Promise<StatutoryReturnRow[]> {
  const res = await (supabase.rpc as any)('hr_pay_statutory_return', { _run_id: runId });
  return (unwrap(res) ?? []) as StatutoryReturnRow[];
}

export async function myPayrollAuthority(): Promise<PayrollAuthority> {
  const [prep, appr, rel] = await Promise.all([
    (supabase.rpc as any)('hr_pay_is_preparer'),
    (supabase.rpc as any)('hr_pay_is_approver'),
    (supabase.rpc as any)('hr_pay_is_releaser'),
  ]);
  return {
    preparer: Boolean(unwrap(prep)),
    approver: Boolean(unwrap(appr)),
    releaser: Boolean(unwrap(rel)),
  };
}