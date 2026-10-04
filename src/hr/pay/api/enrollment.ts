/**
 * HR Payroll enrollment view — one row per active worker with their basic pay
 * and statutory deduction profile.
 *
 * Writes are append-only and delegated:
 *  - statutory profiles go through the `hr_pay_set_statutory_profile` RPC,
 *  - basic pay reuses `addCompensation` from ./compensation.
 * Neither table is ever written directly from this file.
 */
import { supabase, unwrap } from '../../api/client';
import { addCompensation } from './compensation';

export interface EnrollmentRow {
  staffId: string;
  staffRef: string;
  name: string;
  department: string;
  position: string;
  employmentType: string | null;
  payeApplicable: boolean;
  nssfApplicable: boolean;
  lstApplicable: boolean;
  exemptionBasis: string | null;
  hasStatutoryProfile: boolean;
  basicAmount: number | null;
  basicEffectiveFrom: string | null;
  allowancesTotal: number;
  deductionsTotal: number;
  grossTotal: number;
  partMonthAmount: number;
  tin: string | null;
  nssfNumber: string | null;
  lstDistrict: string | null;
}

export interface EnrollmentResult {
  rows: EnrollmentRow[];
  openPeriodCode: string | null;
  openPeriodStart: string | null;
  openPeriodCutOff: string | null;
  /**
   * First day of the open pay period: the day after the previous period's
   * cut-off (e.g. 29 Aug for a period with cut-off 28 Sep). The first of the
   * month when there is no earlier period.
   */
  payWindowStart: string | null;
}

type StaffRow = {
  id: string;
  staff_ref: string | null;
  user_id: string;
  assignments:
    | {
        ended_on: string | null;
        is_primary: boolean | null;
        department: { name: string | null } | null;
        position: { title: string | null } | null;
      }[]
    | null;
};

type StatutoryRow = {
  staff_id: string;
  employment_type: string | null;
  paye_applicable: boolean | null;
  nssf_applicable: boolean | null;
  lst_applicable: boolean | null;
  exemption_basis: string | null;
};

type CompRow = { staff_id: string; amount: number | string; effective_from: string };

type StatutoryIdRow = {
  staff_id: string;
  tin: string | null;
  nssf_number: string | null;
  lst_district: string | null;
};

type OpenCompRow = {
  staff_id: string;
  amount: number | string;
  component: { code: string; kind: string; is_statutory: boolean } | null;
};

const STAFF_SELECT =
  'id, staff_ref, user_id, assignments:hr_assignments(ended_on, is_primary, department:hr_departments(name), position:hr_positions!position_id(title))';

/** The id of the BASIC pay component. Basic pay is always this component. */
async function basicComponentId(): Promise<string> {
  const res = await supabase
    .from('hr_pay_components')
    .select('id')
    .eq('code', 'BASIC')
    .maybeSingle();
  const row = unwrap(res) as { id: string } | null;
  if (!row) throw new Error('The BASIC pay component is not configured');
  return row.id;
}

/** The active PRORATA component, or null when it has not been configured. */
async function prorataComponentId(): Promise<string | null> {
  const res = await supabase
    .from('hr_pay_components')
    .select('id')
    .eq('code', 'PRORATA')
    .eq('active', true)
    .maybeSingle();
  const row = unwrap(res) as { id: string } | null;
  return row?.id ?? null;
}

function firstDayOf(monthValue: string): string {
  return `${monthValue.slice(0, 7)}-01`;
}

export async function listEnrollment(): Promise<EnrollmentResult> {
  const staff = (unwrap(
    await supabase.from('hr_staff').select(STAFF_SELECT).eq('active', true),
  ) ?? []) as unknown as StaffRow[];

  const periodRes = await supabase
    .from('hr_pay_periods')
    .select('code, period_month, cut_off_date')
    .eq('status', 'open')
    .order('period_month', { ascending: false })
    .limit(1)
    .maybeSingle();
  const period = unwrap(periodRes) as
    | { code: string; period_month: string; cut_off_date: string }
    | null;
  const openPeriodCode = period?.code ?? null;
  const openPeriodStart = period ? firstDayOf(period.period_month) : null;
  const openPeriodCutOff = period?.cut_off_date ?? null;

  let payWindowStart: string | null = openPeriodStart;
  if (period) {
    const prevRes = await supabase
      .from('hr_pay_periods')
      .select('cut_off_date')
      .lt('period_month', period.period_month)
      .order('period_month', { ascending: false })
      .limit(1)
      .maybeSingle();
    const prev = unwrap(prevRes) as { cut_off_date: string } | null;
    if (prev?.cut_off_date) {
      const next = new Date(`${prev.cut_off_date}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      payWindowStart = next.toISOString().slice(0, 10);
    }
  }

  if (staff.length === 0) {
    return { rows: [], openPeriodCode, openPeriodStart, openPeriodCutOff, payWindowStart };
  }

  const staffIds = staff.map((s) => s.id);
  const userIds = staff.map((s) => s.user_id).filter(Boolean);

  const [profiles, statutory, comp, openComp, statIds] = await Promise.all([
    supabase.from('profiles').select('id, full_name').in('id', userIds),
    supabase
      .from('hr_pay_statutory_profiles')
      .select(
        'staff_id, employment_type, paye_applicable, nssf_applicable, lst_applicable, exemption_basis',
      )
      .in('staff_id', staffIds)
      .is('effective_to', null),
    basicComponentId().then((componentId) =>
      supabase
        .from('hr_pay_compensation')
        .select('staff_id, amount, effective_from')
        .eq('component_id', componentId)
        .in('staff_id', staffIds)
        .is('effective_to', null),
    ),
    supabase
      .from('hr_pay_compensation')
      .select(
        'staff_id, amount, component:hr_pay_components!hr_pay_compensation_component_id_fkey(code, kind, is_statutory)',
      )
      .in('staff_id', staffIds)
      .is('effective_to', null),
    supabase
      .from('hr_pay_statutory_ids')
      .select('staff_id, tin, nssf_number, lst_district')
      .in('staff_id', staffIds),
  ]);

  const nameById = new Map<string, string>(
    ((unwrap(profiles) ?? []) as { id: string; full_name: string | null }[]).map((p) => [
      p.id,
      p.full_name ?? '',
    ]),
  );
  const statutoryByStaff = new Map<string, StatutoryRow>(
    ((unwrap(statutory) ?? []) as StatutoryRow[]).map((r) => [r.staff_id, r]),
  );
  const compByStaff = new Map<string, CompRow>(
    ((unwrap(comp) ?? []) as CompRow[]).map((r) => [r.staff_id, r]),
  );
  const statIdsByStaff = new Map<string, StatutoryIdRow>(
    ((unwrap(statIds) ?? []) as StatutoryIdRow[]).map((r) => [r.staff_id, r]),
  );

  // Part-month (PRORATA) amounts that fall inside the open pay period.
  const partMonthByStaff = new Map<string, number>();
  if (openPeriodStart && openPeriodCutOff) {
    const prorataId = await prorataComponentId();
    if (prorataId) {
      const prorataRows = (unwrap(
        await supabase
          .from('hr_pay_compensation')
          .select('staff_id, amount')
          .eq('component_id', prorataId)
          .in('staff_id', staffIds)
          .lte('effective_from', openPeriodCutOff)
          .or(`effective_to.is.null,effective_to.gte.${openPeriodStart}`),
      ) ?? []) as { staff_id: string; amount: number | string }[];
      for (const r of prorataRows) {
        partMonthByStaff.set(
          r.staff_id,
          (partMonthByStaff.get(r.staff_id) ?? 0) + (Number(r.amount) || 0),
        );
      }
    }
  }

  const allowancesByStaff = new Map<string, number>();
  const deductionsByStaff = new Map<string, number>();
  for (const r of (unwrap(openComp) ?? []) as unknown as OpenCompRow[]) {
    const kind = r.component?.kind;
    const code = r.component?.code;
    const amount = Number(r.amount) || 0;
    if (kind === 'earning' && code !== 'BASIC') {
      allowancesByStaff.set(r.staff_id, (allowancesByStaff.get(r.staff_id) ?? 0) + amount);
    } else if (kind === 'deduction' && r.component?.is_statutory === false) {
      deductionsByStaff.set(r.staff_id, (deductionsByStaff.get(r.staff_id) ?? 0) + amount);
    }
  }

  const mapped = staff
    .map((s) => {
      const assignment =
        (s.assignments ?? []).find((a) => !a.ended_on && a.is_primary) ??
        (s.assignments ?? []).find((a) => !a.ended_on) ??
        null;
      const sp = statutoryByStaff.get(s.id) ?? null;
      const cp = compByStaff.get(s.id) ?? null;
      const basicAmount = cp ? Number(cp.amount) : null;
      const allowancesTotal = allowancesByStaff.get(s.id) ?? 0;
      const deductionsTotal = deductionsByStaff.get(s.id) ?? 0;
      const partMonthAmount = partMonthByStaff.get(s.id) ?? 0;
      const ids = statIdsByStaff.get(s.id) ?? null;
      return {
        staffId: s.id,
        staffRef: s.staff_ref ?? '',
        name: nameById.get(s.user_id) || s.staff_ref || s.id,
        department: assignment?.department?.name ?? '',
        position: assignment?.position?.title ?? '',
        employmentType: sp?.employment_type ?? null,
        payeApplicable: sp ? sp.paye_applicable !== false : true,
        nssfApplicable: sp ? sp.nssf_applicable !== false : true,
        lstApplicable: sp ? sp.lst_applicable !== false : true,
        exemptionBasis: sp?.exemption_basis ?? null,
        hasStatutoryProfile: Boolean(sp),
        basicAmount,
        basicEffectiveFrom: cp?.effective_from ?? null,
        allowancesTotal,
        deductionsTotal,
        partMonthAmount,
        tin: ids?.tin ?? null,
        nssfNumber: ids?.nssf_number ?? null,
        lstDistrict: ids?.lst_district ?? null,
        grossTotal: (basicAmount ?? 0) + allowancesTotal + partMonthAmount,
      } satisfies EnrollmentRow;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { rows: mapped, openPeriodCode, openPeriodStart, openPeriodCutOff, payWindowStart };
}

/**
 * Records the statutory profile through the database function. The
 * `hr_pay_statutory_profiles` table is append-only and is never written here.
 */
export async function setStatutoryProfile(
  staffId: string,
  employmentType: string,
  paye: boolean,
  nssf: boolean,
  lst: boolean,
  basis: string,
): Promise<void> {
  const res = await supabase.rpc('hr_pay_set_statutory_profile', {
    _staff_id: staffId,
    _employment_type: employmentType,
    _paye: paye,
    _nssf: nssf,
    _lst: lst,
    _basis: basis,
  });
  if (res.error) throw new Error(res.error.message);
}

/**
 * Records the filing identifiers (TIN, NSSF number, LST district) through the
 * database function. `hr_pay_statutory_ids` is never written directly here.
 * These are identity data only — they affect no payroll figure.
 */
export async function setStatutoryIds(
  staffId: string,
  tin: string | null,
  nssf: string | null,
  lstDistrict: string | null,
): Promise<void> {
  const res = await supabase.rpc('hr_pay_set_statutory_ids', {
    _staff_id: staffId,
    _tin: tin,
    _nssf: nssf,
    _lst_district: lstDistrict,
  });
  if (res.error) throw new Error(res.error.message);
}

/** Basic pay change — reuses the append-only close-then-insert in ./compensation. */
export async function setBasicPay(
  staffId: string,
  amount: number,
  effectiveFrom: string,
  reason: string,
): Promise<void> {
  const componentId = await basicComponentId();
  await addCompensation(staffId, componentId, null, amount, effectiveFrom, reason);
}

export interface StaffCompensationHistoryRow {
  id: string;
  componentCode: string;
  componentName: string;
  componentKind: string;
  gradeCode: string | null;
  amount: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  reason: string;
}

type RawHistoryRow = {
  id: string;
  amount: number | string;
  currency: string | null;
  effective_from: string;
  effective_to: string | null;
  reason: string | null;
  component: { code: string | null; name: string | null; kind: string | null } | null;
  grade: { code: string | null } | null;
};

/**
 * Every compensation record ever written for one person — open, closed and
 * superseded — with its component and pay grade. Nothing is filtered out: this
 * is the append-only audit history, ordered by component then newest first.
 */
export async function listStaffCompensation(
  staffId: string,
): Promise<StaffCompensationHistoryRow[]> {
  const res = await supabase
    .from('hr_pay_compensation')
    .select(
      'id, amount, currency, effective_from, effective_to, reason, component:hr_pay_components!hr_pay_compensation_component_id_fkey(code, name, kind), grade:hr_pay_grades!hr_pay_compensation_grade_id_fkey(code)',
    )
    .eq('staff_id', staffId)
    .order('effective_from', { ascending: false });

  const rows = (unwrap(res) ?? []) as unknown as RawHistoryRow[];
  return rows
    .map((r) => ({
      id: r.id,
      componentCode: r.component?.code ?? '',
      componentName: r.component?.name ?? '',
      componentKind: r.component?.kind ?? '',
      gradeCode: r.grade?.code ?? null,
      amount: Number(r.amount) || 0,
      currency: r.currency ?? 'UGX',
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to,
      reason: r.reason ?? '',
    }))
    .sort((a, b) => {
      const byCode = a.componentCode.localeCompare(b.componentCode);
      if (byCode !== 0) return byCode;
      // Newest effective date first inside each component.
      return b.effectiveFrom.localeCompare(a.effectiveFrom);
    });
}

export interface GradeOption {
  id: string;
  code: string;
  name: string;
}

/** Active pay grades, for tagging a compensation record with its grade. */
export async function listGradeOptions(): Promise<GradeOption[]> {
  const res = await supabase
    .from('hr_pay_grades')
    .select('id, code, name')
    .eq('active', true)
    .order('code', { ascending: true });
  const rows = (unwrap(res) ?? []) as { id: string; code: string | null; name: string | null }[];
  return rows.map((r) => ({ id: r.id, code: r.code ?? '', name: r.name ?? '' }));
}