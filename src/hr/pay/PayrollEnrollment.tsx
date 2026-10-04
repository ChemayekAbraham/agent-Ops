import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Loader2, Printer } from 'lucide-react';
import { toast } from 'sonner';
import '@/hr/pay/print.css';
import { WELILE_LOGO } from '@/hr/pay/letterheadLogo';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  listEnrollment,
  listGradeOptions,
  listStaffCompensation,
  setBasicPay,
  setStatutoryProfile,
  setStatutoryIds,
  type EnrollmentRow,
  type GradeOption,
  type StaffCompensationHistoryRow,
} from '@/hr/pay/api/enrollment';
import { listComponents, type PayComponentRow } from '@/hr/pay/api/config';
import { listAdvances, type AdvanceRow } from '@/hr/pay/api/advances';
import {
  addCompensation,
  addPartMonthPay,
  listCompensation,
  type CompensationRow,
} from '@/hr/pay/api/compensation';

const EMPLOYMENT_TYPES = ['employee', 'consultant', 'casual', 'expatriate', 'director'];

function formatAmount(value: number): string {
  return new Intl.NumberFormat('en-UG', { maximumFractionDigits: 0 }).format(value);
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Raw database / network error, verbatim. Never a generic phrase. */
function rawError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object') {
    const msg = (error as { message?: unknown }).message;
    if (typeof msg === 'string' && msg) return msg;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

const EFFECTIVE_FROM_HELP =
  "The month this amount starts. To include someone in a payroll run, this date must be on or before the last day of that run's period.";
const NO_OPEN_PERIOD = 'Open a pay period first.';

function isReady(row: EnrollmentRow): boolean {
  return (row.basicAmount !== null || row.partMonthAmount > 0) && row.hasStatutoryProfile;
}

/** Part-month pay for this period, but the salary record only starts later. */
function joinsNextPeriod(row: EnrollmentRow, openPeriodCutOff: string | null): boolean {
  return (
    row.partMonthAmount > 0 &&
    openPeriodCutOff !== null &&
    row.basicEffectiveFrom !== null &&
    row.basicEffectiveFrom > openPeriodCutOff
  );
}

const BOTH_APPLY_WARNING =
  'Basic pay and part-month pay both apply this period. Only part-month pay will be paid. Set the basic pay effective date to the following month.';

/** Both basic pay and part-month pay land in the open period. */
function bothApply(row: EnrollmentRow, openPeriodCutOff: string | null): boolean {
  return (
    row.partMonthAmount > 0 &&
    row.basicAmount !== null &&
    row.basicAmount > 0 &&
    !joinsNextPeriod(row, openPeriodCutOff)
  );
}

/** Monday–Friday days from `from` to `to`, both inclusive (YYYY-MM-DD). */
function weekdaysBetween(from: string, to: string): number {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return 0;
  let count = 0;
  for (const day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    const dow = day.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

/** First and last calendar day of the month containing `isoDate`. */
function monthBounds(isoDate: string): { first: string; last: string } {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  return { first: `${year}-${mm}-01`, last: `${year}-${mm}-${String(lastDay).padStart(2, '0')}` };
}

type PartMonthCalc =
  | { ok: true; worked: number; inMonth: number; amount: number }
  | { ok: false; message: string };

/**
 * Part-month pay by Monday–Friday working days: basic × days worked ÷ working
 * days in the pay period (the day after the previous cut-off to this cut-off,
 * e.g. 29 Aug – 28 Sep). Public holidays count as paid working days.
 */
function partMonthCalc(
  basic: number | null,
  start: string,
  end: string,
  monthFirst: string,
  monthLast: string,
): PartMonthCalc {
  if (basic === null || basic <= 0) {
    return { ok: false, message: 'Set this person’s basic pay first — the amount is worked out from it.' };
  }
  if (!start) return { ok: false, message: 'Pick the first day they worked.' };
  if (!end) return { ok: false, message: 'Pick the last day they worked.' };
  if (start < monthFirst || start > monthLast || end < monthFirst || end > monthLast) {
    return {
      ok: false,
      message: `Both dates must fall between ${formatDate(monthFirst)} and ${formatDate(monthLast)}.`,
    };
  }
  if (start > end) return { ok: false, message: 'The first day cannot be after the last day.' };
  const inMonth = weekdaysBetween(monthFirst, monthLast);
  const worked = weekdaysBetween(start, end);
  if (worked === 0) {
    return { ok: false, message: 'Those dates contain no working day (Monday to Friday).' };
  }
  return { ok: true, worked, inMonth, amount: Math.round((basic * worked) / inMonth) };
}

export default function PayrollEnrollment() {
  const [rows, setRows] = useState<EnrollmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [periodCode, setPeriodCode] = useState<string | null>(null);
  const [periodStart, setPeriodStart] = useState<string | null>(null);
  const [periodCutOff, setPeriodCutOff] = useState<string | null>(null);
  const [periodWindowStart, setPeriodWindowStart] = useState<string | null>(null);
  const [advances, setAdvances] = useState<AdvanceRow[]>([]);

  // Part-month pay dialog state
  const [pmRow, setPmRow] = useState<EnrollmentRow | null>(null);
  const [pmAmount, setPmAmount] = useState('');
  const [pmReason, setPmReason] = useState('');
  const [pmError, setPmError] = useState('');
  const [pmStart, setPmStart] = useState('');
  const [pmEnd, setPmEnd] = useState('');

  // Statutory dialog state
  const [statRow, setStatRow] = useState<EnrollmentRow | null>(null);
  const [statType, setStatType] = useState('employee');
  const [statPaye, setStatPaye] = useState(true);
  const [statNssf, setStatNssf] = useState(true);
  const [statLst, setStatLst] = useState(true);
  const [statBasis, setStatBasis] = useState('');
  const [statError, setStatError] = useState('');

  // Statutory identifiers dialog state (identity data only)
  const [idsRow, setIdsRow] = useState<EnrollmentRow | null>(null);
  const [idsTin, setIdsTin] = useState('');
  const [idsNssf, setIdsNssf] = useState('');
  const [idsLst, setIdsLst] = useState('');
  const [idsError, setIdsError] = useState('');

  // Basic pay dialog state
  const [payRow, setPayRow] = useState<EnrollmentRow | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payFrom, setPayFrom] = useState('');
  const [payReason, setPayReason] = useState('');
  const [payError, setPayError] = useState('');

  // Deductions dialog state
  const [dedRow, setDedRow] = useState<EnrollmentRow | null>(null);
  const [dedRecords, setDedRecords] = useState<CompensationRow[]>([]);
  const [dedLoading, setDedLoading] = useState(false);
  const [components, setComponents] = useState<PayComponentRow[]>([]);
  const [dedComponentId, setDedComponentId] = useState('');
  const [dedAmount, setDedAmount] = useState('');
  const [dedFrom, setDedFrom] = useState('');
  const [dedReason, setDedReason] = useState('');
  const [dedError, setDedError] = useState('');

  // Allowances dialog state
  const [allowRow, setAllowRow] = useState<EnrollmentRow | null>(null);
  const [allowRecords, setAllowRecords] = useState<CompensationRow[]>([]);
  const [allowLoading, setAllowLoading] = useState(false);
  const [allowComponentId, setAllowComponentId] = useState('');
  const [allowGradeId, setAllowGradeId] = useState('');
  const [allowAmount, setAllowAmount] = useState('');
  const [allowFrom, setAllowFrom] = useState('');
  const [allowReason, setAllowReason] = useState('');
  const [allowError, setAllowError] = useState('');
  const [grades, setGrades] = useState<GradeOption[]>([]);

  // Compensation history dialog state
  const [histRow, setHistRow] = useState<EnrollmentRow | null>(null);
  const [histRecords, setHistRecords] = useState<StaffCompensationHistoryRow[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const [histError, setHistError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listEnrollment();
      setRows(result.rows);
      setPeriodCode(result.openPeriodCode);
      setPeriodStart(result.openPeriodStart);
      setPeriodCutOff(result.openPeriodCutOff);
      setPeriodWindowStart(result.payWindowStart);
      try {
        setAdvances(await listAdvances());
      } catch (advanceError) {
        setAdvances([]);
        toast.error(`Advances could not be loaded: ${rawError(advanceError)}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load enrollment');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void listComponents()
      .then(setComponents)
      .catch(() => setComponents([]));
  }, []);

  useEffect(() => {
    void listGradeOptions()
      .then(setGrades)
      .catch(() => setGrades([]));
  }, []);

  const deductionComponents = useMemo(
    () => components.filter((c) => c.active && c.kind === 'deduction' && !c.is_statutory),
    [components],
  );

  // Basic pay and part-month pay have their own dialogs, so they never appear here.
  const allowanceComponents = useMemo(
    () =>
      components.filter(
        (c) => c.active && c.kind === 'earning' && c.code !== 'BASIC' && c.code !== 'PRORATA',
      ),
    [components],
  );

  const counts = useMemo(() => {
    const ready = rows.filter(isReady).length;
    return { total: rows.length, ready, incomplete: rows.length - ready };
  }, [rows]);

  const idsComplete = useMemo(
    () => rows.filter((r) => Boolean(r.tin) && Boolean(r.nssfNumber) && Boolean(r.lstDistrict)).length,
    [rows],
  );
  const statutoryCoverage = useMemo(
    () => ({
      paye: rows.filter((r) => r.payeApplicable).length,
      nssf: rows.filter((r) => r.nssfApplicable).length,
      lst: rows.filter((r) => r.lstApplicable).length,
    }),
    [rows],
  );

  /** What the next run will recover from each person's advances. Same rule as
   *  hr_pay_advance_due: only an approved, disbursed advance whose first
   *  recovery date has arrived is deducted, capped at what is still owed. */
  const advanceByStaff = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const byStaff = new Map<
      string,
      { next: number; remaining: number; notDisbursed: boolean; startsOn: string | null }
    >();
    for (const a of advances) {
      if (!['hr_approved', 'ceo_approved', 'approved'].includes(a.status)) continue;
      const remaining = Math.max(0, a.principal - a.recovered);
      if (remaining <= 0) continue;
      const disbursed = a.status === 'approved' && a.disbursed_at !== null;
      const started = a.first_recovery_on <= today;
      const gross = rows.find((r) => r.staffId === a.staff_id)?.grossTotal ?? 0;
      const perRun =
        a.recovery_mode === 'fixed'
          ? a.recovery_value
          : Math.round((gross * a.recovery_value) / 100);
      const next = disbursed && started ? Math.min(perRun, remaining) : 0;
      const held = byStaff.get(a.staff_id) ?? {
        next: 0,
        remaining: 0,
        notDisbursed: false,
        startsOn: null,
      };
      byStaff.set(a.staff_id, {
        next: held.next + next,
        remaining: held.remaining + remaining,
        notDisbursed: held.notDisbursed || !disbursed,
        startsOn: disbursed && !started ? a.first_recovery_on : held.startsOn,
      });
    }
    return byStaff;
  }, [advances, rows]);

  const advanceTotal = useMemo(
    () => rows.reduce((sum, r) => sum + (advanceByStaff.get(r.staffId)?.next ?? 0), 0),
    [rows, advanceByStaff],
  );

  /** Staff grouped by department, alphabetically, unassigned last. */
  const groups = useMemo(() => {
    const NONE = 'No department';
    const byDept = new Map<string, EnrollmentRow[]>();
    for (const row of rows) {
      const key = row.department || NONE;
      const list = byDept.get(key) ?? [];
      list.push(row);
      byDept.set(key, list);
    }
    return Array.from(byDept.entries())
      .sort(([a], [b]) => {
        if (a === NONE) return 1;
        if (b === NONE) return -1;
        return a.localeCompare(b);
      })
      .map(([department, groupRows]) => ({
        department,
        rows: groupRows,
        basic: groupRows.reduce((sum, r) => sum + (r.basicAmount ?? 0), 0),
        partMonth: groupRows.reduce((sum, r) => sum + r.partMonthAmount, 0),
        allowances: groupRows.reduce((sum, r) => sum + r.allowancesTotal, 0),
        deductions: groupRows.reduce((sum, r) => sum + r.deductionsTotal, 0),
        gross: groupRows.reduce((sum, r) => sum + r.grossTotal, 0),
        advance: groupRows.reduce(
          (sum, r) => sum + (advanceByStaff.get(r.staffId)?.next ?? 0),
          0,
        ),
      }));
  }, [rows, advanceByStaff]);

  const bothApplyCount = useMemo(
    () => rows.filter((r) => bothApply(r, periodCutOff)).length,
    [rows, periodCutOff],
  );

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          basic: acc.basic + (r.basicAmount ?? 0),
          partMonth: acc.partMonth + r.partMonthAmount,
          allowances: acc.allowances + r.allowancesTotal,
          deductions: acc.deductions + r.deductionsTotal,
          gross: acc.gross + r.grossTotal,
          people: acc.people + 1,
        }),
        { basic: 0, partMonth: 0, allowances: 0, deductions: 0, gross: 0, people: 0 },
      ),
    [rows],
  );

  /** The pay period: day after the previous cut-off, to this period's cut-off. */
  const pmBounds = periodCutOff
    ? { first: periodWindowStart ?? monthBounds(periodCutOff).first, last: periodCutOff }
    : null;

  function openPartMonth(row: EnrollmentRow) {
    setPmRow(row);
    setPmAmount(row.partMonthAmount > 0 ? String(row.partMonthAmount) : '');
    setPmReason('');
    setPmError('');
    setPmStart('');
    setPmEnd(periodCutOff ?? '');
  }

  /** Fill the amount and the reason from the dates. The amount stays editable. */
  function recalcPartMonth(start: string, end: string) {
    if (!pmRow || !pmBounds) return;
    const calc = partMonthCalc(pmRow.basicAmount, start, end, pmBounds.first, pmBounds.last);
    if (!calc.ok) return;
    setPmAmount(String(calc.amount));
    setPmReason(
      `First day ${formatDate(start)}, last day ${formatDate(end)}. ` +
        `${calc.worked} of ${calc.inMonth} working days (Mon–Fri). ` +
        `${formatAmount(pmRow.basicAmount ?? 0)} × ${calc.worked} ÷ ${calc.inMonth} = ${formatAmount(calc.amount)}.`,
    );
  }

  async function savePartMonth() {
    if (!pmRow || !periodStart || !periodCutOff) return;
    const amount = Number(pmAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setPmError('Enter a valid amount.');
      return;
    }
    if (pmReason.trim().length < 10) {
      setPmError('The reason must be at least 10 characters.');
      return;
    }
    setSaving(true);
    try {
      await addPartMonthPay(pmRow.staffId, amount, periodStart, periodCutOff, pmReason.trim());
      toast.success('Part-month pay recorded');
      await load();
      setPmRow(null);
    } catch (error) {
      setPmError(rawError(error));
    } finally {
      setSaving(false);
    }
  }

  async function openDeductions(row: EnrollmentRow) {
    setDedRow(row);
    setDedRecords([]);
    setDedComponentId('');
    setDedAmount('');
    setDedFrom(periodStart ?? '');
    setDedReason('');
    setDedError('');
    setDedLoading(true);
    try {
      const records = await listCompensation(row.staffId);
      setDedRecords(
        records.filter((r) => r.effective_to === null && r.component_kind === 'deduction'),
      );
    } catch (error) {
      setDedError(rawError(error));
    } finally {
      setDedLoading(false);
    }
  }

  async function saveDeduction() {
    if (!dedRow) return;
    const amount = Number(dedAmount);
    if (!dedComponentId) {
      setDedError('Pick the deduction component.');
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setDedError('Enter a valid amount.');
      return;
    }
    if (!dedFrom) {
      setDedError(periodStart ? 'An effective-from date is required.' : NO_OPEN_PERIOD);
      return;
    }
    if (dedReason.trim().length < 10) {
      setDedError('The reason must be at least 10 characters.');
      return;
    }
    setSaving(true);
    try {
      await addCompensation(
        dedRow.staffId,
        dedComponentId,
        null,
        amount,
        dedFrom,
        dedReason.trim(),
      );
      toast.success('Deduction recorded');
      await load();
      setDedRow(null);
    } catch (error) {
      setDedError(rawError(error));
    } finally {
      setSaving(false);
    }
  }

  function printSheet() {
    setReveal(true);
    setTimeout(() => window.print(), 50);
  }

  async function openAllowances(row: EnrollmentRow) {
    setAllowRow(row);
    setAllowRecords([]);
    setAllowComponentId('');
    setAllowGradeId('');
    setAllowAmount('');
    setAllowFrom(periodStart ?? '');
    setAllowReason('');
    setAllowError('');
    setAllowLoading(true);
    try {
      const records = await listCompensation(row.staffId);
      setAllowRecords(
        records.filter(
          (r) =>
            r.effective_to === null &&
            r.component_kind === 'earning' &&
            r.component_code !== 'BASIC' &&
            r.component_code !== 'PRORATA',
        ),
      );
    } catch (error) {
      setAllowError(rawError(error));
    } finally {
      setAllowLoading(false);
    }
  }

  async function saveAllowance() {
    if (!allowRow) return;
    const amount = Number(allowAmount);
    if (!allowComponentId) {
      setAllowError('Pick the earning component.');
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setAllowError('Enter a valid amount.');
      return;
    }
    if (!allowFrom) {
      setAllowError(periodStart ? 'An effective-from date is required.' : NO_OPEN_PERIOD);
      return;
    }
    if (allowReason.trim().length < 10) {
      setAllowError('The reason must be at least 10 characters.');
      return;
    }
    setSaving(true);
    try {
      await addCompensation(
        allowRow.staffId,
        allowComponentId,
        allowGradeId || null,
        amount,
        allowFrom,
        allowReason.trim(),
      );
      toast.success('Earning recorded');
      await load();
      setAllowRow(null);
    } catch (error) {
      setAllowError(rawError(error));
    } finally {
      setSaving(false);
    }
  }

  async function openHistory(row: EnrollmentRow) {
    setHistRow(row);
    setHistRecords([]);
    setHistError('');
    setHistLoading(true);
    try {
      setHistRecords(await listStaffCompensation(row.staffId));
    } catch (error) {
      setHistError(rawError(error));
    } finally {
      setHistLoading(false);
    }
  }

  function openStatutory(row: EnrollmentRow, next: { paye: boolean; nssf: boolean; lst: boolean }) {
    setStatRow(row);
    setStatType(row.employmentType ?? 'employee');
    setStatPaye(next.paye);
    setStatNssf(next.nssf);
    setStatLst(next.lst);
    setStatBasis(row.exemptionBasis ?? '');
    setStatError('');
  }

  /** A tick change: all three on saves straight away, any off asks for the basis. */
  async function onToggleStatutory(
    row: EnrollmentRow,
    field: 'paye' | 'nssf' | 'lst',
    value: boolean,
  ) {
    const next = {
      paye: field === 'paye' ? value : row.payeApplicable,
      nssf: field === 'nssf' ? value : row.nssfApplicable,
      lst: field === 'lst' ? value : row.lstApplicable,
    };
    if (next.paye && next.nssf && next.lst) {
      setSaving(true);
      try {
        await setStatutoryProfile(row.staffId, row.employmentType ?? 'employee', true, true, true, '');
        toast.success('All statutory deductions apply');
        await load();
      } catch (error) {
        toast.error(rawError(error));
      } finally {
        setSaving(false);
      }
      return;
    }
    openStatutory(row, next);
  }

  async function saveStatutory() {
    if (!statRow) return;
    const allOn = statPaye && statNssf && statLst;
    const basis = statBasis.trim();
    if (!allOn && basis.length < 10) {
      setStatError('The basis must be at least 10 characters.');
      return;
    }
    setSaving(true);
    try {
      await setStatutoryProfile(statRow.staffId, statType, statPaye, statNssf, statLst, allOn ? '' : basis);
      toast.success('Statutory profile recorded');
      await load();
      setStatRow(null);
    } catch (error) {
      setStatError(rawError(error));
    } finally {
      setSaving(false);
    }
  }

  function openPay(row: EnrollmentRow) {
    setPayRow(row);
    setPayAmount(row.basicAmount !== null ? String(row.basicAmount) : '');
    setPayFrom(periodStart ?? '');
    setPayReason('');
    setPayError('');
  }

  function openIds(row: EnrollmentRow) {
    setIdsRow(row);
    setIdsTin(row.tin ?? '');
    setIdsNssf(row.nssfNumber ?? '');
    setIdsLst(row.lstDistrict ?? '');
    setIdsError('');
  }

  async function saveIds() {
    if (!idsRow) return;
    setSaving(true);
    try {
      await setStatutoryIds(
        idsRow.staffId,
        idsTin.trim() || null,
        idsNssf.trim() || null,
        idsLst.trim() || null,
      );
      toast.success('Statutory identifiers recorded');
      await load();
      setIdsRow(null);
    } catch (error) {
      setIdsError(rawError(error));
    } finally {
      setSaving(false);
    }
  }

  async function savePay() {
    if (!payRow) return;
    const amount = Number(payAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setPayError('Enter a valid amount.');
      return;
    }
    if (!payFrom) {
      setPayError(periodStart ? 'An effective-from date is required.' : NO_OPEN_PERIOD);
      return;
    }
    if (payReason.trim().length < 10) {
      setPayError('The reason must be at least 10 characters.');
      return;
    }
    setSaving(true);
    try {
      await setBasicPay(payRow.staffId, amount, payFrom, payReason.trim());
      toast.success('Basic pay recorded');
      await load();
      setPayRow(null);
    } catch (error) {
      setPayError(rawError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="print-root mx-auto w-full max-w-7xl space-y-6 p-4 md:p-6">
      <div className="hidden print:block">
        <div className="print-letterhead">
          <div>
            <img src={WELILE_LOGO} alt="Welile" className="print-logo" />
            <p className="print-values">Hope · Faith · Love</p>
          </div>
          <div className="print-company">
            <p className="font-semibold">Welile Technologies Ltd</p>
            <p>P.O. Box 167564, Kampala-Uganda</p>
            <p>weliletechnologies@gmail.com</p>
            <p>+256 744475573 / +256 764379713</p>
          </div>
        </div>
        <div className="print-title">
          <h2>Payroll enrollment sheet</h2>
          <p>
            {periodCode ? `Open period ${periodCode} · ` : ''}
            Generated {new Date().toLocaleDateString('en-GB')} · Prepared for review, not a
            payroll run
          </p>
        </div>
        <div className="print-summary">
          <span>
            <strong>{counts.total}</strong> active workers
          </span>
          <span>
            <strong>{counts.ready}</strong> ready
          </span>
          <span>
            <strong>{counts.incomplete}</strong> incomplete
          </span>
          <span>
            Total monthly gross <strong>UGX {formatAmount(totals.gross)}</strong>
          </span>
        </div>
      </div>
      <div className="no-print flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Payroll enrollment</h1>
          <p className="text-sm text-muted-foreground">
            Every active worker, their basic pay, and which statutory deductions apply.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch id="reveal-amounts" checked={reveal} onCheckedChange={setReveal} />
            <Label htmlFor="reveal-amounts" className="text-sm">
              Reveal amounts
            </Label>
          </div>
          <Button variant="outline" size="sm" className="no-print" onClick={printSheet}>
            <Printer className="mr-2 h-4 w-4" />
            Print enrollment sheet
          </Button>
        </div>
      </div>

      <div className="no-print grid gap-3 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase text-muted-foreground">
              Total active workers
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{counts.total}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase text-muted-foreground">Ready</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold text-emerald-600">
            {counts.ready}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase text-muted-foreground">Incomplete</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold text-amber-600">
            {counts.incomplete}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase text-muted-foreground">
              Total monthly gross
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {reveal ? `UGX ${formatAmount(totals.gross)}` : '••••••'}
          </CardContent>
        </Card>
      </div>

      <p
        className={
          idsComplete < counts.total
            ? 'no-print text-sm font-medium text-amber-600'
            : 'no-print text-sm font-medium text-muted-foreground'
        }
      >
        Statutory IDs complete: {idsComplete} of {counts.total}
      </p>

      {bothApplyCount > 0 ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            {bothApplyCount} staff have both basic pay and part-month pay in this period. Only
            part-month pay will be paid for them.
          </p>
        </div>
      ) : null}

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading enrollment…
            </div>
          ) : (
            <div className="overflow-x-auto print:overflow-visible">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Staff ref</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="print-collapse">Department</TableHead>
                    <TableHead>Position</TableHead>
                    <TableHead>Employment type</TableHead>
                    <TableHead className="text-right">Basic pay</TableHead>
                    <TableHead className="text-right">Part-month</TableHead>
                    <TableHead className="text-right">Allowances</TableHead>
                    <TableHead className="text-right">Deductions</TableHead>
                    <TableHead className="text-right">Advance recovery</TableHead>
                    <TableHead className="text-right">Gross on record</TableHead>
                    <TableHead>Effective from</TableHead>
                    <TableHead className="print-hide">PAYE</TableHead>
                    <TableHead className="print-hide">NSSF</TableHead>
                    <TableHead className="print-hide">LST</TableHead>
                    <TableHead className="print-hide">Basis</TableHead>
                    <TableHead className="print-hide">Statutory IDs</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={18} className="p-6 text-sm text-muted-foreground">
                        No active staff members.
                      </TableCell>
                    </TableRow>
                  ) : (
                    groups.map((group) => (
                      <Fragment key={group.department}>
                        <TableRow className="dept-header bg-muted/60 hover:bg-muted/60">
                          <TableCell colSpan={12} className="text-sm font-semibold">
                            {group.department}
                            <span className="ml-2 text-xs font-normal text-muted-foreground">
                              {group.rows.length} {group.rows.length === 1 ? 'person' : 'people'}
                            </span>
                          </TableCell>
                          <TableCell className="print-hide" />
                          <TableCell className="print-hide" />
                          <TableCell className="print-hide" />
                          <TableCell className="print-hide" />
                          <TableCell className="print-hide" />
                          <TableCell />
                        </TableRow>
                        {group.rows.map((row) => (
                      <TableRow
                        key={row.staffId}
                        className={bothApply(row, periodCutOff) ? 'bg-amber-50' : undefined}
                      >
                        <TableCell className="font-mono text-xs">{row.staffRef || '—'}</TableCell>
                        <TableCell className="font-medium">{row.name}</TableCell>
                        <TableCell className="print-collapse">{row.department || '—'}</TableCell>
                        <TableCell>{row.position || '—'}</TableCell>
                        <TableCell>
                          <span className="hidden text-xs print:inline">
                            {row.employmentType ?? 'employee'}
                          </span>
                          <Select
                            value={row.employmentType ?? 'employee'}
                            onValueChange={(value) =>
                              void setStatutoryProfile(
                                row.staffId,
                                value,
                                row.payeApplicable,
                                row.nssfApplicable,
                                row.lstApplicable,
                                row.exemptionBasis ?? '',
                              )
                                .then(() => {
                                  toast.success('Employment type recorded');
                                  return load();
                                })
                                .catch((error: unknown) =>
                                  toast.error(
                                    error instanceof Error ? error.message : 'Could not save',
                                  ),
                                )
                            }
                          >
                            <SelectTrigger className="h-8 w-[140px] text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {EMPLOYMENT_TYPES.map((type) => (
                                <SelectItem key={type} value={type}>
                                  {type}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell className="text-right">
                          {row.basicAmount === null ? (
                            <>
                              <button
                                type="button"
                                onClick={() => openPay(row)}
                                className="text-xs font-medium text-destructive/70 underline-offset-2 hover:underline"
                              >
                                not set
                              </button>
                              <span className="hidden text-xs print:inline">not set</span>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => openPay(row)}
                                className="font-mono text-sm tabular-nums underline-offset-2 hover:underline"
                              >
                                {reveal ? `UGX ${formatAmount(row.basicAmount)}` : '••••••'}
                              </button>
                              <span className="hidden font-mono text-sm tabular-nums print:inline">
                                {reveal ? formatAmount(row.basicAmount) : '••••••'}
                              </span>
                            </>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <button
                            type="button"
                            onClick={() => openPartMonth(row)}
                            className="font-mono text-sm tabular-nums underline-offset-2 hover:underline"
                          >
                            {row.partMonthAmount === 0
                              ? '—'
                              : reveal
                                ? formatAmount(row.partMonthAmount)
                                : '••••••'}
                          </button>
                          <span className="hidden font-mono text-sm tabular-nums print:inline">
                            {row.partMonthAmount === 0
                              ? '—'
                              : reveal
                                ? formatAmount(row.partMonthAmount)
                                : '••••••'}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <button
                            type="button"
                            onClick={() => void openAllowances(row)}
                            className="font-mono text-sm tabular-nums underline-offset-2 hover:underline"
                          >
                            {reveal ? formatAmount(row.allowancesTotal) : '••••••'}
                          </button>
                          <span className="hidden font-mono text-sm tabular-nums print:inline">
                            {reveal ? formatAmount(row.allowancesTotal) : '••••••'}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <button
                            type="button"
                            onClick={() => void openDeductions(row)}
                            className="font-mono text-sm tabular-nums underline-offset-2 hover:underline"
                          >
                            {reveal ? formatAmount(row.deductionsTotal) : '••••••'}
                          </button>
                          <span className="hidden font-mono text-sm tabular-nums print:inline">
                            {reveal ? formatAmount(row.deductionsTotal) : '••••••'}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          {(() => {
                            const adv = advanceByStaff.get(row.staffId);
                            if (!adv) return <span className="text-muted-foreground">—</span>;
                            return (
                              <>
                                <span className="font-mono text-sm tabular-nums">
                                  {adv.next > 0
                                    ? reveal
                                      ? formatAmount(adv.next)
                                      : '••••••'
                                    : '—'}
                                </span>
                                <p className="text-[11px] text-muted-foreground">
                                  {adv.next > 0
                                    ? `Owed ${reveal ? formatAmount(adv.remaining) : '••••'}`
                                    : adv.notDisbursed
                                      ? 'Not disbursed'
                                      : `Starts ${formatDate(adv.startsOn)}`}
                                </p>
                              </>
                            );
                          })()}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">
                          {reveal ? formatAmount(row.grossTotal) : '••••••'}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDate(row.basicEffectiveFrom)}
                        </TableCell>
                        <TableCell className="print-hide">
                          <Checkbox
                            checked={row.payeApplicable}
                            onCheckedChange={(value) =>
                              void onToggleStatutory(row, 'paye', value === true)
                            }
                          />
                        </TableCell>
                        <TableCell className="print-hide">
                          <Checkbox
                            checked={row.nssfApplicable}
                            onCheckedChange={(value) =>
                              void onToggleStatutory(row, 'nssf', value === true)
                            }
                          />
                        </TableCell>
                        <TableCell className="print-hide">
                          <Checkbox
                            checked={row.lstApplicable}
                            onCheckedChange={(value) =>
                              void onToggleStatutory(row, 'lst', value === true)
                            }
                          />
                        </TableCell>
                        <TableCell
                          className="print-hide max-w-[180px] truncate text-xs text-muted-foreground"
                          title={row.exemptionBasis ?? ''}
                        >
                          {row.exemptionBasis || '—'}
                        </TableCell>
                        <TableCell
                          className="print-hide cursor-pointer"
                          onClick={() => openIds(row)}
                          title="Statutory identifiers"
                        >
                          <div className="flex items-center gap-2 text-[11px]">
                            {(
                              [
                                ['TIN', row.tin],
                                ['NSSF', row.nssfNumber],
                                ['LST', row.lstDistrict],
                              ] as const
                            ).map(([label, value]) => (
                              <span key={label} className="inline-flex items-center gap-0.5">
                                <span className="text-muted-foreground">{label}</span>
                                {value ? (
                                  <Check
                                    className="h-3.5 w-3.5 text-emerald-600"
                                    aria-label={`${label} present`}
                                  />
                                ) : (
                                  <span
                                    className="text-destructive/70"
                                    aria-label={`${label} missing`}
                                  >
                                    –
                                  </span>
                                )}
                              </span>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell>
                          {isReady(row) ? (
                            <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                              Ready
                            </span>
                          ) : (
                            <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                              Incomplete
                            </span>
                          )}
                          {joinsNextPeriod(row, periodCutOff) ? (
                            <p className="mt-1 text-[11px] text-muted-foreground">
                              Joins next period
                            </p>
                          ) : null}
                          {bothApply(row, periodCutOff) ? (
                            <span className="mt-1 inline-flex" title={BOTH_APPLY_WARNING}>
                              <AlertTriangle
                                className="h-4 w-4 text-amber-600"
                                aria-label={BOTH_APPLY_WARNING}
                              />
                            </span>
                          ) : null}
                          <div className="no-print mt-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-1 text-[11px] text-muted-foreground"
                              onClick={() => void openHistory(row)}
                            >
                              History
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                        ))}
                        <TableRow className="dept-subtotal bg-muted/30 font-medium hover:bg-muted/30">
                          <TableCell colSpan={5}>
                            {group.department} subtotal · {group.rows.length}{' '}
                            {group.rows.length === 1 ? 'person' : 'people'}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {reveal ? formatAmount(group.basic) : '••••••'}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {reveal ? formatAmount(group.partMonth) : '••••••'}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {reveal ? formatAmount(group.allowances) : '••••••'}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {reveal ? formatAmount(group.deductions) : '••••••'}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {reveal ? formatAmount(group.advance) : '••••••'}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {reveal ? formatAmount(group.gross) : '••••••'}
                          </TableCell>
                          <TableCell />
                          <TableCell className="print-hide" />
                          <TableCell className="print-hide" />
                          <TableCell className="print-hide" />
                          <TableCell className="print-hide" />
                          <TableCell className="print-hide" />
                          <TableCell />
                        </TableRow>
                      </Fragment>
                    ))
                  )}
                </TableBody>
                <TableFooter className="sticky bottom-0 border-t-2 bg-muted print:static">
                  <TableRow className="font-semibold hover:bg-transparent">
                    <TableCell colSpan={5}>{totals.people} people included</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {reveal ? formatAmount(totals.basic) : '••••••'}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {reveal ? formatAmount(totals.partMonth) : '••••••'}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {reveal ? formatAmount(totals.allowances) : '••••••'}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {reveal ? formatAmount(totals.deductions) : '••••••'}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {reveal ? formatAmount(advanceTotal) : '••••••'}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {reveal ? formatAmount(totals.gross) : '••••••'}
                    </TableCell>
                    <TableCell />
                    <TableCell className="print-hide" />
                    <TableCell className="print-hide" />
                    <TableCell className="print-hide" />
                    <TableCell className="print-hide" />
                    <TableCell className="print-hide" />
                    <TableCell />
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="no-print text-xs text-muted-foreground">Gross on record is everything currently recorded for this person. Where part-month pay applies, it replaces basic salary in the payroll calculation, so the amount paid will be lower than the figure shown here. The payslip is the authority.</p>

      <div className="print-statutory hidden print:block">
        <h3>Statutory position</h3>
        <div className="print-statutory-grid">
          <div>
            <p>
              PAYE applies to <strong>{statutoryCoverage.paye}</strong> of {counts.total} — not
              applied to <strong>{counts.total - statutoryCoverage.paye}</strong>
            </p>
            <p>
              NSSF applies to <strong>{statutoryCoverage.nssf}</strong> of {counts.total} — not
              applied to <strong>{counts.total - statutoryCoverage.nssf}</strong>
            </p>
            <p>
              LST applies to <strong>{statutoryCoverage.lst}</strong> of {counts.total} — not
              applied to <strong>{counts.total - statutoryCoverage.lst}</strong>
            </p>
          </div>
          <div>
            <p>
              Statutory identifiers complete: <strong>{idsComplete}</strong> of {counts.total}
            </p>
            <p>
              Missing an identifier: <strong>{counts.total - idsComplete}</strong>
            </p>
            <p>
              Total monthly gross on record: <strong>UGX {formatAmount(totals.gross)}</strong>
            </p>
          </div>
        </div>
        <p className="print-note">
          This sheet records what is payable and which statutory deductions apply. It carries no
          PAYE, NSSF or LST amounts — those are computed on a payroll run and appear on that
          run&apos;s register and statutory returns. Where part-month pay applies it replaces basic
          salary in the calculation, so the amount paid will be lower than the gross shown here.
        </p>
      </div>
      <div className="print-signoff hidden print:block print:mt-10">
        <div className="flex gap-16">
          <div className="flex-1">
            <div className="mt-8 border-t border-black" />
            <p className="text-xs">Prepared by</p>
            <div className="mt-6 border-t border-black" />
            <p className="text-xs">Date</p>
          </div>
          <div className="flex-1">
            <div className="mt-8 border-t border-black" />
            <p className="text-xs">Reviewed by</p>
            <div className="mt-6 border-t border-black" />
            <p className="text-xs">Date</p>
          </div>
        </div>
      </div>

      <p className="no-print text-xs text-muted-foreground">
        Statutory profiles and compensation are both append-only. Every change keeps the previous
        record with the date it closed.
      </p>

      <Dialog open={idsRow !== null} onOpenChange={(open) => !open && setIdsRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Statutory identifiers</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              These appear on filed URA and NSSF returns. They do not affect any payroll figure.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="ids-tin">TIN</Label>
              <Input
                id="ids-tin"
                value={idsTin}
                onChange={(e) => {
                  setIdsTin(e.target.value);
                  setIdsError('');
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ids-nssf">NSSF number</Label>
              <Input
                id="ids-nssf"
                value={idsNssf}
                onChange={(e) => {
                  setIdsNssf(e.target.value);
                  setIdsError('');
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ids-lst">LST district</Label>
              <Input
                id="ids-lst"
                value={idsLst}
                onChange={(e) => {
                  setIdsLst(e.target.value);
                  setIdsError('');
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              All three are optional. A partial record is better than none.
            </p>
            {idsError ? <p className="text-xs text-destructive">{idsError}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIdsRow(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void saveIds()} disabled={saving}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={statRow !== null} onOpenChange={(open) => !open && setStatRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record the basis</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Employment type</Label>
              <Select value={statType} onValueChange={setStatType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EMPLOYMENT_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={statPaye} onCheckedChange={(v) => setStatPaye(v === true)} /> PAYE
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={statNssf} onCheckedChange={(v) => setStatNssf(v === true)} /> NSSF
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={statLst} onCheckedChange={(v) => setStatLst(v === true)} /> LST
              </label>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="statutory-basis">Basis</Label>
              <Textarea
                id="statutory-basis"
                value={statBasis}
                onChange={(e) => {
                  setStatBasis(e.target.value);
                  setStatError('');
                }}
                rows={4}
              />
              <p className="text-xs text-muted-foreground">
                Why this deduction does not apply. Minimum 10 characters. This is the audit record.
              </p>
              {statError ? <p className="text-xs text-destructive">{statError}</p> : null}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStatRow(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void saveStatutory()} disabled={saving}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={payRow !== null} onOpenChange={(open) => !open && setPayRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Basic pay{payRow ? ` — ${payRow.name}` : ''}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="basic-amount">Amount</Label>
              <Input
                id="basic-amount"
                type="number"
                min={0}
                value={payAmount}
                onChange={(e) => {
                  setPayAmount(e.target.value);
                  setPayError('');
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="basic-from">Effective from</Label>
              <Input
                id="basic-from"
                type="date"
                value={payFrom}
                onChange={(e) => {
                  setPayFrom(e.target.value);
                  setPayError('');
                }}
              />
              <p className="text-xs text-muted-foreground">{EFFECTIVE_FROM_HELP}</p>
              {!periodStart ? (
                <p className="text-xs font-medium text-destructive">{NO_OPEN_PERIOD}</p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="basic-reason">Reason</Label>
              <Textarea
                id="basic-reason"
                value={payReason}
                onChange={(e) => {
                  setPayReason(e.target.value);
                  setPayError('');
                }}
                rows={3}
              />
              <p className="text-xs text-muted-foreground">
                Required. Minimum 10 characters. This is the audit record.
              </p>
              {payError ? <p className="text-xs text-destructive">{payError}</p> : null}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayRow(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void savePay()} disabled={saving || !periodStart}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pmRow !== null} onOpenChange={(open) => !open && setPmRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Part-month pay{pmRow ? ` — ${pmRow.name}` : ''}</DialogTitle>
          </DialogHeader>
          {!periodCode || !periodStart || !periodCutOff ? (
            <p className="text-sm text-muted-foreground">
              Open a pay period before entering part-month pay.
            </p>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                For someone who joined or left part way through the period. Paid once, for this
                period only. Their full salary starts from the month their basic pay record begins.
              </p>
              <p className="text-xs text-muted-foreground">
                Pay period {periodCode} — {formatDate(pmBounds?.first ?? periodStart)} to{' '}
                {formatDate(pmBounds?.last ?? periodCutOff)}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="pm-start">First day worked</Label>
                  <Input
                    id="pm-start"
                    type="date"
                    min={pmBounds?.first}
                    max={pmBounds?.last}
                    value={pmStart}
                    onChange={(e) => {
                      setPmStart(e.target.value);
                      setPmError('');
                      recalcPartMonth(e.target.value, pmEnd);
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pm-end">Last day worked</Label>
                  <Input
                    id="pm-end"
                    type="date"
                    min={pmBounds?.first}
                    max={pmBounds?.last}
                    value={pmEnd}
                    onChange={(e) => {
                      setPmEnd(e.target.value);
                      setPmError('');
                      recalcPartMonth(pmStart, e.target.value);
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave as the period end unless they left early.
                  </p>
                </div>
              </div>
              {(() => {
                if (!pmRow || !pmBounds) return null;
                const calc = partMonthCalc(
                  pmRow.basicAmount,
                  pmStart,
                  pmEnd,
                  pmBounds.first,
                  pmBounds.last,
                );
                return calc.ok ? (
                  <p className="rounded-md bg-muted p-2 text-sm">
                    {calc.worked} of {calc.inMonth} working days × UGX{' '}
                    {formatAmount(pmRow.basicAmount ?? 0)} ={' '}
                    <strong>UGX {formatAmount(calc.amount)}</strong>
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">{(calc as { ok: false; message: string }).message}</p>
                );
              })()}
              <div className="space-y-1.5">
                <Label htmlFor="pm-amount">Amount</Label>
                <Input
                  id="pm-amount"
                  type="number"
                  min={0}
                  value={pmAmount}
                  onChange={(e) => {
                    setPmAmount(e.target.value);
                    setPmError('');
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Worked out from the dates above. You can adjust it — if you do, say why in the
                  reason.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pm-reason">Reason</Label>
                <Textarea
                  id="pm-reason"
                  rows={3}
                  value={pmReason}
                  onChange={(e) => {
                    setPmReason(e.target.value);
                    setPmError('');
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Record how this was calculated, for example: joined 20 July, 10 of 23 working
                  days.
                </p>
                {pmError ? <p className="text-xs text-destructive">{pmError}</p> : null}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPmRow(null)} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={() => void savePartMonth()}
              disabled={saving || !periodStart || !periodCutOff}
            >
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dedRow !== null} onOpenChange={(open) => !open && setDedRow(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Deductions{dedRow ? ` — ${dedRow.name}` : ''}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {dedLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading deductions…
              </div>
            ) : dedRecords.length === 0 ? (
              <p className="text-sm text-muted-foreground">No open deductions.</p>
            ) : (
              <div className="space-y-2">
                {dedRecords.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center justify-between rounded-md border p-2 text-sm"
                  >
                    <div>
                      <p className="font-medium">
                        {r.component_name} ({r.component_code})
                      </p>
                      <p className="text-xs text-muted-foreground">
                        From {formatDate(r.effective_from)}
                      </p>
                    </div>
                    <span className="font-mono tabular-nums">UGX {formatAmount(r.amount)}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-3 border-t pt-4">
              <p className="text-sm font-semibold">Add deduction</p>
              <div className="space-y-1.5">
                <Label>Component</Label>
                <Select value={dedComponentId} onValueChange={setDedComponentId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a deduction" />
                  </SelectTrigger>
                  <SelectContent>
                    {deductionComponents.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name} ({c.code})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ded-amount">Amount</Label>
                <Input
                  id="ded-amount"
                  type="number"
                  min={0}
                  value={dedAmount}
                  onChange={(e) => {
                    setDedAmount(e.target.value);
                    setDedError('');
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ded-from">Effective from</Label>
                <Input
                  id="ded-from"
                  type="date"
                  value={dedFrom}
                  onChange={(e) => {
                    setDedFrom(e.target.value);
                    setDedError('');
                  }}
                />
                <p className="text-xs text-muted-foreground">{EFFECTIVE_FROM_HELP}</p>
                {!periodStart ? (
                  <p className="text-xs font-medium text-destructive">{NO_OPEN_PERIOD}</p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ded-reason">Reason</Label>
                <Textarea
                  id="ded-reason"
                  rows={3}
                  value={dedReason}
                  onChange={(e) => {
                    setDedReason(e.target.value);
                    setDedError('');
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Required. Minimum 10 characters. To stop a deduction, add a closing record.
                </p>
                {dedError ? <p className="text-xs text-destructive">{dedError}</p> : null}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDedRow(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void saveDeduction()} disabled={saving || !periodStart}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Add deduction
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={allowRow !== null} onOpenChange={(open) => !open && setAllowRow(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Allowances and earnings{allowRow ? ` — ${allowRow.name}` : ''}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {allowLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading earnings…
              </div>
            ) : allowRecords.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No open allowances. Basic pay and part-month pay are recorded on their own screens.
              </p>
            ) : (
              <div className="space-y-2">
                {allowRecords.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center justify-between rounded-md border p-2 text-sm"
                  >
                    <div>
                      <p className="font-medium">
                        {r.component_name} ({r.component_code})
                        {r.grade_code ? ` · grade ${r.grade_code}` : ''}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        From {formatDate(r.effective_from)}
                      </p>
                    </div>
                    <span className="font-mono tabular-nums">
                      {reveal ? `UGX ${formatAmount(r.amount)}` : '••••••'}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-3 border-t pt-4">
              <p className="text-sm font-semibold">Add earning</p>
              <div className="space-y-1.5">
                <Label>Component</Label>
                <Select value={allowComponentId} onValueChange={setAllowComponentId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select an earning" />
                  </SelectTrigger>
                  <SelectContent>
                    {allowanceComponents.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name} ({c.code})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Grade</Label>
                <Select value={allowGradeId} onValueChange={setAllowGradeId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Optional — no grade" />
                  </SelectTrigger>
                  <SelectContent>
                    {grades.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.code} — {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Optional. Records which pay grade this amount came from.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="allow-amount">Amount</Label>
                <Input
                  id="allow-amount"
                  type="number"
                  min={0}
                  value={allowAmount}
                  onChange={(e) => {
                    setAllowAmount(e.target.value);
                    setAllowError('');
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="allow-from">Effective from</Label>
                <Input
                  id="allow-from"
                  type="date"
                  value={allowFrom}
                  onChange={(e) => {
                    setAllowFrom(e.target.value);
                    setAllowError('');
                  }}
                />
                <p className="text-xs text-muted-foreground">{EFFECTIVE_FROM_HELP}</p>
                {!periodStart ? (
                  <p className="text-xs font-medium text-destructive">{NO_OPEN_PERIOD}</p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="allow-reason">Reason</Label>
                <Textarea
                  id="allow-reason"
                  rows={3}
                  value={allowReason}
                  onChange={(e) => {
                    setAllowReason(e.target.value);
                    setAllowError('');
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Required. Minimum 10 characters. To stop an allowance, add a closing record.
                </p>
                {allowError ? <p className="text-xs text-destructive">{allowError}</p> : null}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAllowRow(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void saveAllowance()} disabled={saving || !periodStart}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Add earning
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={histRow !== null} onOpenChange={(open) => !open && setHistRow(null)}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Compensation history{histRow ? ` — ${histRow.name}` : ''}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {histLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading history…
              </div>
            ) : histError ? (
              <p className="text-sm text-destructive">{histError}</p>
            ) : histRecords.length === 0 ? (
              <p className="text-sm text-muted-foreground">No compensation records yet.</p>
            ) : (
              <div className="max-h-[60vh] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Component</TableHead>
                      <TableHead>Grade</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Effective from</TableHead>
                      <TableHead>Effective to</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {histRecords.map((r) => {
                      const current = r.effectiveTo === null;
                      return (
                        <TableRow
                          key={r.id}
                          className={current ? undefined : 'text-muted-foreground'}
                        >
                          <TableCell className="text-xs">
                            {r.componentName || r.componentCode}
                            <span className="ml-1 font-mono text-[11px]">({r.componentCode})</span>
                          </TableCell>
                          <TableCell className="font-mono text-xs">{r.gradeCode ?? '—'}</TableCell>
                          <TableCell className="text-right font-mono text-sm tabular-nums">
                            {reveal ? formatAmount(r.amount) : '••••••'}
                          </TableCell>
                          <TableCell className="text-xs">{formatDate(r.effectiveFrom)}</TableCell>
                          <TableCell className="text-xs">{formatDate(r.effectiveTo)}</TableCell>
                          <TableCell className="max-w-[260px] text-xs" title={r.reason}>
                            {r.reason || '—'}
                          </TableCell>
                          <TableCell className="text-xs">
                            {current ? (
                              <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                                Current
                              </span>
                            ) : (
                              <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                                Superseded
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Compensation is append-only. Every change keeps the previous record with the date it
              closed. Nothing here can be edited or deleted.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHistRow(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}