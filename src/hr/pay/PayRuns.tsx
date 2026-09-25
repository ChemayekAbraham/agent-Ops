import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import HRPlaceholderPage from '@/hr/pages/HRPlaceholderPage';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  closePeriod,
  createPeriod,
  createRun,
  listPeriods,
  listRuleVersions,
  listRuns,
  type PayPeriodRow,
  type PayRuleVersionOption,
  type PayRunRow,
} from '@/hr/pay/api/runs';
import { calculateRun, getRunDetail, type RunDetail } from '@/hr/pay/api/calculate';
import {
  approveRun,
  cancelRun,
  getStatutoryReturn,
  listExceptions,
  lockRun,
  returnRun,
  submitRun,
  type RunException,
  type StatutoryReturnRow,
} from '@/hr/pay/api/workflow';
import {
  listDisbursements,
  markRunPaid,
  runRelease,
  type DisbursementRow,
} from '@/hr/pay/api/release';
import PayrollRegister from '@/hr/pay/PayrollRegister';
import ArrearsPanel from '@/hr/pay/ArrearsPanel';
import { supabase } from '@/hr/api/client';

/**
 * Authority is read from the database authority register via rpc
 * (hr_pay_is_preparer / hr_pay_is_approver / hr_pay_is_releaser). It is never
 * inferred from the signed-in user's roles.
 */
function useRunAuthority() {
  const [authority, setAuthority] = useState({
    preparer: false,
    approver: false,
    releaser: false,
    ruleAdmin: false,
    loaded: false,
  });
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [prep, appr, rel, ruleAdm] = await Promise.all([
        (supabase.rpc as any)('hr_pay_is_preparer'),
        (supabase.rpc as any)('hr_pay_is_approver'),
        (supabase.rpc as any)('hr_pay_is_releaser'),
        (supabase.rpc as any)('hr_pay_is_rule_admin'),
      ]);
      if (!alive) return;
      setAuthority({
        preparer: prep?.data === true,
        approver: appr?.data === true,
        releaser: rel?.data === true,
        ruleAdmin: ruleAdm?.data === true,
        loaded: true,
      });
    })();
    return () => {
      alive = false;
    };
  }, []);
  return authority;
}

function RunActionBar({
  runId,
  status,
  onDone,
  blockingCount = 0,
}: {
  runId: string;
  status: string;
  onDone: () => void;
  blockingCount?: number;
}) {
  const authority = useRunAuthority();
  const [busy, setBusy] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const act = async (fn: () => Promise<void>, message: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast.success(message);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const showSubmit = status === 'calculated' || status === 'returned';
  const showReview = status === 'in_review';
  const showLock = status === 'paid';
  if (!showSubmit && !showReview && !showLock) return null;

  const blocked = blockingCount > 0;
  const submitDenied = !authority.preparer || blocked;
  const approveDenied = !authority.approver;
  const lockDenied = !authority.releaser && !authority.approver && !authority.ruleAdmin;

  return (
    <div className="mt-3 space-y-2 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        {showSubmit && (
          <Button
            size="sm"
            disabled={busy || submitDenied}
            title={
              blocked
                ? 'Resolve the blocking exceptions before submitting.'
                : submitDenied
                ? 'Your position does not hold prepare authority for payroll runs.'
                : 'Send this run to the position holding approve authority.'
            }
            onClick={() => {
              if (!window.confirm('This sends the run to the position holding approve authority.')) return;
              void act(() => submitRun(runId, 'Submitted for approval.'), 'Run submitted for approval.');
            }}
          >
            Submit for approval
          </Button>
        )}
        {showReview && (
          <>
            <Button
              size="sm"
              disabled={busy || approveDenied}
              title={
                approveDenied
                  ? 'Your position does not hold approve authority for payroll runs.'
                  : 'Approve this run.'
              }
              onClick={() => void act(() => approveRun(runId, 'Approved.'), 'Run approved.')}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || approveDenied}
              title={
                approveDenied
                  ? 'Your position does not hold approve authority for payroll runs.'
                  : 'Return this run for rework.'
              }
              onClick={() => setReturnOpen(true)}
            >
              Return for rework
            </Button>
          </>
        )}
        {showLock && (
          <Button
            size="sm"
            disabled={busy || lockDenied}
            title={
              lockDenied
                ? 'Your position does not hold release authority for payroll runs.'
                : 'Lock this run.'
            }
            onClick={() => void act(() => lockRun(runId, 'Locked.'), 'Run locked.')}
          >
            Lock
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
      <Dialog open={returnOpen} onOpenChange={setReturnOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Return for rework</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="return-reason">Reason</Label>
            <Textarea
              id="return-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
            />
            <p className="text-xs text-muted-foreground">
              Why it is going back. This is the audit record.
            </p>
          </div>
          <DialogFooter>
            <Button
              size="sm"
              disabled={busy || reason.trim().length < 10}
              onClick={() =>
                void act(() => returnRun(runId, reason), 'Run returned for rework.').then(() => {
                  setReturnOpen(false);
                  setReason('');
                })
              }
            >
              Return run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Release payment — the whole run at once, or in batches. Authority comes from
 * the database authority register (hr_pay_is_releaser), never from the signed-in
 * user's roles. The releaser ticks who is paid in each batch. Every payslip is
 * keyed, so nobody can be paid twice, and the run can only be recorded as paid
 * once every payslip with net pay has been posted. Record payment is shown
 * whenever the run is approved — not only straight after a release.
 */
function ReleaseSection({
  runId,
  status,
  payslips,
  onPaid,
}: {
  runId: string;
  status: string;
  payslips: Array<{ id: string; staff_ref?: string | null; staff_name?: string | null; net: number }>;
  onPaid?: () => void;
}) {
  const authority = useRunAuthority();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dry, setDry] = useState<{ payslip_count: number; total_net: number; items: Array<{ staff_ref: string | null; amount: number; blocker: string | null }> } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [disbursements, setDisbursements] = useState<DisbursementRow[]>([]);
  const [paidError, setPaidError] = useState<string | null>(null);
  const [paidDone, setPaidDone] = useState(false);

  const visible = ['approved', 'paid', 'locked'].includes(status);

  const loadDisbursements = useCallback(async () => {
    try {
      setDisbursements(await listDisbursements(runId));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [runId]);

  useEffect(() => {
    if (visible) void loadDisbursements();
  }, [visible, loadDisbursements]);

  const byPayslip = useMemo(() => {
    const map = new Map<string, DisbursementRow>();
    for (const d of disbursements) {
      if (d.payslip_id) map.set(d.payslip_id, d);
    }
    return map;
  }, [disbursements]);

  const payable = useMemo(() => payslips.filter((p) => Number(p.net) > 0), [payslips]);

  const canTick = (id: string) => {
    const s = byPayslip.get(id)?.status;
    return s !== 'posted' && s !== 'pending';
  };

  const summary = useMemo(() => {
    let paidCount = 0;
    let paidSum = 0;
    let owedCount = 0;
    let owedSum = 0;
    let failedCount = 0;
    let pendingCount = 0;
    for (const p of payable) {
      const s = byPayslip.get(p.id)?.status;
      if (s === 'posted') {
        paidCount++;
        paidSum += Number(p.net);
      } else {
        owedCount++;
        owedSum += Number(p.net);
      }
      if (s === 'failed') failedCount++;
      if (s === 'pending') pendingCount++;
    }
    return { paidCount, paidSum, owedCount, owedSum, failedCount, pendingCount };
  }, [payable, byPayslip]);

  const selectedTotal = useMemo(
    () => payable.filter((p) => selected.has(p.id)).reduce((sum, p) => sum + Number(p.net), 0),
    [payable, selected],
  );

  const toggle = (id: string) => {
    setDry(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllUnpaid = () => {
    setDry(null);
    setSelected(new Set(payable.filter((p) => canTick(p.id)).map((p) => p.id)));
  };

  const clearSelection = () => {
    setDry(null);
    setSelected(new Set());
  };

  const doDryRun = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await runRelease(runId, true, Array.from(selected));
      setDry({
        payslip_count: Number(res?.payslip_count ?? 0),
        total_net: Number(res?.total_net ?? 0),
        items: Array.isArray(res?.items) ? res.items : [],
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doRelease = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await runRelease(runId, false, Array.from(selected));
      setConfirmOpen(false);
      setTyped('');
      setDry(null);
      setSelected(new Set());
      await loadDisbursements();
      toast.success(
        `Batch released: ${Number(res?.posted ?? 0)} paid, ${Number(res?.failed ?? 0)} failed, ${Number(res?.already_handled ?? 0)} already handled.`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!visible) return null;

  const readOnly = !authority.releaser;
  const releasable = status === 'approved' && !readOnly;
  const allPaid = summary.owedCount === 0;

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-base">Release payment</CardTitle>
        <p className="text-xs text-muted-foreground">
          Credits each employee&apos;s wallet. This moves real money. Pay everyone at once, or in
          batches: tick who is paid now and release; the rest stay owed until the next batch.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span>
            Paid <strong>{summary.paidCount}</strong> of {payable.length} ·{' '}
            <strong>{formatNet(summary.paidSum)}</strong>
          </span>
          <span>
            Still to pay <strong>{summary.owedCount}</strong> ·{' '}
            <strong>{formatNet(summary.owedSum)}</strong>
          </span>
          {summary.failedCount > 0 && (
            <span className="font-semibold text-destructive">
              {summary.failedCount} failed — tick to retry
            </span>
          )}
          {summary.pendingCount > 0 && (
            <span className="font-semibold text-amber-700">
              {summary.pendingCount} in progress — check the ledger before retrying
            </span>
          )}
        </div>

        {readOnly && (
          <p className="text-sm text-muted-foreground">
            Only the position holding release authority may release this run.
          </p>
        )}

        {payable.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                {releasable && <TableHead className="w-10">Pay</TableHead>}
                <TableHead>Staff ref</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Net</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payable.map((p) => {
                const d = byPayslip.get(p.id);
                const s = d?.status;
                const label =
                  s === 'posted'
                    ? 'Paid'
                    : s === 'failed'
                      ? 'Failed'
                      : s === 'pending'
                        ? 'In progress'
                        : s === 'skipped'
                          ? 'Skipped'
                          : 'Not paid';
                const tone =
                  s === 'posted'
                    ? 'text-emerald-600'
                    : s === 'failed'
                      ? 'text-destructive'
                      : s === 'pending'
                        ? 'text-amber-700'
                        : 'text-muted-foreground';
                return (
                  <TableRow key={p.id}>
                    {releasable && (
                      <TableCell>
                        <input
                          type="checkbox"
                          aria-label={`Pay ${p.staff_ref ?? 'employee'}`}
                          checked={selected.has(p.id)}
                          disabled={busy || !canTick(p.id)}
                          onChange={() => toggle(p.id)}
                        />
                      </TableCell>
                    )}
                    <TableCell className="font-mono text-xs">{p.staff_ref ?? '—'}</TableCell>
                    <TableCell>{p.staff_name ?? '—'}</TableCell>
                    <TableCell className="text-right">{formatNet(p.net)}</TableCell>
                    <TableCell className={`text-xs font-semibold ${tone}`}>
                      {label}
                      {s === 'posted' && d?.posted_at ? (
                        <span className="ml-1 font-normal text-muted-foreground">
                          {new Date(d.posted_at).toLocaleDateString('en-GB')}
                        </span>
                      ) : null}
                      {s === 'failed' && d?.error_text ? (
                        <span className="block whitespace-pre-wrap font-normal">{d.error_text}</span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        {releasable && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || summary.owedCount === 0}
              onClick={selectAllUnpaid}
            >
              Select all unpaid
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || selected.size === 0}
              onClick={clearSelection}
            >
              Clear
            </Button>
            <span className="text-sm">
              <strong>{selected.size}</strong> selected ·{' '}
              <strong>{formatNet(selectedTotal)}</strong>
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || selected.size === 0}
              onClick={() => void doDryRun()}
            >
              {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Dry run
            </Button>
            <Button
              size="sm"
              disabled={busy || !dry || selected.size === 0}
              title={dry ? 'Release this batch' : 'Tick who to pay, then perform a dry run.'}
              onClick={() => {
                setTyped('');
                setConfirmOpen(true);
              }}
            >
              Release selected
            </Button>
          </div>
        )}

        {error && (
          <p role="alert" className="whitespace-pre-wrap text-xs font-medium text-destructive">
            {error}
          </p>
        )}

        {dry && (
          <div className="space-y-2">
            <p className="text-sm">
              Dry run: {dry.payslip_count} selected · total {formatNet(dry.total_net)}
            </p>
            <p className="text-xs text-muted-foreground">
              A dry run writes nothing. No wallet is credited and no ledger entry is posted.
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Staff ref</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Blocker</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dry.items.map((item, index) => (
                  <TableRow key={`${item.staff_ref ?? 'row'}-${index}`}>
                    <TableCell className="font-mono text-xs">{item.staff_ref ?? '—'}</TableCell>
                    <TableCell className="text-right">{formatNet(item.amount)}</TableCell>
                    <TableCell className="text-xs">
                      {item.blocker ? (
                        <span className="font-medium text-destructive">{item.blocker}</span>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {status === 'approved' && (
          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-xs text-muted-foreground">
              Retrying is safe. A posted payment is never paid again, and a failed payment can be
              ticked and released again.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy || readOnly || !allPaid || paidDone}
                title={
                  !allPaid
                    ? `${summary.owedCount} ${summary.owedCount === 1 ? 'person is' : 'people are'} still to be paid.`
                    : 'Record that this run has been paid in full.'
                }
                onClick={() => {
                  setPaidError(null);
                  setBusy(true);
                  void markRunPaid(runId, 'Payment released and recorded.')
                    .then(() => {
                      setPaidDone(true);
                      toast.success('Payment recorded.');
                      onPaid?.();
                    })
                    .catch((err) => setPaidError((err as Error).message))
                    .finally(() => setBusy(false));
                }}
              >
                Record payment
              </Button>
              {paidDone && <span className="text-xs text-muted-foreground">Recorded.</span>}
            </div>
            {paidError && (
              <p role="alert" className="whitespace-pre-wrap text-xs font-medium text-destructive">
                {paidError}
              </p>
            )}
          </div>
        )}

        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Release this batch</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <p className="text-sm">
                {dry?.payslip_count ?? 0} employees · {formatNet(dry?.total_net ?? 0)}
              </p>
              <p className="text-sm font-medium">
                This credits wallets and posts to the general ledger. There is no automatic
                reversal.
              </p>
              <div className="space-y-1">
                <Label htmlFor="release-confirm">Type RELEASE to confirm</Label>
                <Input
                  id="release-confirm"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                />
              </div>
            </div>
            <DialogFooter>
              <Button size="sm" disabled={busy || typed !== 'RELEASE'} onClick={() => void doRelease()}>
                {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                Confirm release
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

/** Whole-shilling display with thousands separators. */
function formatNet(value: number | null): string {
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

function firstOfNextMonth(): string {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const month = String(next.getMonth() + 1).padStart(2, '0');
  return `${next.getFullYear()}-${month}-01`;
}

const STATUS_CLASS: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  calculated: 'bg-blue-100 text-blue-700',
  in_review: 'bg-amber-100 text-amber-800',
  returned: 'bg-destructive/15 text-destructive',
  approved: 'bg-emerald-100 text-emerald-700',
  paid: 'bg-emerald-100 text-emerald-700',
  locked: 'bg-slate-700 text-slate-50',
  cancelled: 'bg-muted text-muted-foreground',
};

/** What the holding position must do next at each status. Empty when complete. */
const NEXT_ACTION: Record<string, string> = {
  draft: 'Calculate',
  calculated: 'Submit for approval',
  returned: 'Submit for approval',
  in_review: 'Approve or return',
  approved: 'Release payment',
  paid: 'Lock',
};

/**
 * Days since the last recorded event. Ageing colour is applied only to
 * in_review and approved — a draft sitting for a week is nobody's delay.
 */
function SinceCell({ at, status }: { at: string | null; status: string }) {
  if (!at) return <span className="text-xs text-muted-foreground">—</span>;
  const days = Math.floor((Date.now() - new Date(at).getTime()) / 86400000);
  const aged = status === 'in_review' || status === 'approved';
  const tone = !aged
    ? 'text-muted-foreground'
    : days > 7
      ? 'text-destructive font-semibold'
      : days > 3
        ? 'text-amber-600 font-semibold'
        : 'text-muted-foreground';
  return (
    <span className="text-xs">
      {formatDate(at)}{' '}
      <span className={tone}>
        ({days} {days === 1 ? 'day' : 'days'})
      </span>
    </span>
  );
}

function StatusCell({ status }: { status: string }) {
  const cls = STATUS_CLASS[status] ?? 'bg-muted text-muted-foreground';
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
      {status}
    </span>
  );
}

function CancelRunButton({ runId, status, onDone }: { runId: string; status: string; onDone: () => void }) {
  const authority = useRunAuthority();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canCancel = ['draft', 'calculated', 'in_review', 'returned'].includes(status);
  if (!canCancel) return null;

  const denied = !authority.preparer;
  const noteTooShort = note.trim().length < 10;

  const act = async () => {
    if (noteTooShort) return;
    setBusy(true);
    setError(null);
    try {
      await cancelRun(runId, note);
      toast.success('Run cancelled.');
      setOpen(false);
      setNote('');
      onDone();
    } catch (err) {
      setError((err as Error).message);
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        size="sm"
        variant="outline"
        disabled={busy || denied}
        title={
          denied
            ? 'Your position does not hold prepare authority for payroll runs.'
            : 'Cancel this run.'
        }
        onClick={() => setOpen(true)}
      >
        Cancel
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel run</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="cancel-note">Note</Label>
          <Textarea
            id="cancel-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={4}
            placeholder="Why this run is being cancelled. This is the audit record."
          />
          <p className="text-xs text-muted-foreground">
            At least 10 characters required.
          </p>
        </div>
        {error && (
          <p role="alert" className="text-xs font-medium text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            size="sm"
            disabled={busy || noteTooShort}
            onClick={() => void act()}
          >
            {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Confirm cancellation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ClosePeriodButton({ period, onDone }: { period: PayPeriodRow; onDone: () => void }) {
  const authority = useRunAuthority();
  const [busy, setBusy] = useState(false);

  if (period.status !== 'open') return null;

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy || !authority.preparer}
      title={
        !authority.preparer
          ? 'Your position does not hold prepare authority for payroll periods.'
          : 'Close this period.'
      }
      onClick={() => {
        setBusy(true);
        closePeriod(period.id)
          .then(() => {
            toast.success(`Period ${period.code} closed.`);
            onDone();
          })
          .catch((err) => {
            toast.error((err as Error).message);
          })
          .finally(() => setBusy(false));
      }}
    >
      {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
      Close
    </Button>
  );
}

function RuleStatusBadge({ value }: { value: string | null }) {
  if (value === 'provisional') {
    return (
      <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
        PROVISIONAL
      </span>
    );
  }
  if (value === 'verified') {
    return (
      <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
        Verified
      </span>
    );
  }
  return <span className="text-xs text-muted-foreground">—</span>;
}

function NewPeriodDialog({
  disabled,
  onCreated,
}: {
  disabled: boolean;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [periodMonth, setPeriodMonth] = useState(firstOfNextMonth());
  const [cutOffDate, setCutOffDate] = useState('');
  const [payDate, setPayDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!code.trim()) {
      setError('A period code is required.');
      return;
    }
    if (!periodMonth || !cutOffDate || !payDate) {
      setError('Month, cut-off date and pay date are all required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createPeriod({
        code: code.trim(),
        periodMonth,
        cutOffDate,
        payDate,
      });
      setOpen(false);
      setCode('');
      setPeriodMonth(firstOfNextMonth());
      setCutOffDate('');
      setPayDate('');
      onCreated();
      toast.success('Period created.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={disabled}>
          New period
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New pay period</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="period-code">Code</Label>
            <Input id="period-code" value={code} onChange={(e) => setCode(e.target.value)} />
            <p className="text-xs text-muted-foreground">For example 2026-08</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="period-month">Month</Label>
            <Input
              id="period-month"
              type="date"
              value={periodMonth}
              onChange={(e) => setPeriodMonth(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="period-cutoff">Cut-off date</Label>
            <Input
              id="period-cutoff"
              type="date"
              value={cutOffDate}
              onChange={(e) => setCutOffDate(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="period-pay">Pay date</Label>
            <Input
              id="period-pay"
              type="date"
              value={payDate}
              onChange={(e) => setPayDate(e.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="text-xs font-medium text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Save period
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewRunDialog({
  openPeriods,
  ruleVersions,
  onCreated,
}: {
  openPeriods: PayPeriodRow[];
  ruleVersions: PayRuleVersionOption[];
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [periodId, setPeriodId] = useState('');
  const [runType, setRunType] = useState('regular');
  const [ruleVersionId, setRuleVersionId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!periodId || !ruleVersionId) {
      setError('Choose a period and a rule version.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createRun({ periodId, runType, ruleVersionId, note: note.trim() });
      setOpen(false);
      setPeriodId('');
      setRunType('regular');
      setRuleVersionId('');
      setNote('');
      onCreated();
      toast.success('Run created.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">New run</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New pay run</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="run-period">Period</Label>
            <select
              id="run-period"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={periodId}
              onChange={(e) => {
                const next = e.target.value;
                setPeriodId(next);
                if (next && ruleVersionId) setError(null);
              }}
            >
              <option value="">Select a period</option>
              {openPeriods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="run-type">Run type</Label>
            <select
              id="run-type"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={runType}
              onChange={(e) => setRunType(e.target.value)}
            >
              <option value="regular">regular</option>
              <option value="adjustment">adjustment</option>
              <option value="off_cycle">off_cycle</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="run-rule">Rule version</Label>
            <select
              id="run-rule"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={ruleVersionId}
              onChange={(e) => {
                const next = e.target.value;
                setRuleVersionId(next);
                if (periodId && next) setError(null);
              }}
            >
              <option value="">Select a rule version</option>
              {ruleVersions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.verified_at ? v.code : `${v.code} — PROVISIONAL`}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="run-note">Note</Label>
            <Textarea
              id="run-note"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="text-xs font-medium text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Save run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function PayRuns() {
  const [periods, setPeriods] = useState<PayPeriodRow[]>([]);
  const [runs, setRuns] = useState<PayRunRow[]>([]);
  const [ruleVersions, setRuleVersions] = useState<PayRuleVersionOption[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, r, v] = await Promise.all([listPeriods(), listRuns(), listRuleVersions()]);
      setPeriods(p);
      setRuns(r);
      setRuleVersions(v);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openPeriods = useMemo(() => periods.filter((p) => p.status === 'open'), [periods]);
  const hasOpenPeriod = openPeriods.length > 0;

  return (
    <HRPlaceholderPage
      heading="Pay runs"
      subtitle="One open period at a time. Status changes are recorded as events, never written directly."
    >
      <Card>
        <CardHeader className="space-y-2">
          <CardTitle className="text-base">Periods</CardTitle>
          {hasOpenPeriod && (
            <p role="alert" className="text-xs font-medium text-amber-700">
              A period is already open. Close it before opening another.
            </p>
          )}
          <div>
            <NewPeriodDialog disabled={hasOpenPeriod} onCreated={() => void load()} />
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : periods.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No periods yet. Open the first one to begin payroll.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Month</TableHead>
                  <TableHead>Cut-off</TableHead>
                  <TableHead>Pay date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {periods.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.code}</TableCell>
                    <TableCell>{formatDate(p.period_month)}</TableCell>
                    <TableCell>{formatDate(p.cut_off_date)}</TableCell>
                    <TableCell>{formatDate(p.pay_date)}</TableCell>
                    <TableCell>{p.status}</TableCell>
                    <TableCell className="text-right">
                      <ClosePeriodButton period={p} onDone={() => void load()} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            A period stays open until you close it. Close July only after its run is locked.
          </p>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base">Runs</CardTitle>
          <NewRunDialog
            openPeriods={openPeriods}
            ruleVersions={ruleVersions}
            onCreated={() => void load()}
          />
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : runs.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No runs yet. Create one against the open period.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Rule version</TableHead>
                  <TableHead>Rule status</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>With</TableHead>
                  <TableHead>Since</TableHead>
                  <TableHead>Prepared at</TableHead>
                  <TableHead className="text-right">Net total</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link
                        to={`/hr/pay/runs/${r.id}`}
                        className="font-mono text-xs font-semibold text-primary underline-offset-2 hover:underline"
                      >
                        {r.id.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell>{r.period_code ?? '—'}</TableCell>
                    <TableCell>{r.run_type}</TableCell>
                    <TableCell>{r.rule_version_code ?? '—'}</TableCell>
                    <TableCell>
                      <RuleStatusBadge value={r.rule_status_at_run} />
                    </TableCell>
                    <TableCell>
                      <StatusCell status={r.status} />
                    </TableCell>
                    <TableCell>
                      <span className="text-xs font-medium">
                        {r.status === 'locked'
                          ? 'Complete'
                          : r.status === 'cancelled'
                            ? 'Cancelled'
                            : r.holding_position_title ?? '—'}
                      </span>
                      {NEXT_ACTION[r.status] && (
                        <span className="block text-[11px] text-muted-foreground">
                          {NEXT_ACTION[r.status]}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <SinceCell at={r.last_event_at} status={r.status} />
                    </TableCell>
                    <TableCell>{formatDate(r.prepared_at)}</TableCell>
                    <TableCell className="text-right">{formatNet(r.total_net)}</TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex items-center gap-2">
                        <CancelRunButton runId={r.id} status={r.status} onDone={() => void load()} />
                        <Button asChild size="sm" variant="outline">
                          <Link to={`/hr/pay/runs/${r.id}`}>Open run</Link>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Calculate, submit for approval, release and lock all happen inside a run. Open a run to
            act on it.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Provisional runs were computed against a rule set that has not been confirmed by a tax
            advisor. They are tracked for settlement once a verified version is loaded.
          </p>
        </CardContent>
      </Card>
    </HRPlaceholderPage>
  );
}

/**
 * URA / NSSF / LST filing schedules for an approved run. Read-only: this
 * section performs no writes of any kind.
 */
function StatutoryReturnsSection({
  runId,
  status,
  periodCode,
}: {
  runId: string;
  status: string;
  periodCode: string | null;
}) {
  const visible = ['approved', 'paid', 'locked'].includes(status);
  const [rows, setRows] = useState<StatutoryReturnRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [printKey, setPrintKey] = useState<string | null>(null);
  const [generatedAt] = useState(() => new Date());

  useEffect(() => {
    if (!visible || !runId) return;
    let alive = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const data = await getStatutoryReturn(runId);
        if (alive) setRows(data);
      } catch (err) {
        if (alive) setError((err as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [runId, visible]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          gross: acc.gross + Number(r.gross ?? 0),
          paye: acc.paye + Number(r.paye ?? 0),
          nssfEmployee: acc.nssfEmployee + Number(r.nssf_employee ?? 0),
          nssfEmployer: acc.nssfEmployer + Number(r.nssf_employer ?? 0),
          nssfTotal: acc.nssfTotal + Number(r.nssf_total ?? 0),
          lst: acc.lst + Number(r.lst ?? 0),
        }),
        { gross: 0, paye: 0, nssfEmployee: 0, nssfEmployer: 0, nssfTotal: 0, lst: 0 },
      ),
    [rows],
  );

  const missingRows = useMemo(
    () => rows.filter((r) => !!(r.missing ?? '').trim()),
    [rows],
  );

  const print = (key: string) => {
    setPrintKey(key);
    setTimeout(() => {
      window.print();
      setPrintKey(null);
    }, 50);
  };

  const DocHeader = ({ title }: { title: string }) => (
    <div>
      <p className="text-sm font-bold uppercase tracking-wide">Welile Technologies (U) Ltd</p>
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Period {periodCode ?? '—'} · Run <span className="font-mono">{runId.slice(0, 8)}</span>
      </p>
      <p className="text-xs text-muted-foreground">
        Generated {generatedAt.toLocaleString('en-GB')}
      </p>
    </div>
  );

  if (!visible) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Statutory returns</CardTitle>
        <p className="text-xs text-muted-foreground">
          For filing with URA and NSSF. Due by the 15th of the month following the pay date.
        </p>
      </CardHeader>
      <CardContent className="space-y-8">
        {printKey && (
          <style>{`@media print { [data-stat-doc] { display: none !important; } [data-stat-doc="${printKey}"] { display: block !important; } }`}</style>
        )}

        {loading && (
          <p className="text-sm text-muted-foreground">
            <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />
            Loading returns…
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm font-medium text-destructive">
            {error}
          </p>
        )}

        {!loading && !error && missingRows.length > 0 && (
          <div className="rounded-md border border-amber-500 bg-amber-50 p-3 text-xs text-amber-900">
            <p className="font-semibold">
              {missingRows.length} employees are missing a statutory identifier. Returns filed with
              blanks may be rejected.
            </p>
            <ul className="mt-1 space-y-0.5">
              {missingRows.map((r, i) => (
                <li key={`${r.staff_ref ?? 'row'}-${i}`}>
                  <span className="font-mono">{r.staff_ref ?? '—'}</span> — missing {r.missing}
                </li>
              ))}
            </ul>
          </div>
        )}

        {!loading && !error && (
          <>
            <section data-stat-doc="paye" className="space-y-2">
              <div className="flex items-start justify-between gap-3">
                <DocHeader title="PAYE return" />
                <Button
                  size="sm"
                  variant="outline"
                  className="no-print"
                  onClick={() => print('paye')}
                >
                  Print / Save as PDF
                </Button>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Staff ref</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>TIN</TableHead>
                    <TableHead className="text-right">Gross</TableHead>
                    <TableHead className="text-right">PAYE</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r, i) => (
                    <TableRow key={`paye-${r.staff_ref ?? i}-${i}`}>
                      <TableCell className="font-mono text-xs">{r.staff_ref ?? '—'}</TableCell>
                      <TableCell>{r.employee_name ?? '—'}</TableCell>
                      <TableCell className="font-mono text-xs">{r.tin ?? '—'}</TableCell>
                      <TableCell className="text-right">{formatNet(r.gross)}</TableCell>
                      <TableCell className="text-right">{formatNet(r.paye)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="font-semibold">
                    <TableCell colSpan={3}>Total ({rows.length} employees)</TableCell>
                    <TableCell className="text-right">{formatNet(totals.gross)}</TableCell>
                    <TableCell className="text-right">{formatNet(totals.paye)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </section>

            <section data-stat-doc="nssf" className="space-y-2">
              <div className="flex items-start justify-between gap-3">
                <DocHeader title="NSSF schedule" />
                <Button
                  size="sm"
                  variant="outline"
                  className="no-print"
                  onClick={() => print('nssf')}
                >
                  Print / Save as PDF
                </Button>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Staff ref</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>NSSF number</TableHead>
                    <TableHead className="text-right">Gross</TableHead>
                    <TableHead className="text-right">Employee 5%</TableHead>
                    <TableHead className="text-right">Employer 10%</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r, i) => (
                    <TableRow key={`nssf-${r.staff_ref ?? i}-${i}`}>
                      <TableCell className="font-mono text-xs">{r.staff_ref ?? '—'}</TableCell>
                      <TableCell>{r.employee_name ?? '—'}</TableCell>
                      <TableCell className="font-mono text-xs">{r.nssf_number ?? '—'}</TableCell>
                      <TableCell className="text-right">{formatNet(r.gross)}</TableCell>
                      <TableCell className="text-right">{formatNet(r.nssf_employee)}</TableCell>
                      <TableCell className="text-right">{formatNet(r.nssf_employer)}</TableCell>
                      <TableCell className="text-right font-semibold">
                        {formatNet(r.nssf_total)}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="font-semibold">
                    <TableCell colSpan={3}>Total ({rows.length} employees)</TableCell>
                    <TableCell className="text-right">{formatNet(totals.gross)}</TableCell>
                    <TableCell className="text-right">{formatNet(totals.nssfEmployee)}</TableCell>
                    <TableCell className="text-right">{formatNet(totals.nssfEmployer)}</TableCell>
                    <TableCell className="text-right">{formatNet(totals.nssfTotal)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </section>

            <section data-stat-doc="lst" className="space-y-2">
              <div className="flex items-start justify-between gap-3">
                <DocHeader title="LST schedule" />
                <Button size="sm" variant="outline" className="no-print" onClick={() => print('lst')}>
                  Print / Save as PDF
                </Button>
              </div>
              {totals.lst === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No LST computed. The district schedule has not been loaded — see
                  PAYROLL_RULES_UG.md.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Staff ref</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>District</TableHead>
                      <TableHead className="text-right">LST</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r, i) => (
                      <TableRow key={`lst-${r.staff_ref ?? i}-${i}`}>
                        <TableCell className="font-mono text-xs">{r.staff_ref ?? '—'}</TableCell>
                        <TableCell>{r.employee_name ?? '—'}</TableCell>
                        <TableCell>{r.lst_district ?? '—'}</TableCell>
                        <TableCell className="text-right">{formatNet(r.lst)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="font-semibold">
                      <TableCell colSpan={3}>Total ({rows.length} employees)</TableCell>
                      <TableCell className="text-right">{formatNet(totals.lst)}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              )}
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Run detail: summary, calculation, payslips and the event timeline. */
export function PayRunDetailPlaceholder() {
  const { runId } = useParams<{ runId: string }>();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [calcError, setCalcError] = useState<string | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [exceptions, setExceptions] = useState<RunException[]>([]);
  const [exceptionsError, setExceptionsError] = useState<string | null>(null);
  const [exceptionsLoading, setExceptionsLoading] = useState(false);

  const load = useCallback(async () => {
    if (!runId) return;
    setLoading(true);
    setLoadError(null);
    try {
      setDetail(await getRunDetail(runId));
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  const hasPayslips = (detail?.payslips.length ?? 0) > 0;

  useEffect(() => {
    if (!runId || !hasPayslips) {
      setExceptions([]);
      return;
    }
    let alive = true;
    setExceptionsLoading(true);
    setExceptionsError(null);
    void (async () => {
      try {
        const rows = await listExceptions(runId);
        if (alive) setExceptions(rows);
      } catch (err) {
        if (alive) setExceptionsError((err as Error).message);
      } finally {
        if (alive) setExceptionsLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [runId, hasPayslips]);

  const exceptionGroups = useMemo(() => {
    const pick = (severity: string) =>
      exceptions.filter((e) => (e.severity ?? '').toUpperCase() === severity);
    return { BLOCK: pick('BLOCK'), REVIEW: pick('REVIEW'), INFO: pick('INFO') };
  }, [exceptions]);

  const blockingCount = exceptionGroups.BLOCK.length;

  const canCalculate =
    !!detail &&
    detail.run_type !== 'off_cycle' &&
    ['draft', 'calculated', 'returned'].includes(detail.status) &&
    !calculating;

  const runCalculation = async () => {
    if (!runId) return;
    setCalculating(true);
    setCalcError(null);
    try {
      const res = await calculateRun(runId);
      toast.success(res.message);
      await load();
    } catch (err) {
      setCalcError((err as Error).message);
    } finally {
      setCalculating(false);
    }
  };

  const totals = useMemo(() => {
    const rows = detail?.payslips ?? [];
    return rows.reduce(
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
  }, [detail]);

  const provisional = detail?.rule_status_at_run === 'provisional';

  return (
    <HRPlaceholderPage
      heading="Payroll run"
      subtitle={
        detail
          ? `${detail.period_code ?? 'Period'} · ${detail.id.slice(0, 8)} · ${detail.run_type}`
          : (runId ?? '').slice(0, 8)
      }
    >
      {loading && (
        <p className="text-sm text-muted-foreground">
          <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />
          Loading run…
        </p>
      )}
      {loadError && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {loadError}
        </p>
      )}

      {detail && (
        <>
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
              <div className="space-y-1">
                <CardTitle className="text-base">
                  {detail.period_code ?? 'Period'} · {detail.id.slice(0, 8)} · {detail.run_type}
                </CardTitle>
                <div className="flex items-center gap-2">
                  <StatusCell status={detail.status} />
                  <RuleStatusBadge value={detail.rule_status_at_run} />
                </div>
                {provisional && (
                  <p className="text-xs text-muted-foreground">
                    Computed against a rule set that has not been confirmed by a tax advisor.
                    Tracked for settlement once a verified version is loaded.
                  </p>
                )}
              </div>
              <div className="text-right">
                <Button
                  size="sm"
                  onClick={runCalculation}
                  disabled={!canCalculate}
                  title={
                    detail.run_type === 'off_cycle'
                      ? 'An off-cycle run is calculated from its arrears entries, in the Arrears section below.'
                      : 'Calculate this run.'
                  }
                >
                  {calculating && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                  {calculating ? 'Calculating…' : 'Calculate'}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {calcError && (
                <p role="alert" className="mb-3 text-xs font-medium text-destructive">
                  {calcError}
                </p>
              )}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <p className="text-[11px] uppercase text-muted-foreground">Employees</p>
                  <p className="text-lg font-semibold">{detail.payslips.length}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase text-muted-foreground">Total gross</p>
                  <p className="text-lg font-semibold">{formatNet(detail.total_gross)}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase text-muted-foreground">Total net</p>
                  <p className="text-lg font-semibold">{formatNet(detail.total_net)}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase text-muted-foreground">
                    Total employer cost
                  </p>
                  <p className="text-lg font-semibold">
                    {formatNet(detail.total_employer_cost)}
                  </p>
                </div>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Cut-off {formatDate(detail.cut_off_date)} · Pay date {formatDate(detail.pay_date)}
                {detail.rule_version_code ? ` · Rule ${detail.rule_version_code}` : ''}
              </p>
              <RunActionBar
                runId={detail.id}
                status={detail.status}
                onDone={() => void load()}
                blockingCount={blockingCount}
              />
            </CardContent>
          </Card>

          <ArrearsPanel
            runId={detail.id}
            runType={detail.run_type}
            status={detail.status}
            onDone={() => void load()}
          />

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Payslips</CardTitle>
            </CardHeader>
            <CardContent>
              {detail.payslips.length === 0 ? (
                <p className="text-sm text-muted-foreground">Not calculated yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Staff reference</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead className="text-right">Gross</TableHead>
                      <TableHead className="text-right">PAYE</TableHead>
                      <TableHead className="text-right">NSSF employee</TableHead>
                      <TableHead className="text-right">LST</TableHead>
                      <TableHead className="text-right">Other deductions</TableHead>
                      <TableHead className="text-right">Net</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.payslips.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-mono text-xs">
                          <Link className="underline" to={`/hr/pay/payslips/${p.id}`}>
                            {p.staff_ref ?? '—'}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Link className="underline" to={`/hr/pay/payslips/${p.id}`}>
                            {p.staff_name ?? '—'}
                          </Link>
                        </TableCell>
                        <TableCell className="text-right">{formatNet(p.gross)}</TableCell>
                        <TableCell className="text-right">{formatNet(p.paye)}</TableCell>
                        <TableCell className="text-right">
                          {formatNet(p.nssf_employee)}
                        </TableCell>
                        <TableCell className="text-right">{formatNet(p.lst)}</TableCell>
                        <TableCell className="text-right">
                          {formatNet(p.other_deductions)}
                        </TableCell>
                        <TableCell className="text-right font-semibold">
                          {formatNet(p.net)}
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="font-semibold">
                      <TableCell>Total</TableCell>
                      <TableCell>{detail.payslips.length} employees</TableCell>
                      <TableCell className="text-right">{formatNet(totals.gross)}</TableCell>
                      <TableCell className="text-right">{formatNet(totals.paye)}</TableCell>
                      <TableCell className="text-right">{formatNet(totals.nssf)}</TableCell>
                      <TableCell className="text-right">{formatNet(totals.lst)}</TableCell>
                      <TableCell className="text-right">{formatNet(totals.other)}</TableCell>
                      <TableCell className="text-right">{formatNet(totals.net)}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {hasPayslips && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Pre-run exceptions</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Checks that run before money moves.
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                {exceptionsLoading && (
                  <p className="text-sm text-muted-foreground">
                    <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />
                    Running checks…
                  </p>
                )}
                {exceptionsError && (
                  <p role="alert" className="text-sm font-medium text-destructive">
                    {exceptionsError}
                  </p>
                )}
                {!exceptionsLoading && !exceptionsError && (
                  <>
                    <p className="text-sm font-medium">
                      {blockingCount} blocking, {exceptionGroups.REVIEW.length} to review,{' '}
                      {exceptionGroups.INFO.length} informational.
                    </p>
                    {exceptions.length === 0 ? (
                      <p className="text-sm font-medium text-green-700">
                        No exceptions. Every payslip passed the pre-run checks.
                      </p>
                    ) : (
                      (['BLOCK', 'REVIEW', 'INFO'] as const).map((severity) => {
                        const rows = exceptionGroups[severity];
                        if (rows.length === 0) return null;
                        const tone =
                          severity === 'BLOCK'
                            ? 'text-destructive'
                            : severity === 'REVIEW'
                              ? 'text-amber-600'
                              : 'text-muted-foreground';
                        return (
                          <div key={severity} className="space-y-1">
                            <p className={`text-xs font-semibold uppercase ${tone}`}>
                              {severity} · {rows.length}
                            </p>
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Staff ref</TableHead>
                                  <TableHead>Issue</TableHead>
                                  <TableHead>Detail</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {rows.map((e, i) => (
                                  <TableRow key={`${severity}-${i}`} className={tone}>
                                    <TableCell className="font-mono text-xs">
                                      {e.staff_ref ?? '—'}
                                    </TableCell>
                                    <TableCell>{e.issue}</TableCell>
                                    <TableCell className="text-xs">{e.detail ?? '—'}</TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        );
                      })
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          )}

          <PayrollRegister runId={detail.id} />

          <StatutoryReturnsSection
            runId={detail.id}
            status={detail.status}
            periodCode={detail.period_code ?? null}
          />

          <ReleaseSection
            runId={detail.id}
            status={detail.status}
            payslips={detail.payslips}
            onPaid={() => void load()}
          />

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Event timeline</CardTitle>
            </CardHeader>
            <CardContent>
              {detail.events.length === 0 ? (
                <p className="text-sm text-muted-foreground">No events recorded.</p>
              ) : (
                <ol className="space-y-3">
                  {detail.events.map((e) => (
                    <li key={e.id} className="border-l-2 border-border pl-3">
                      <p className="text-sm font-semibold">{e.event_type}</p>
                      <p className="text-xs text-muted-foreground">
                        {e.actor_name ?? 'System'}
                        {e.actor_position_title ? ` · ${e.actor_position_title}` : ''} ·{' '}
                        {new Date(e.created_at).toLocaleString('en-GB')}
                      </p>
                      {e.note && <p className="mt-1 text-xs">{e.note}</p>}
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </HRPlaceholderPage>
  );
}