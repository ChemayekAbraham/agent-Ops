/**
 * HR Payroll compensation data access (hr_pay_compensation).
 * Append-only by design: a change is a new effective-dated row, never an edit.
 */
import { supabase, unwrap } from '../../api/client';
import { getStaffDirectory } from '../../api/people';

export interface PayrollStaffOption {
  staffId: string;
  name: string;
  department: string;
  position: string;
}

export interface CompensationRow {
  id: string;
  staff_id: string;
  component_id: string;
  grade_id: string | null;
  amount: number;
  currency: string;
  effective_from: string;
  effective_to: string | null;
  reason: string;
  component_code: string;
  component_name: string;
  component_kind: string;
  grade_code: string | null;
}

const COMP_SELECT =
  'id, staff_id, component_id, grade_id, amount, currency, effective_from, effective_to, reason, component:hr_pay_components!hr_pay_compensation_component_id_fkey(code, name, kind), grade:hr_pay_grades!hr_pay_compensation_grade_id_fkey(code)';

type RawCompRow = Omit<
  CompensationRow,
  'component_code' | 'component_name' | 'component_kind' | 'grade_code'
> & {
  component: { code: string; name: string; kind: string } | null;
  grade: { code: string } | null;
};

function mapRow(row: RawCompRow): CompensationRow {
  return {
    id: row.id,
    staff_id: row.staff_id,
    component_id: row.component_id,
    grade_id: row.grade_id,
    amount: Number(row.amount),
    currency: row.currency,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    reason: row.reason,
    component_code: row.component?.code ?? '',
    component_name: row.component?.name ?? '',
    component_kind: row.component?.kind ?? '',
    grade_code: row.grade?.code ?? null,
  };
}

/** Enrolled staff, sourced from the HR staff directory helper (never `profiles`). */
export async function listStaffForPayroll(): Promise<PayrollStaffOption[]> {
  const staff = await getStaffDirectory();
  return staff
    .map((s) => ({
      staffId: s.id,
      name: s.full_name || s.staff_number || s.id,
      department: s.current_assignment?.department_name ?? '',
      position: s.current_assignment?.role_title ?? '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listCompensation(staffId: string): Promise<CompensationRow[]> {
  const res = await supabase
    .from('hr_pay_compensation')
    .select(COMP_SELECT)
    .eq('staff_id', staffId)
    .order('effective_from', { ascending: false });
  const rows = (unwrap(res) ?? []) as unknown as RawCompRow[];
  return rows.map(mapRow);
}

export async function addCompensation(
  staffId: string,
  componentId: string,
  gradeId: string | null,
  amount: number,
  effectiveFrom: string,
  reason: string,
): Promise<CompensationRow> {
  // A correction is applied by the database, which closes any overlapping record
  // — including one starting in the same month — and writes the new row.
  const newId = unwrap(
    await (supabase.rpc as any)('hr_pay_correct_compensation', {
      _staff_id: staffId,
      _component_id: componentId,
      _amount: amount,
      _effective_from: effectiveFrom,
      _reason: reason,
      _grade_id: gradeId,
    }),
  ) as string;

  const res = await supabase.from('hr_pay_compensation').select(COMP_SELECT).eq('id', newId).single();
  return mapRow(unwrap(res) as unknown as RawCompRow);
}

/**
 * A one-off part-month payment (PRORATA), bounded to a single pay period.
 * The row is created effective from the period start and then closed on the
 * period cut-off date, so it can never repeat in a later period.
 */
export async function addPartMonthPay(
  staffId: string,
  amount: number,
  periodStart: string,
  periodEnd: string,
  reason: string,
): Promise<CompensationRow> {
  const componentRes = await supabase
    .from('hr_pay_components')
    .select('id')
    .eq('code', 'PRORATA')
    .eq('active', true)
    .maybeSingle();
  const component = unwrap(componentRes) as { id: string } | null;
  if (!component) {
    throw new Error('The PRORATA component is missing. Add it on the Payroll config screen.');
  }

  const created = await addCompensation(staffId, component.id, null, amount, periodStart, reason);

  const closed = await supabase
    .from('hr_pay_compensation')
    .update({ effective_to: periodEnd })
    .eq('id', created.id)
    .select(COMP_SELECT)
    .single();
  return mapRow(unwrap(closed) as unknown as RawCompRow);
}