/**
 * Off-cycle arrears runs (hr_pay_arrears).
 *
 * An arrears run pays named people a one-off amount owed for an earlier period.
 * It computes from `hr_pay_arrears`, never from `hr_pay_compensation`, so only
 * the selected people get a payslip — a regular run recomputes everybody and is
 * the wrong instrument for this.
 *
 * Deliberate choices, all decided by the business:
 *  - statutory treatment follows each person's open profile, exactly as a
 *    regular run does. PAYE is computed on the arrears amount alone.
 *  - no advance recovery. Recovery belongs to the monthly run; taking an
 *    instalment here would deduct twice in one month.
 *  - LST is passed as 0, matching the regular run.
 *  - calculation only links rows to the run. `status` moves to 'paid' on the
 *    run's paid event, from a database trigger — never from here.
 *
 * Run status and run totals are maintained by database triggers on
 * hr_pay_run_events / hr_pay_payslips and are never written here.
 */
import { supabase, unwrap } from '../../api/client';
import { calculatePayslip } from '../calculator';
import type { Applicability, PayComponentInput, RuleVersion, TaxBand } from '../calculator/types';

const CALCULABLE = ['draft', 'calculated', 'returned'];

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface ArrearsComponentOption {
  id: string;
  code: string;
  name: string;
}

export interface PendingArrearsRow {
  id: string;
  staffId: string;
  staffRef: string;
  staffName: string;
  componentCode: string;
  componentName: string;
  amount: number;
  periodOwed: string;
  basis: string;
  paidInRunId: string | null;
}

/** Active earning components an arrears amount may be booked against. */
export async function listArrearsComponentOptions(): Promise<ArrearsComponentOption[]> {
  const res = await supabase
    .from('hr_pay_components')
    .select('id, code, name')
    .eq('kind', 'earning')
    .eq('active', true)
    .order('display_order', { ascending: true });
  const rows = (unwrap(res) ?? []) as Array<{ id: string; code: string | null; name: string | null }>;
  return rows.map((r) => ({ id: r.id, code: r.code ?? '', name: r.name ?? '' }));
}

/** Every arrears amount still owed, newest first. */
export async function listPendingArrears(): Promise<PendingArrearsRow[]> {
  const rows = (unwrap(
    await supabase
      .from('hr_pay_arrears')
      .select(
        'id, staff_id, amount, period_owed, basis, paid_in_run_id, created_at, ' +
          'staff:hr_staff!hr_pay_arrears_staff_id_fkey(staff_ref, user_id), ' +
          'component:hr_pay_components!hr_pay_arrears_component_id_fkey(code, name)',
      )
      .eq('status', 'pending')
      .order('created_at', { ascending: false }),
  ) ?? []) as Array<Record<string, any>>;

  const userIds = Array.from(
    new Set(rows.map((r) => r.staff?.user_id as string | undefined).filter(Boolean) as string[]),
  );
  const nameByUser: Record<string, string> = {};
  if (userIds.length > 0) {
    const profiles = (unwrap(
      await supabase.from('profiles').select('id, full_name').in('id', userIds),
    ) ?? []) as Array<{ id: string; full_name: string | null }>;
    for (const p of profiles) if (p.full_name) nameByUser[p.id] = p.full_name;
  }

  return rows.map((r) => ({
    id: r.id as string,
    staffId: r.staff_id as string,
    staffRef: (r.staff?.staff_ref as string) ?? '',
    staffName: r.staff?.user_id ? nameByUser[r.staff.user_id] ?? '' : '',
    componentCode: (r.component?.code as string) ?? '',
    componentName: (r.component?.name as string) ?? '',
    amount: num(r.amount),
    periodOwed: r.period_owed as string,
    basis: (r.basis as string) ?? '',
    paidInRunId: (r.paid_in_run_id as string | null) ?? null,
  }));
}

/** Record an amount owed. The written basis is required by the table. */
export async function addArrears(input: {
  staffId: string;
  componentId: string;
  amount: number;
  periodOwed: string;
  basis: string;
}): Promise<void> {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error('The arrears amount must be greater than zero.');
  }
  if (input.basis.trim().length < 10) {
    throw new Error('Arrears need a written basis of at least 10 characters.');
  }
  if (!/^[0-9]{4}-[0-9]{2}$/.test(input.periodOwed)) {
    throw new Error('The period owed must be written as YYYY-MM.');
  }
  const res = await supabase
    .from('hr_pay_arrears')
    .insert({
      staff_id: input.staffId,
      component_id: input.componentId,
      amount: input.amount,
      period_owed: input.periodOwed,
      basis: input.basis.trim(),
    })
    .select('id')
    .single();
  unwrap(res);
}

/** Withdraw an amount that has not been paid. */
export async function cancelArrears(id: string): Promise<void> {
  const res = await supabase
    .from('hr_pay_arrears')
    .update({ status: 'cancelled', paid_in_run_id: null })
    .eq('id', id)
    .eq('status', 'pending')
    .select('id')
    .single();
  unwrap(res);
}

export async function calculateArrearsRun(
  runId: string,
  arrearsIds: string[],
): Promise<{ payslips: number; message: string }> {
  if (arrearsIds.length === 0) {
    throw new Error('Select at least one arrears entry to pay.');
  }

  // 1. Load and vet the run. Arrears never touch a regular run.
  const run = unwrap(
    await supabase
      .from('hr_pay_runs')
      .select('id, status, run_type, rule_version_id, rule_status_at_run, period_id')
      .eq('id', runId)
      .single(),
  ) as Record<string, any>;

  if (run.run_type !== 'off_cycle') {
    throw new Error(
      'Arrears are paid only on an off-cycle run. This run is a ' + String(run.run_type) + ' run.',
    );
  }
  if (!CALCULABLE.includes(run.status as string)) {
    throw new Error('This run can no longer be calculated.');
  }
  if (!run.rule_version_id) {
    throw new Error('This run has no rule version attached.');
  }

  // 2. Rule version + tax bands.
  const version = unwrap(
    await supabase
      .from('hr_pay_rule_versions')
      .select(
        'id, code, effective_from, nssf_employee_rate, nssf_employer_rate, nssf_reduces_paye_base, rounding_rule',
      )
      .eq('id', run.rule_version_id)
      .single(),
  ) as Record<string, any>;

  const bandRows = (unwrap(
    await supabase
      .from('hr_pay_tax_bands')
      .select('band_order, lower_bound, upper_bound, rate, fixed_amount')
      .eq('rule_version_id', run.rule_version_id)
      .order('band_order', { ascending: true }),
  ) ?? []) as Array<Record<string, any>>;

  if (bandRows.length === 0) {
    throw new Error('This rule version has no tax bands. Load bands before calculating.');
  }

  const bands: TaxBand[] = bandRows.map((b) => ({
    bandOrder: Number(b.band_order),
    lowerBound: num(b.lower_bound),
    upperBound: b.upper_bound === null ? null : num(b.upper_bound),
    rate: num(b.rate),
    fixedAmount: num(b.fixed_amount),
  }));

  const rule: RuleVersion = {
    code: version.code as string,
    effectiveFrom: version.effective_from as string,
    nssfEmployeeRate: num(version.nssf_employee_rate),
    nssfEmployerRate: num(version.nssf_employer_rate),
    nssfReducesPayeBase: Boolean(version.nssf_reduces_paye_base),
    roundingRule: version.rounding_rule as string,
    bands,
  };

  // 3. The selected rows, still pending.
  const arrearsRows = (unwrap(
    await supabase
      .from('hr_pay_arrears')
      .select(
        'id, staff_id, amount, period_owed, ' +
          'component:hr_pay_components!hr_pay_arrears_component_id_fkey(code, name, kind, taxable, nssf_able, lst_able)',
      )
      .eq('status', 'pending')
      .in('id', arrearsIds),
  ) ?? []) as Array<Record<string, any>>;

  if (arrearsRows.length === 0) {
    throw new Error('None of the selected arrears entries is still pending.');
  }

  // 4. Exited staff are excluded, same gate as a regular run.
  const candidateStaffIds = Array.from(new Set(arrearsRows.map((r) => r.staff_id as string)));
  const activeRows = (unwrap(
    await supabase.from('hr_staff').select('id').eq('active', true).in('id', candidateStaffIds),
  ) ?? []) as Array<{ id: string }>;
  const activeStaffIds = new Set(activeRows.map((s) => s.id));
  const payable = arrearsRows.filter((r) => activeStaffIds.has(r.staff_id as string));

  if (payable.length === 0) {
    throw new Error('Every selected person is inactive. An exited person is not paid by a run.');
  }

  // 5. Open statutory profiles. A missing row means everything applies.
  const statutoryRows = (unwrap(
    await supabase
      .from('hr_pay_statutory_profiles')
      .select('staff_id, employment_type, paye_applicable, nssf_applicable, lst_applicable, exemption_basis')
      .is('effective_to', null),
  ) ?? []) as Array<Record<string, any>>;
  const statutoryByStaff = new Map<string, Record<string, any>>();
  for (const row of statutoryRows) statutoryByStaff.set(row.staff_id as string, row);

  // 6. Live assignment per person, for department and position on the payslip.
  const assignmentRows = (unwrap(
    await supabase
      .from('hr_assignments')
      .select(
        'staff_id, position_id, department_id, started_on, ended_on, is_primary, ' +
          'position:hr_positions!hr_assignments_position_id_fkey(title, department_id), ' +
          'department:hr_departments!hr_assignments_department_id_fkey(name)',
      )
      .in('staff_id', Array.from(activeStaffIds))
      .is('ended_on', null),
  ) ?? []) as Array<Record<string, any>>;

  const assignmentByStaff = new Map<string, Record<string, any>>();
  for (const row of assignmentRows) {
    const held = assignmentByStaff.get(row.staff_id as string);
    if (!held) {
      assignmentByStaff.set(row.staff_id as string, row);
      continue;
    }
    const better =
      (Boolean(row.is_primary) && !Boolean(held.is_primary)) ||
      (Boolean(row.is_primary) === Boolean(held.is_primary) &&
        String(row.started_on) > String(held.started_on));
    if (better) assignmentByStaff.set(row.staff_id as string, row);
  }

  function placement(staffId: string) {
    const a = assignmentByStaff.get(staffId);
    if (!a) {
      return {
        position_id: null as string | null,
        department_id: null as string | null,
        position_title: null as string | null,
        department_name: null as string | null,
      };
    }
    return {
      position_id: (a.position_id as string) ?? null,
      department_id: (a.department_id as string) ?? (a.position?.department_id as string) ?? null,
      position_title: (a.position?.title as string) ?? null,
      department_name: (a.department?.name as string) ?? null,
    };
  }

  // 7. One payslip per person, from their selected arrears rows.
  const byStaff = new Map<string, Array<Record<string, any>>>();
  for (const row of payable) {
    const key = row.staff_id as string;
    const list = byStaff.get(key) ?? [];
    list.push(row);
    byStaff.set(key, list);
  }

  const computed: Array<{
    staffId: string;
    earnings: PayComponentInput[];
    periodsOwed: string[];
    arrearsIds: string[];
    applicability: Applicability;
    employmentType: string | null;
    exemptionBasis: string | null;
    result: ReturnType<typeof calculatePayslip>;
  }> = [];

  for (const [staffId, rows] of byStaff.entries()) {
    const earnings: PayComponentInput[] = rows.map((r) => ({
      code: r.component.code as string,
      name: r.component.name as string,
      kind: r.component.kind as string,
      amount: num(r.amount),
      taxable: Boolean(r.component.taxable),
      nssfAble: Boolean(r.component.nssf_able),
      lstAble: Boolean(r.component.lst_able),
    }));

    const profile = statutoryByStaff.get(staffId) ?? null;
    const applicability: Applicability = {
      payeApplicable: profile ? profile.paye_applicable !== false : true,
      nssfApplicable: profile ? profile.nssf_applicable !== false : true,
      lstApplicable: profile ? profile.lst_applicable !== false : true,
    };

    // lstMonthly 0 and otherDeductions 0: no LST and no advance recovery here.
    const result = calculatePayslip(earnings, rule, 0, 0, applicability);
    const periodsOwed = Array.from(new Set(rows.map((r) => r.period_owed as string))).sort();
    result.trace.push(
      'This is an off-cycle arrears payslip. It pays amounts owed for ' +
        periodsOwed.join(', ') +
        ' and carries no salary, no advance recovery and no Local Service Tax.',
    );

    computed.push({
      staffId,
      earnings,
      periodsOwed,
      arrearsIds: rows.map((r) => r.id as string),
      applicability,
      employmentType: (profile?.employment_type as string | null) ?? null,
      exemptionBasis: (profile?.exemption_basis as string | null) ?? null,
      result,
    });
  }

  // 8. Supersede anything already on the run, find the next calc_seq.
  const existing = (unwrap(
    await supabase.from('hr_pay_payslips').select('id, calc_seq').eq('run_id', runId),
  ) ?? []) as Array<{ id: string; calc_seq: number }>;

  if (existing.length > 0) {
    unwrap(
      await supabase
        .from('hr_pay_payslips')
        .update({ is_current: false })
        .eq('run_id', runId)
        .select('id'),
    );
  }
  const nextSeq =
    existing.length > 0 ? Math.max(...existing.map((e) => Number(e.calc_seq) || 0)) + 1 : 1;

  // 9. Insert payslips.
  const computedAt = new Date().toISOString();
  const inserted = (unwrap(
    await supabase
      .from('hr_pay_payslips')
      .insert(
        computed.map((c) => {
          const place = placement(c.staffId);
          return {
            run_id: runId,
            staff_id: c.staffId,
            position_id: place.position_id,
            department_id: place.department_id,
            calc_seq: nextSeq,
            is_current: true,
            gross: c.result.gross,
            chargeable_income: c.result.chargeableIncome,
            paye: c.result.paye,
            nssf_employee: c.result.nssfEmployee,
            nssf_employer: c.result.nssfEmployer,
            lst: c.result.lst,
            other_deductions: c.result.otherDeductions,
            net: c.result.net,
            employer_cost: c.result.employerCost,
            rule_version_id: run.rule_version_id,
            rule_status_at_run: run.rule_status_at_run ?? 'provisional',
            inputs_snapshot: JSON.parse(
              JSON.stringify({
                source: 'arrears',
                arrears_ids: c.arrearsIds,
                periods_owed: c.periodsOwed,
                earnings: c.earnings,
                otherDeductions: 0,
                advance_recovery: 0,
                ruleCode: rule.code,
                employment_type: c.employmentType,
                paye_applicable: c.applicability.payeApplicable,
                nssf_applicable: c.applicability.nssfApplicable,
                lst_applicable: c.applicability.lstApplicable,
                exemption_basis: c.exemptionBasis,
                position_id: place.position_id,
                position_title: place.position_title,
                department_id: place.department_id,
                department_name: place.department_name,
              }),
            ),
            calculation_trace: JSON.parse(JSON.stringify(c.result.trace)),
            computed_at: computedAt,
          };
        }),
      )
      .select('id, staff_id'),
  ) ?? []) as Array<{ id: string; staff_id: string }>;

  // 10. Payslip lines.
  const payslipIdByStaff: Record<string, string> = {};
  for (const row of inserted) payslipIdByStaff[row.staff_id] = row.id;

  const lines = computed.flatMap((c) =>
    c.result.lines.map((line, index) => ({
      payslip_id: payslipIdByStaff[c.staffId],
      component_code: line.componentCode,
      name: line.name,
      kind: line.kind,
      amount: line.amount,
      taxable_at_run: line.taxableAtRun,
      display_order: index + 1,
    })),
  );

  if (lines.length > 0) {
    unwrap(await supabase.from('hr_pay_payslip_lines').insert(lines).select('id'));
  }

  // 11. Link the paid rows to this run. Status stays 'pending' — the database
  //     moves it to 'paid' on the run's paid event, so recalculating or
  //     cancelling this run leaves the money still owed rather than stranded.
  const selectedIds = computed.flatMap((c) => c.arrearsIds);

  const previouslyLinked = (unwrap(
    await supabase
      .from('hr_pay_arrears')
      .select('id')
      .eq('paid_in_run_id', runId)
      .eq('status', 'pending'),
  ) ?? []) as Array<{ id: string }>;

  const dropped = previouslyLinked.map((r) => r.id).filter((id) => !selectedIds.includes(id));
  if (dropped.length > 0) {
    unwrap(
      await supabase
        .from('hr_pay_arrears')
        .update({ paid_in_run_id: null })
        .in('id', dropped)
        .select('id'),
    );
  }

  unwrap(
    await supabase
      .from('hr_pay_arrears')
      .update({ paid_in_run_id: runId })
      .in('id', selectedIds)
      .select('id'),
  );

  // 12. Record the event — the trigger moves status and totals.
  unwrap(
    await supabase
      .from('hr_pay_run_events')
      .insert({
        run_id: runId,
        event_type: 'calculated',
        note:
          inserted.length +
          ' arrears payslip' +
          (inserted.length === 1 ? '' : 's') +
          ' written.',
      })
      .select('id')
      .single(),
  );

  return {
    payslips: inserted.length,
    message:
      inserted.length + ' arrears payslip' + (inserted.length === 1 ? '' : 's') + ' written.',
  };
}
