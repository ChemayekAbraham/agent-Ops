import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { supabase } from '@/hr/api/client';

interface ReinvestRow {
  payslip_id: string;
  staff_ref: string | null;
  full_name: string | null;
  amount: number;
  percentage: number | null;
  return_option: string | null;
  status: 'posted' | 'pending';
  portfolio_code: string | null;
  kind: string | null;
  posted_at: string | null;
}

const fmt = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

const RETURN_LABEL: Record<string, string> = {
  monthly_payout: 'Monthly returns',
  monthly_compounding: 'Compounding',
};

function explain(error: string): string {
  if (error.includes('RETURN_OPTION_NOT_CHOSEN')) {
    return 'Return option not chosen yet — ask them to open the app and choose.';
  }
  if (error.includes('SALARY_NOT_RELEASED')) return 'Salary not released yet.';
  return error;
}

/** Salary reinvestments on a run, and posting them into Partner Ops. */
export default function ReinvestmentsPanel({ runId, status }: { runId: string; status: string }) {
  const [rows, setRows] = useState<ReinvestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [releaser, setReleaser] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('hr_pay_run_reinvestments' as never, {
      _run_id: runId,
    } as never);
    setLoading(false);
    if (error) { toast.error(error.message); return; }
    setRows(((data ?? []) as unknown) as ReinvestRow[]);
  }, [runId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await (supabase.rpc as any)('hr_pay_is_releaser');
      if (alive) setReleaser(res?.data === true);
    })();
    return () => { alive = false; };
  }, []);

  if (!loading && rows.length === 0) return null;

  const pending = rows.filter((r) => r.status === 'pending');
  const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const canPost = releaser && ['approved', 'paid'].includes(status) && pending.length > 0;

  const post = async () => {
    setBusy(true);
    const { data, error } = await supabase.rpc('hr_pay_post_run_reinvestments' as never, {
      _run_id: runId,
    } as never);
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    const res = (data ?? {}) as {
      posted?: number;
      failed?: number;
      items?: Array<{ payslip_id: string; status: string; error?: string }>;
    };
    const errs: Record<string, string> = {};
    for (const it of res.items ?? []) {
      if (it.status === 'failed' && it.error) errs[it.payslip_id] = it.error;
    }
    setErrors(errs);
    const posted = Number(res.posted ?? 0);
    const failed = Number(res.failed ?? 0);
    toast.success(
      `${posted} reinvestment${posted === 1 ? '' : 's'} posted${failed ? `, ${failed} need attention` : ''}.`,
    );
    void load();
  };

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-base">Salary reinvestments</CardTitle>
        <p className="text-xs text-muted-foreground">
          Deducted from these payslips and moved into each person's Welile staff portfolio in
          Partner Ops once their salary is released. 20% per month, on their chosen return option.
          The run cannot be recorded as paid until every reinvestment is posted.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span>
                <strong>{rows.length}</strong> reinvesting · <strong>{fmt(total)}</strong>
              </span>
              <span>
                Posted <strong>{rows.length - pending.length}</strong> · Not yet posted{' '}
                <strong>{pending.length}</strong>
              </span>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Staff ref</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="text-right">Share</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Return option</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.payslip_id}>
                      <TableCell className="font-mono text-xs">{r.staff_ref ?? '—'}</TableCell>
                      <TableCell>{r.full_name ?? '—'}</TableCell>
                      <TableCell className="text-right">{r.percentage ?? '—'}%</TableCell>
                      <TableCell className="text-right">{fmt(r.amount)}</TableCell>
                      <TableCell className="text-xs">
                        {r.return_option ? (
                          RETURN_LABEL[r.return_option] ?? r.return_option
                        ) : (
                          <span className="font-semibold text-amber-700">Not chosen</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.status === 'posted' ? (
                          <span className="font-semibold text-emerald-600">
                            Posted · {r.portfolio_code ?? ''}
                            {r.kind === 'topup' ? ' (top-up)' : ' (new portfolio)'}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">
                            Not yet posted
                            {errors[r.payslip_id] ? (
                              <span className="block font-medium text-destructive">
                                {explain(errors[r.payslip_id])}
                              </span>
                            ) : null}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {canPost && (
              <div className="flex items-center gap-2 border-t border-border pt-3">
                <Button size="sm" disabled={busy} onClick={() => void post()}>
                  {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                  Post reinvestments
                </Button>
                <span className="text-xs text-muted-foreground">
                  Posts everyone whose salary has been released. Safe to press more than once.
                </span>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
