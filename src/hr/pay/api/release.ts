/**
 * Payroll release data access (hr_pay_release_preview, hr_pay_disbursements,
 * the hr-pay-release edge function and the 'paid' run event).
 *
 * `hr_pay_runs.status` is NEVER written from this file. Recording payment
 * inserts an event into `hr_pay_run_events` and nothing else.
 */
import { supabase, unwrap } from '../../api/client';

export interface ReleasePreviewRow {
  payslip_id: string;
  staff_id: string | null;
  staff_ref: string | null;
  net: number;
  user_id: string | null;
  has_wallet: boolean;
  disb_status: string | null;
  blocker: string | null;
}

export interface DisbursementRow {
  id: string;
  run_id: string;
  payslip_id: string | null;
  staff_id: string | null;
  staff_ref: string | null;
  amount: number;
  status: string;
  ledger_reference_id: string | null;
  error_text: string | null;
  attempted_at: string | null;
  posted_at: string | null;
}

export async function previewRelease(runId: string): Promise<ReleasePreviewRow[]> {
  const res = await (supabase.rpc as any)('hr_pay_release_preview', { _run_id: runId });
  const rows = (unwrap(res) ?? []) as Array<Record<string, any>>;
  return rows.map((r) => ({
    payslip_id: r.payslip_id as string,
    staff_id: (r.staff_id as string | null) ?? null,
    staff_ref: (r.staff_ref as string | null) ?? null,
    net: Number(r.net ?? 0),
    user_id: (r.user_id as string | null) ?? null,
    has_wallet: r.has_wallet === true,
    disb_status: (r.disb_status as string | null) ?? null,
    blocker: (r.blocker as string | null) ?? null,
  }));
}

export async function listDisbursements(runId: string): Promise<DisbursementRow[]> {
  const res = await supabase
    .from('hr_pay_disbursements')
    .select(
      'id, run_id, payslip_id, staff_id, amount, status, ledger_reference_id, error_text, attempted_at, posted_at, hr_staff(staff_ref)',
    )
    .eq('run_id', runId);
  const rows = (unwrap(res) ?? []) as Array<Record<string, any>>;
  return rows
    .map((r) => ({
      id: r.id as string,
      run_id: r.run_id as string,
      payslip_id: (r.payslip_id as string | null) ?? null,
      staff_id: (r.staff_id as string | null) ?? null,
      staff_ref: (r.hr_staff?.staff_ref as string | null) ?? null,
      amount: Number(r.amount ?? 0),
      status: (r.status as string) ?? 'unknown',
      ledger_reference_id: (r.ledger_reference_id as string | null) ?? null,
      error_text: (r.error_text as string | null) ?? null,
      attempted_at: (r.attempted_at as string | null) ?? null,
      posted_at: (r.posted_at as string | null) ?? null,
    }))
    .sort((a, b) => (a.staff_ref ?? '').localeCompare(b.staff_ref ?? ''));
}

/**
 * Release a run. With payslipIds, only that batch is paid. An empty list is
 * passed through deliberately: the function refuses it rather than treating it
 * as "everyone".
 */
export async function runRelease(
  runId: string,
  dryRun: boolean,
  payslipIds?: string[],
): Promise<any> {
  const body: Record<string, unknown> = { runId, dryRun };
  if (payslipIds !== undefined) body.payslipIds = payslipIds;
  const { data, error } = await supabase.functions.invoke('hr-pay-release', {
    body,
  });
  if (error) {
    // Surface the function's message unmodified.
    throw new Error((error as Error).message);
  }
  return data;
}

export async function markRunPaid(runId: string, note: string): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  const res = await supabase
    .from('hr_pay_run_events')
    .insert({
      run_id: runId,
      event_type: 'paid',
      note: note && note.trim() ? note.trim() : null,
      actor: auth?.user?.id ?? null,
    })
    .select('id')
    .single();
  if (res.error) {
    // The database text explains which payslips have not posted. Do not reword.
    throw new Error(res.error.message);
  }
}