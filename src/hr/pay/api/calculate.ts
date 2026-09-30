/**
 * HR Payroll calculation orchestration.
 *
 * Reads compensation + rule versions, runs the pure calculator and writes
 * payslips, payslip lines and a run event. Run status and run totals are
 * maintained by database triggers on hr_pay_run_events / hr_pay_payslips —
 * they are never written from here.
 */
import { supabase, unwrap } from '../../api/client';
import { calculatePayslip } from '../calculator';
import type { Applicability, PayComponentInput, RuleVersion, TaxBand } from '../calculator/types';

export interface RunEventRow {
  id: string;
  event_type: string;
  actor: string | null;
  actor_position_id: string | null;
  note: string | null;
  created_at: string;
  actor_name: string | null;
  actor_position_title: string | null;
}

export interface RunPayslipRow {
  id: string;
  staff_id: string;
  staff_ref: string | null;
  staff_name: string | null;
  gross: number;
  paye: number;
  nssf_employee: number;
  nssf_employer: number;
  lst: number;
  other_deductions: number;
  net: number;
  employer_cost: number;
  calc_seq: number;
  computed_at: string;
}

export interface RunDetail {
  id: string;
  run_type: string;
  status: string;
  rule_status_at_run: string | null;
  rule_version_id: string | null;
  total_gross: number | null;
  total_net: number | null;
  total_employer_cost: number | null;
  created_at: string;
  period_code: string | null;
  period_month: string | null;
  cut_off_date: string | null;
  pay_date: string | null;
  rule_version_code: string | null;
  rule_verified_at: string | null;
  events: RunEventRow[];
  payslips: RunPayslipRow[];
}

const CALCULABLE = ['draft', 'calculated', 'returned'];

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function getRunDetail(runId: string): Promise<RunDetail> {
  const run = unwrap(
    await supabase
      .from('hr_pay_runs')
      .select(
        'id, run_type, status, rule_status_at_run, rule_version_id, total_gross, total_net, total_employer_cost, created_at, hr_pay_periods(code, period_month, cut_off_date, pay_date), hr_pay_rule_versions(code, verified_at)',
      )
      .eq('id', runId)
      .single(),
  ) as Record<string, any>;

  const eventRows = (unwrap(
    await supabase
      .from('hr_pay_run_events')
      .select('id, event_type, actor, actor_position_id, note, created_at')
      .eq('run_id', runId)
      .order('created_at', { ascending: true }),
  ) ?? []) as Array<Record<string, any>>;

  const payslipRows = (unwrap(
    await supabase
      .from('hr_pay_payslips')
      .select(
        'id, staff_id, gross, paye, nssf_employee, nssf_employer, lst, other_deductions, net, employer_cost, calc_seq, computed_at, hr_staff(staff_ref, user_id)',
      )
      .eq('run_id', runId)
      .eq('is_current', true),
  ) ?? []) as Array<Record<string, any>>;

  const positionIds = Array.from(
    new Set(eventRows.map((e) => e.actor_position_id).filter(Boolean) as string[]),
  );
  const positionTitle: Record<string, string> = {};
  if (positionIds.length > 0) {
    const rows = (unwrap(
      await supabase.from('hr_positions').select('id, title').in('id', positionIds),
    ) ?? []) as Array<{ id: string; title: string }>;
    for (const r of rows) positionTitle[r.id] = r.title;
  }

  const actorIds = Array.from(new Set(eventRows.map((e) => e.actor).filter(Boolean) as string[]));
  const payslipUserIds = payslipRows
    .map((p) => p.hr_staff?.user_id as string | undefined)
    .filter(Boolean) as string[];
  const userIds = Array.from(new Set([...actorIds, ...payslipUserIds]));
  const nameByUser: Record<string, string> = {};
  if (userIds.length > 0) {
    const rows = (unwrap(
      await supabase.from('profiles').select('id, full_name').in('id', userIds),
    ) ?? []) as Array<{ id: string; full_name: string | null }>;
    for (const r of rows) if (r.full_name) nameByUser[r.id] = r.full_name;
  }

  return {
    id: run.id,
    run_type: run.run_type,
    status: run.status,
    rule_status_at_run: run.rule_status_at_run ?? null,
    rule_version_id: run.rule_version_id ?? null,
    total_gross: run.total_gross === null ? null : num(run.total_gross),
    total_net: run.total_net === null ? null : num(run.total_net),
    total_employer_cost:
      run.total_employer_cost === null ? null : num(run.total_employer_cost),
    created_at: run.created_at,
    period_code: run.hr_pay_periods?.code ?? null,
    period_month: run.hr_pay_periods?.period_month ?? null,
    cut_off_date: run.hr_pay_periods?.cut_off_date ?? null,
    pay_date: run.hr_pay_periods?.pay_date ?? null,
    rule_version_code: run.hr_pay_rule_versions?.code ?? null,
    rule_verified_at: run.hr_pay_rule_versions?.verified_at ?? null,
    events: eventRows.map((e) => ({
      id: e.id,
      event_type: e.event_type,
      actor: e.actor ?? null,
      actor_position_id: e.actor_position_id ?? null,
      note: e.note ?? null,
      created_at: e.created_at,
      actor_name: e.actor ? nameByUser[e.actor] ?? null : null,
      actor_position_title: e.actor_position_id
        ? positionTitle[e.actor_position_id] ?? null
        : null,
    })),
    payslips: payslipRows.map((p) => ({
      id: p.id,
      staff_id: p.staff_id,
      staff_ref: p.hr_staff?.staff_ref ?? null,
      staff_name: p.hr_staff?.user_id ? nameByUser[p.hr_staff.user_id] ?? null : null,
      gross: num(p.gross),
      paye: num(p.paye),
      nssf_employee: num(p.nssf_employee),
      nssf_employer: num(p.nssf_employer),
      lst: num(p.lst),
      other_deductions: num(p.other_deductions),
      net: num(p.net),
      employer_cost: num(p.employer_cost),
      calc_seq: p.calc_seq as number,
      computed_at: p.computed_at as string,
    })),
  };
}

export async function calculateRun(runId: string): Promise<{ payslips: number; message: string }> {
  // 1. Load the run.
  const run = unwrap(
    await supabase
      .from('hr_pay_runs')
      .select(
        'id, status, rule_version_id, rule_status_at_run, period_id, hr_pay_periods(period_month, cut_off_date)',
      )
      .eq('id', runId)
      .single(),
  ) as Record<string, any>;

  if (!CALCULABLE.includes(run.status)) {
    throw new Error('This run can no longer be calculated.');
  }
  if (!run.rule_version_id) {
    throw new Error('This run has no rule version attached.');
  }
  const periodEnd: string | null = run.hr_pay_periods?.cut_off_date ?? null;
  if (!periodEnd) {
    throw new Error('The pay period has no cut-off date.');
  }
  const periodMonth: string | null = run.hr_pay_periods?.period_month ?? null;
  if (!periodMonth) {
    throw new Error('The pay period has no period month.');
  }
  // First day of the period month.
  const periodStart = `${periodMonth.slice(0, 7)}-01`;

  // 2. Rule version + bands.
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

  // 3. Compensation in force during the period window.
  const compRowsRaw = (unwrap(
    await supabase
      .from('hr_pay_compensation')
      .select(
        'id, staff_id, component_id, amount, effective_from, effective_to, hr_pay_components(code, name, kind, taxable, nssf_able, lst_able, is_statutory)',
      )
      .lte('effective_from', periodEnd)
      .or(`effective_to.is.null,effective_to.gte.${periodStart}`),
  ) ?? []) as Array<Record<string, any>>;

  // One row per (staff_id, component_id): the latest effective_from wins.
  const latestByKey = new Map<string, Record<string, any>>();
  for (const row of compRowsRaw) {
    const key = `${row.staff_id}|${row.component_id}`;
    const held = latestByKey.get(key);
    if (!held || String(row.effective_from) > String(held.effective_from)) {
      latestByKey.set(key, row);
    }
  }
  // 3a. Exited staff are excluded from every run. A staff member is payable only
  // while hr_staff.active is true; hr_staff.ended_on can only be set when active
  // is false, so this one filter covers both.
  const candidateStaffIds = Array.from(
    new Set(compRowsRaw.map((r) => r.staff_id as string)),
  );

  const activeStaffRows =
    candidateStaffIds.length > 0
      ? ((unwrap(
          await supabase
            .from('hr_staff')
            .select('id')
            .eq('active', true)
            .in('id', candidateStaffIds),
        ) ?? []) as Array<{ id: string }>)
      : [];

  const activeStaffIds = new Set(activeStaffRows.map((s) => s.id));
  const compRows = Array.from(latestByKey.values()).filter((r) =>
    activeStaffIds.has(r.staff_id as string),
  );

  if (compRows.length === 0) {
    throw new Error('No active compensation records. Enter compensation before calculating.');
  }

  // 3b. Open statutory profiles (effective_to is null). Missing row = all apply.
  const statutoryRows = (unwrap(
    await supabase
      .from('hr_pay_statutory_profiles')
      .select(
        'staff_id, employment_type, paye_applicable, nssf_applicable, lst_applicable, exemption_basis',
      )
      .is('effective_to', null),
  ) ?? []) as Array<Record<string, any>>;

  const statutoryByStaff = new Map<string, Record<string, any>>();
  for (const row of statutoryRows) statutoryByStaff.set(row.staff_id as string, row);

  // 4. Group by staff and calculate.
  const byStaff = new Map<string, Array<Record<string, any>>>();
  for (const row of compRows) {
    const key = row.staff_id as string;
    const list = byStaff.get(key) ?? [];
    list.push(row);
    byStaff.set(key, list);
  }

  const computed: Array<{
    staffId: string;
    earnings: PayComponentInput[];
    otherDeductions: number;
    advanceRecovery: number;
    reinvestment: number;
    reinvestPercentage: number | null;
    reinvestPayoutMode: string | null;
    reinvestCapped: boolean;
    applicability: Applicability;
    employmentType: string | null;
    exemptionBasis: string | null;
    result: ReturnType<typeof calculatePayslip>;
  }> = [];

  // Approved advances (used to split the recovered figure per advance below).
  const advanceRows = (unwrap(
    await supabase
      .from('hr_pay_advances')
      .select('id, staff_id, principal, recovery_mode, recovery_value, first_recovery_on')
      .eq('status', 'approved'),
  ) ?? []) as Array<Record<string, any>>;

  const priorRecoveries = (unwrap(
    await supabase.from('hr_pay_advance_recoveries').select('advance_id, run_id, amount'),
  ) ?? []) as Array<{ advance_id: string; run_id: string; amount: number | string }>;

  const recoveredElsewhere = new Map<string, number>();
  for (const r of priorRecoveries) {
    if (r.run_id === runId) continue;
    recoveredElsewhere.set(r.advance_id, (recoveredElsewhere.get(r.advance_id) ?? 0) + num(r.amount));
  }

  const today = new Date().toISOString().slice(0, 10);
  const advancesByStaff = new Map<string, Array<Record<string, any>>>();
  for (const a of advanceRows) {
    const key = a.staff_id as string;
    const list = advancesByStaff.get(key) ?? [];
    list.push(a);
    advancesByStaff.set(key, list);
  }

  const recoveryAllocations: Array<{ advance_id: string; run_id: string; amount: number }> = [];

  // Reinvestment pledges: each person's latest answer to the reinvestment survey,
  // read at the moment of calculation, so a pledge made just before a recalculation
  // is included. A decline, or no answer, means no deduction.
  const pledgeRows = (unwrap(
    await (supabase.rpc as any)('hr_pay_reinvest_pledges'),
  ) ?? []) as Array<{ staff_id: string; response: string; percentage: number | null; payout_mode: string | null }>;
  const pledgeByStaff = new Map<string, { percentage: number; payoutMode: string | null }>();
  for (const p of pledgeRows) {
    if (p.response === 'pledge' && num(p.percentage) > 0) {
      pledgeByStaff.set(p.staff_id, { percentage: num(p.percentage), payoutMode: p.payout_mode ?? null });
    }
  }

  for (const [staffId, rows] of byStaff.entries()) {
    const earnings: PayComponentInput[] = rows
      .filter((r) => r.hr_pay_components?.kind === 'earning')
      .map((r) => ({
        code: r.hr_pay_components.code as string,
        name: r.hr_pay_components.name as string,
        kind: r.hr_pay_components.kind as string,
        amount: num(r.amount),
        taxable: Boolean(r.hr_pay_components.taxable),
        nssfAble: Boolean(r.hr_pay_components.nssf_able),
        lstAble: Boolean(r.hr_pay_components.lst_able),
      }));

    // Part-month pay REPLACES basic salary for the period a person joined or left.
    // If both are present, drop BASIC before any figure is computed.
    const prorata = earnings.find((e) => e.code === 'PRORATA' && e.amount > 0);
    const replacedBasic = Boolean(prorata) && earnings.some((e) => e.code === 'BASIC');
    const effectiveEarnings = replacedBasic
      ? earnings.filter((e) => e.code !== 'BASIC')
      : earnings;

    const standingDeductions = rows
      .filter(
        (r) =>
          r.hr_pay_components?.kind === 'deduction' && r.hr_pay_components?.is_statutory === false,
      )
      .reduce((sum, r) => sum + num(r.amount), 0);

    // The advance instalment due this run is decided by the database.
    const grossForAdvance = effectiveEarnings.reduce((sum, e) => sum + e.amount, 0);
    const advanceRecovery = num(
      unwrap(
        await (supabase.rpc as any)('hr_pay_advance_due', {
          _staff_id: staffId,
          _gross: grossForAdvance,
          _run_id: runId,
        }),
      ),
    );
    const otherDeductions = standingDeductions + advanceRecovery;

    if (advanceRecovery > 0) {
      for (const a of advancesByStaff.get(staffId) ?? []) {
        if ((a.first_recovery_on as string) > today) continue;
        const remaining = num(a.principal) - (recoveredElsewhere.get(a.id as string) ?? 0);
        if (remaining <= 0) continue;
        const instalment =
          a.recovery_mode === 'fixed'
            ? num(a.recovery_value)
            : Math.round((grossForAdvance * num(a.recovery_value)) / 100);
        const amount = Math.min(instalment, remaining);
        if (amount > 0) {
          recoveryAllocations.push({ advance_id: a.id as string, run_id: runId, amount });
        }
      }
    }

    const profile = statutoryByStaff.get(staffId) ?? null;
    const applicability: Applicability = {
      payeApplicable: profile ? profile.paye_applicable !== false : true,
      nssfApplicable: profile ? profile.nssf_applicable !== false : true,
      lstApplicable: profile ? profile.lst_applicable !== false : true,
    };

    let result = calculatePayslip(effectiveEarnings, rule, 0, otherDeductions, applicability);

    // Reinvestment: the pledged percentage of gross, never more than what is left of
    // the pay after tax and other deductions. Deducted after tax, so it never changes
    // PAYE or NSSF.
    const pledge = pledgeByStaff.get(staffId) ?? null;
    let reinvestment = 0;
    let reinvestCapped = false;
    if (pledge) {
      const fromGross = Math.round((result.gross * pledge.percentage) / 100);
      const available = Math.max(0, result.net);
      reinvestment = Math.min(fromGross, available);
      reinvestCapped = reinvestment < fromGross;
      if (reinvestment > 0) {
        result = calculatePayslip(effectiveEarnings, rule, 0, otherDeductions + reinvestment, applicability);
        result.trace.push(
          `Salary reinvestment of ${pledge.percentage}% of gross${reinvestCapped ? ', capped at take-home pay' : ''} deducted after tax.`,
        );
      }
    }
    if (replacedBasic) {
      result.trace.push(
        'Basic salary was replaced by part-month pay for this period, so the BASIC component was excluded from this payslip.',
      );
    }
    computed.push({
      staffId,
      earnings: effectiveEarnings,
      otherDeductions,
      advanceRecovery,
      reinvestment,
      reinvestPercentage: pledge?.percentage ?? null,
      reinvestPayoutMode: pledge?.payoutMode ?? null,
      reinvestCapped,
      applicability,
      employmentType: (profile?.employment_type as string | null) ?? null,
      exemptionBasis: (profile?.exemption_basis as string | null) ?? null,
      result,
    });
  }

  // 5. Supersede existing payslips, find the next calc_seq.
  // 4b. Live assignment per staff member: started on/before the cut-off and not
  // ended before the period month began. Prefer is_primary, then latest start.
  const assignmentRows = (unwrap(
    await supabase
      .from('hr_assignments')
      .select(
        'staff_id, position_id, department_id, started_on, ended_on, is_primary, position:hr_positions!hr_assignments_position_id_fkey(title, department_id), department:hr_departments!hr_assignments_department_id_fkey(name)',
      )
      .in('staff_id', Array.from(byStaff.keys()))
      .lte('started_on', periodEnd)
      .or(`ended_on.is.null,ended_on.gte.${periodStart}`),
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

  // 5. Supersede existing payslips, find the next calc_seq.
  const existing = (unwrap(
    await supabase
      .from('hr_pay_payslips')
      .select('id, calc_seq')
      .eq('run_id', runId),
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

  // 6. Insert payslips.
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
              earnings: c.earnings,
              otherDeductions: c.otherDeductions,
              advance_recovery: c.advanceRecovery,
              reinvestment: {
                percentage: c.reinvestPercentage,
                payout_mode: c.reinvestPayoutMode,
                amount: c.reinvestment,
                capped: c.reinvestCapped,
              },
              ruleCode: rule.code,
              periodStart,
              periodEnd,
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

  // 7. Insert payslip lines.
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

  // 7b. The advance recovery line, always last on the payslip.
  const advanceLines = computed
    .filter((c) => c.advanceRecovery > 0)
    .map((c) => ({
      payslip_id: payslipIdByStaff[c.staffId],
      component_code: 'ADVANCE',
      name: 'Salary advance recovery',
      kind: 'deduction',
      quantity: 1,
      amount: c.advanceRecovery,
      taxable_at_run: false,
      display_order: 9000,
    }));

  if (advanceLines.length > 0) {
    unwrap(await supabase.from('hr_pay_payslip_lines').insert(advanceLines).select('id'));
  }

  // 7b-ii. The reinvestment line, after advance recovery.
  const reinvestLines = computed
    .filter((c) => c.reinvestment > 0)
    .map((c) => ({
      payslip_id: payslipIdByStaff[c.staffId],
      component_code: 'REINVEST',
      name: `Salary reinvestment (${c.reinvestPercentage ?? 0}%)`,
      kind: 'deduction',
      quantity: 1,
      amount: c.reinvestment,
      taxable_at_run: false,
      display_order: 9100,
    }));

  if (reinvestLines.length > 0) {
    unwrap(await supabase.from('hr_pay_payslip_lines').insert(reinvestLines).select('id'));
  }

  // 7c. Recoveries are keyed on (advance_id, run_id) so a recalculation
  // overwrites the previous figure instead of adding to it.
  if (recoveryAllocations.length > 0) {
    unwrap(
      await supabase
        .from('hr_pay_advance_recoveries')
        .upsert(recoveryAllocations, { onConflict: 'advance_id,run_id' })
        .select('id'),
    );
  }

  // 8. Record the event — the trigger moves status and totals.
  unwrap(
    await supabase
      .from('hr_pay_run_events')
      .insert({
        run_id: runId,
        event_type: 'calculated',
        note: `${inserted.length} payslip${inserted.length === 1 ? '' : 's'} written.`,
      })
      .select('id')
      .single(),
  );

  return {
    payslips: inserted.length,
    message: `${inserted.length} payslip${inserted.length === 1 ? '' : 's'} written.`,
  };
}
