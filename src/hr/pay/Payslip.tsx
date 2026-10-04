/**
 * Itemised payslip document (Uganda Employment Act): gross pay, every
 * deduction, allowances and net pay are shown line by line, never collapsed.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, Printer } from 'lucide-react';
import HRPlaceholderPage from '@/hr/pages/HRPlaceholderPage';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { supabase, unwrap } from '@/hr/api/client';
import '@/hr/pay/print.css';

interface PayslipLineRow {
  id: string;
  component_code: string;
  name: string;
  kind: string;
  amount: number;
  display_order: number;
}

interface PayslipDoc {
  id: string;
  run_id: string;
  rule_status_at_run: string;
  computed_at: string;
  gross: number;
  paye: number;
  nssf_employee: number;
  nssf_employer: number;
  lst: number;
  other_deductions: number;
  net: number;
  employer_cost: number;
  staff_ref: string | null;
  staff_name: string | null;
  department_title: string | null;
  position_title: string | null;
  period_code: string | null;
  pay_date: string | null;
  rule_version_code: string | null;
  calculation_trace: string[];
  lines: PayslipLineRow[];
}

function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return new Intl.NumberFormat('en-UG', { maximumFractionDigits: 0 }).format(numeric);
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

async function loadPayslip(payslipId: string): Promise<PayslipDoc> {
  const row = unwrap(
    await supabase
      .from('hr_pay_payslips')
      .select(
        'id, run_id, rule_status_at_run, computed_at, gross, paye, nssf_employee, nssf_employer, lst, other_deductions, net, employer_cost, calculation_trace, hr_staff(staff_ref, user_id), hr_departments(name), hr_positions(title), hr_pay_runs(id, hr_pay_periods(code, pay_date), hr_pay_rule_versions(code))',
      )
      .eq('id', payslipId)
      .single(),
  ) as Record<string, any>;

  const lines = (unwrap(
    await supabase
      .from('hr_pay_payslip_lines')
      .select('id, component_code, name, kind, amount, display_order')
      .eq('payslip_id', payslipId)
      .order('display_order', { ascending: true }),
  ) ?? []) as Array<Record<string, any>>;

  let staffName: string | null = null;
  const userId = row.hr_staff?.user_id as string | undefined;
  if (userId) {
    const profiles = (unwrap(
      await supabase.from('profiles').select('id, full_name').eq('id', userId).limit(1),
    ) ?? []) as Array<{ id: string; full_name: string | null }>;
    staffName = profiles[0]?.full_name ?? null;
  }

  const trace = Array.isArray(row.calculation_trace)
    ? (row.calculation_trace as unknown[]).map((t) => String(t))
    : [];

  return {
    id: row.id,
    run_id: row.run_id,
    rule_status_at_run: row.rule_status_at_run,
    computed_at: row.computed_at,
    gross: Number(row.gross ?? 0),
    paye: Number(row.paye ?? 0),
    nssf_employee: Number(row.nssf_employee ?? 0),
    nssf_employer: Number(row.nssf_employer ?? 0),
    lst: Number(row.lst ?? 0),
    other_deductions: Number(row.other_deductions ?? 0),
    net: Number(row.net ?? 0),
    employer_cost: Number(row.employer_cost ?? 0),
    staff_ref: row.hr_staff?.staff_ref ?? null,
    staff_name: staffName,
    department_title: row.hr_departments?.name ?? null,
    position_title: row.hr_positions?.title ?? null,
    period_code: row.hr_pay_runs?.hr_pay_periods?.code ?? null,
    pay_date: row.hr_pay_runs?.hr_pay_periods?.pay_date ?? null,
    rule_version_code: row.hr_pay_runs?.hr_pay_rule_versions?.code ?? null,
    calculation_trace: trace,
    lines: lines.map((l) => ({
      id: l.id as string,
      component_code: l.component_code as string,
      name: l.name as string,
      kind: l.kind as string,
      amount: Number(l.amount ?? 0),
      display_order: Number(l.display_order ?? 0),
    })),
  };
}

function AmountTable({
  rows,
  totalLabel,
  total,
  emptyLabel,
}: {
  rows: PayslipLineRow[];
  totalLabel: string;
  total: number;
  emptyLabel: string;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border text-left">
          <th className="py-1 font-semibold">Description</th>
          <th className="py-1 text-right font-semibold">Amount (UGX)</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td className="py-1 text-muted-foreground" colSpan={2}>
              {emptyLabel}
            </td>
          </tr>
        ) : (
          rows.map((line) => (
            <tr key={line.id} className="border-b border-border/50">
              <td className="py-1">{line.name}</td>
              <td className="py-1 text-right tabular-nums">{money(line.amount)}</td>
            </tr>
          ))
        )}
        <tr className="font-semibold">
          <td className="py-1">{totalLabel}</td>
          <td className="py-1 text-right tabular-nums">{money(total)}</td>
        </tr>
      </tbody>
    </table>
  );
}

export default function PayslipPage() {
  const { payslipId } = useParams<{ payslipId: string }>();
  const [doc, setDoc] = useState<PayslipDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [traceOpen, setTraceOpen] = useState(false);

  const load = useCallback(async () => {
    if (!payslipId) return;
    setLoading(true);
    setError(null);
    try {
      setDoc(await loadPayslip(payslipId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [payslipId]);

  useEffect(() => {
    void load();
  }, [load]);

  const earnings = useMemo(() => (doc?.lines ?? []).filter((l) => l.kind === 'earning'), [doc]);
  const deductions = useMemo(() => (doc?.lines ?? []).filter((l) => l.kind === 'deduction'), [doc]);
  const employerLines = useMemo(
    () => (doc?.lines ?? []).filter((l) => l.kind === 'employer_cost'),
    [doc],
  );

  const earningsTotal = earnings.reduce((s, l) => s + l.amount, 0);
  const deductionsTotal = deductions.reduce((s, l) => s + l.amount, 0);
  const employerTotal = employerLines.reduce((s, l) => s + l.amount, 0);

  const provisional = doc?.rule_status_at_run === 'provisional';

  const handlePrint = () => {
    setTraceOpen(true);
    window.setTimeout(() => window.print(), 50);
  };

  return (
    <HRPlaceholderPage
      heading="Payslip"
      subtitle={doc ? `${doc.period_code ?? 'Period'} · ${doc.staff_name ?? doc.staff_ref ?? ''}` : ''}
    >
      {loading && (
        <p className="text-sm text-muted-foreground">
          <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />
          Loading payslip…
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}

      {doc && (
        <Card>
          <CardContent className="space-y-5 pt-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-bold uppercase tracking-wide">
                  Welile Technologies (U) Ltd
                </p>
                <h1 className="text-xl font-bold">Payslip</h1>
                <div className="mt-2 grid grid-cols-1 gap-x-8 gap-y-0.5 text-sm sm:grid-cols-2">
                  <p>Period: {doc.period_code ?? '—'}</p>
                  <p>Pay date: {formatDate(doc.pay_date)}</p>
                  <p>Employee: {doc.staff_name ?? '—'}</p>
                  <p>Staff reference: {doc.staff_ref ?? '—'}</p>
                  <p>Department: {doc.department_title ?? '—'}</p>
                  <p>Position: {doc.position_title ?? '—'}</p>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Rule version {doc.rule_version_code ?? '—'} · computed{' '}
                  {new Date(doc.computed_at).toLocaleString('en-GB')} · run{' '}
                  {doc.run_id.slice(0, 8)}
                </p>
              </div>
              <Button size="sm" className="no-print" onClick={handlePrint}>
                <Printer className="mr-1 h-3.5 w-3.5" />
                Print / Save as PDF
              </Button>
            </div>

            {provisional && (
              <div className="rounded-md border border-amber-500 bg-amber-50 p-3 text-xs font-semibold text-amber-800">
                PROVISIONAL — computed against a rule set not yet confirmed by a tax advisor.
                Figures are subject to recomputation.
              </div>
            )}

            <section className="space-y-2">
              <h2 className="text-sm font-bold uppercase tracking-wide">Earnings</h2>
              <AmountTable
                rows={earnings}
                totalLabel="Gross pay"
                total={earningsTotal}
                emptyLabel="No earning lines."
              />
            </section>

            <section className="space-y-2">
              <h2 className="text-sm font-bold uppercase tracking-wide">Deductions</h2>
              <AmountTable
                rows={deductions}
                totalLabel="Total deductions"
                total={deductionsTotal}
                emptyLabel="No deductions."
              />
            </section>

            <div className="flex items-center justify-between rounded-md border-2 border-foreground/70 px-3 py-2 text-base font-bold">
              <span>Net pay</span>
              <span className="tabular-nums">{money(doc.net)}</span>
            </div>

            <section className="space-y-2">
              <h2 className="text-sm font-bold uppercase tracking-wide">
                Employer contributions
              </h2>
              <AmountTable
                rows={employerLines}
                totalLabel="Total employer contributions"
                total={employerTotal}
                emptyLabel="No employer contribution lines."
              />
              <p className="text-xs text-muted-foreground">
                Employer cost. Not deducted from pay.
              </p>
            </section>

            <section className="space-y-2">
              <button
                type="button"
                className="text-sm font-semibold underline"
                onClick={() => setTraceOpen((v) => !v)}
                aria-expanded={traceOpen}
              >
                How this was calculated
              </button>
              <ol
                className={`list-decimal space-y-1 pl-5 text-xs text-muted-foreground ${
                  traceOpen ? '' : 'hidden print:block'
                }`}
              >
                {doc.calculation_trace.length === 0 ? (
                  <li>No calculation trace recorded.</li>
                ) : (
                  doc.calculation_trace.map((step, index) => <li key={index}>{step}</li>)
                )}
              </ol>
            </section>
          </CardContent>
        </Card>
      )}
    </HRPlaceholderPage>
  );
}
