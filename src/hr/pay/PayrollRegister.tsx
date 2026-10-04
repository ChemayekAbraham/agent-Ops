/**
 * Payroll register: the printable statutory summary of a run, grouped by
 * department, with employer contributions and a wet-ink signature block.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Loader2, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { getRegister, type RegisterDoc } from '@/hr/pay/api/workflow';
import '@/hr/pay/print.css';

function money(value: number | null | undefined): string {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return '—';
  return new Intl.NumberFormat('en-UG', { maximumFractionDigits: 0 }).format(numeric);
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function SignatureLine({
  label,
  position,
  name,
}: {
  label: string;
  position: string | null;
  name: string | null;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-semibold uppercase tracking-wide">{label}</p>
      <p className="text-xs text-muted-foreground">{position ?? '—'}</p>
      <p className="text-xs">{name ?? ''}</p>
      <div className="mt-6 border-t border-foreground/60 pt-1 text-[10px] text-muted-foreground">
        Signature &amp; date
      </div>
    </div>
  );
}

export default function PayrollRegister({ runId }: { runId: string }) {
  const [doc, setDoc] = useState<RegisterDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generatedAt] = useState(() => new Date());

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    getRegister(runId)
      .then((d) => {
        if (alive) setDoc(d);
      })
      .catch((err) => {
        if (alive) setError((err as Error).message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [runId]);

  const groups = useMemo(() => {
    const map = new Map<string, RegisterDoc['rows']>();
    (doc?.rows ?? []).forEach((r) => {
      const list = map.get(r.department_name) ?? [];
      list.push(r);
      map.set(r.department_name, list);
    });
    return Array.from(map.entries());
  }, [doc]);

  const totals = useMemo(() => {
    return (doc?.rows ?? []).reduce(
      (acc, r) => ({
        gross: acc.gross + r.gross,
        paye: acc.paye + r.paye,
        nssf: acc.nssf + r.nssf_employee,
        lst: acc.lst + r.lst,
        other: acc.other + r.other_deductions,
        net: acc.net + r.net,
        nssfEmployer: acc.nssfEmployer + r.nssf_employer,
        employerCost: acc.employerCost + r.employer_cost,
      }),
      { gross: 0, paye: 0, nssf: 0, lst: 0, other: 0, net: 0, nssfEmployer: 0, employerCost: 0 },
    );
  }, [doc]);

  const subtotal = (rows: RegisterDoc['rows']) =>
    rows.reduce(
      (acc, r) => ({
        gross: acc.gross + r.gross,
        paye: acc.paye + r.paye,
        nssf: acc.nssf + r.nssf_employee,
        lst: acc.lst + r.lst,
        other: acc.other + r.other_deductions,
        net: acc.net + r.net,
      }),
      { gross: 0, paye: 0, nssf: 0, lst: 0, other: 0, net: 0 },
    );

  if (loading) {
    return (
      <Card>
        <CardContent className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (error || !doc) {
    return (
      <Card>
        <CardContent className="py-6">
          <p role="alert" className="text-sm font-medium text-destructive">
            {error ?? 'Register unavailable.'}
          </p>
        </CardContent>
      </Card>
    );
  }

  const provisional = doc.rule_status_at_run === 'provisional';

  return (
    <Card className="print-root">
      <CardContent className="space-y-4 py-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-bold uppercase tracking-wide">
              Welile Technologies (U) Ltd
            </p>
            <h2 className="text-lg font-semibold">Payroll register</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Period {doc.period_code ?? '—'} · Pay date {formatDate(doc.pay_date)} · Run{' '}
              <span className="font-mono">{doc.run_reference}</span> · Rule{' '}
              {doc.rule_version_code ?? '—'}
            </p>
            <p className="text-xs text-muted-foreground">
              Generated {generatedAt.toLocaleString('en-GB')}
            </p>
            <p className="text-xs font-medium">
              Staff on this payroll: {doc.rows.length} of {doc.enrolled_count} enrolled
            </p>
          </div>
          <Button size="sm" variant="outline" className="no-print" onClick={() => window.print()}>
            <Printer className="mr-1 h-3.5 w-3.5" />
            Print / Save as PDF
          </Button>
        </div>

        {provisional && (
          <div className="rounded-md border border-amber-500 bg-amber-50 p-3 text-xs font-semibold text-amber-800">
            PROVISIONAL — computed against a rule set not yet confirmed by a tax advisor. Figures
            are subject to recomputation.
          </div>
        )}

        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-foreground/40 text-left">
              <th className="py-1 font-semibold">Staff ref</th>
              <th className="py-1 font-semibold">Name</th>
              <th className="py-1 text-right font-semibold">Gross</th>
              <th className="py-1 text-right font-semibold">PAYE</th>
              <th className="py-1 text-right font-semibold">NSSF employee</th>
              <th className="py-1 text-right font-semibold">LST</th>
              <th className="py-1 text-right font-semibold">Other deductions</th>
              <th className="py-1 text-right font-semibold">Net</th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && (
              <tr>
                <td colSpan={8} className="py-3 text-center text-muted-foreground">
                  No current payslips on this run.
                </td>
              </tr>
            )}
            {groups.map(([department, rows]) => {
              const sub = subtotal(rows);
              return (
                <Fragment key={department}>
                  <tr className="bg-muted/50">
                    <td colSpan={8} className="py-1 font-semibold uppercase tracking-wide">
                      {department}
                    </td>
                  </tr>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-border">
                      <td className="py-1 font-mono">{r.staff_ref ?? '—'}</td>
                      <td className="py-1">{r.staff_name ?? '—'}</td>
                      <td className="py-1 text-right">{money(r.gross)}</td>
                      <td className="py-1 text-right">{money(r.paye)}</td>
                      <td className="py-1 text-right">{money(r.nssf_employee)}</td>
                      <td className="py-1 text-right">{money(r.lst)}</td>
                      <td className="py-1 text-right">{money(r.other_deductions)}</td>
                      <td className="py-1 text-right font-semibold">{money(r.net)}</td>
                    </tr>
                  ))}
                  <tr className="border-b border-foreground/30 font-semibold">
                    <td className="py-1" colSpan={2}>
                      {department} subtotal ({rows.length})
                    </td>
                    <td className="py-1 text-right">{money(sub.gross)}</td>
                    <td className="py-1 text-right">{money(sub.paye)}</td>
                    <td className="py-1 text-right">{money(sub.nssf)}</td>
                    <td className="py-1 text-right">{money(sub.lst)}</td>
                    <td className="py-1 text-right">{money(sub.other)}</td>
                    <td className="py-1 text-right">{money(sub.net)}</td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-foreground/60 font-bold">
              <td className="py-1" colSpan={2}>
                Grand total ({doc.rows.length} employees)
              </td>
              <td className="py-1 text-right">{money(totals.gross)}</td>
              <td className="py-1 text-right">{money(totals.paye)}</td>
              <td className="py-1 text-right">{money(totals.nssf)}</td>
              <td className="py-1 text-right">{money(totals.lst)}</td>
              <td className="py-1 text-right">{money(totals.other)}</td>
              <td className="py-1 text-right">{money(totals.net)}</td>
            </tr>
          </tfoot>
        </table>

        <section className="space-y-1">
          <h3 className="text-sm font-bold uppercase tracking-wide">Employer contributions</h3>
          <table className="w-full max-w-sm text-xs">
            <tbody>
              <tr className="border-b border-border">
                <td className="py-1">NSSF employer total</td>
                <td className="py-1 text-right">{money(totals.nssfEmployer)}</td>
              </tr>
              <tr className="font-semibold">
                <td className="py-1">Total employer cost</td>
                <td className="py-1 text-right">{money(totals.employerCost)}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-bold uppercase tracking-wide">
            Enrolled staff not on this payroll
          </h3>
          {doc.omissions_count === 0 ? (
            <p className="text-xs text-muted-foreground">
              None. Every enrolled staff member appears above.
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-amber-800">
                {doc.omissions_count} of {doc.enrolled_count} enrolled staff are not included in
                this payroll run. Reasons are shown below.
              </p>
              <table className="w-full border border-amber-500 text-xs">
                <thead>
                  <tr className="border-b border-amber-500 bg-amber-50 text-left text-amber-900">
                    <th className="border-r border-amber-500 px-2 py-1 font-semibold">Staff ref</th>
                    <th className="border-r border-amber-500 px-2 py-1 font-semibold">Name</th>
                    <th className="px-2 py-1 font-semibold">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {doc.omissions.map((o) => (
                    <tr key={o.staff_id} className="border-b border-amber-500/60">
                      <td className="border-r border-amber-500/60 px-2 py-1 font-mono">
                        {o.staff_ref ?? '—'}
                      </td>
                      <td className="border-r border-amber-500/60 px-2 py-1">
                        {o.staff_name ?? '—'}
                      </td>
                      <td className="px-2 py-1">{o.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="grid grid-cols-1 gap-6 pt-2 sm:grid-cols-3">
          <SignatureLine
            label="Prepared by"
            position={doc.prepared_position_title}
            name={doc.prepared_by_name}
          />
          <SignatureLine
            label="Approved by"
            position={doc.approved_position_title}
            name={doc.approved_by_name}
          />
          <SignatureLine
            label="Released by"
            position={doc.released_position_title}
            name={doc.released_by_name}
          />
        </section>
      </CardContent>
    </Card>
  );
}