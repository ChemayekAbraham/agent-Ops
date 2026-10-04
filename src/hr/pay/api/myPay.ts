/**
 * Employee self-service payroll reads.
 *
 * Payslip reads go through the `hr_pay_my_payslips` RPC, which resolves the
 * caller's own staff record server-side and returns only the rows the employee
 * is allowed to see. The client must not query the payslip, run or period
 * tables directly because an ordinary employee has no read access to the run
 * and period tables.
 */
import { supabase, unwrap } from '../../api/client';

export interface MyPayslipRow {
  id: string;
  period_code: string | null;
  pay_date: string | null;
  gross: number;
  paye: number;
  nssf_employee: number;
  other_deductions: number;
  net: number;
  run_status: string;
}

/** Payslips visible to the signed-in employee, newest pay date first. */
export async function listMyPayslips(): Promise<MyPayslipRow[]> {
  const rows = (unwrap(await supabase.rpc('hr_pay_my_payslips')) ??
    []) as Array<Record<string, any>>;

  return rows.map((r) => ({
    id: r.id as string,
    period_code: (r.period_code as string | null) ?? null,
    pay_date: (r.pay_date as string | null) ?? null,
    gross: Number(r.gross ?? 0),
    paye: Number(r.paye ?? 0),
    nssf_employee: Number(r.nssf_employee ?? 0),
    other_deductions: Number(r.other_deductions ?? 0),
    net: Number(r.net ?? 0),
    run_status: (r.run_status as string) ?? '',
  }));
}
